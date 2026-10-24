import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../lib/env';
import { requireAdmin, type AdminVars } from '../lib/access';
import { ApiError, clientIp, readJson } from '../lib/http';
import { audit, auditStmt } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import {
  newVariantSchema,
  parse,
  productUpsertSchema,
  pushSubscriptionSchema,
  statusUpdateSchema,
  variantUpdateSchema,
} from '../lib/validation';
import { orderLabel } from '../lib/money';
import { refundPayment } from '../lib/razorpay';
import { isAllowedPushEndpoint, pushToAdmins } from '../lib/webpush';

type AdminEnv = { Bindings: Env; Variables: AdminVars };
export const adminApi = new Hono<AdminEnv>();
adminApi.use('*', requireAdmin);

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const UUID = /^[0-9a-f-]{36}$/;

adminApi.get('/me', (c) =>
  c.json({
    email: c.get('adminEmail'),
    vapidPublicKey: c.env.VAPID_PUBLIC_KEY && !/REPLACE/.test(c.env.VAPID_PUBLIC_KEY) ? c.env.VAPID_PUBLIC_KEY : null,
    alertEmail: c.env.ALERT_EMAIL_TO || null,
  }),
);

// ---------------------------------------------------------------- orders
const FILTERS: Record<string, string> = {
  all: '1=1',
  new: 'n.read_at IS NULL AND n.id IS NOT NULL',
  cod: "o.status = 'cod_pending'",
  pack: "o.status IN ('paid','confirmed')",
  packed: "o.status = 'packed'",
  shipped: "o.status = 'shipped'",
  attention: 'o.needs_attention IS NOT NULL',
  closed: "o.status IN ('delivered','cancelled','refunded','expired','failed')",
};

adminApi.get('/orders', async (c) => {
  const filter = c.req.query('filter') ?? 'all';
  const where = FILTERS[filter] ?? FILTERS.all;
  const qRaw = (c.req.query('q') ?? '').trim().slice(0, 40);
  const params: (string | number)[] = [];
  let search = '';
  if (qRaw) {
    const num = /^(?:VK-?)?(\d{3,7})$/i.exec(qRaw);
    if (num) {
      search = ' AND o.number = ?1';
      params.push(Number(num[1]));
    } else {
      search = " AND (o.contact_name LIKE ?1 ESCAPE '\\' OR c.name LIKE ?1 ESCAPE '\\' OR c.phone LIKE ?1 ESCAPE '\\')";
      params.push(`%${qRaw.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
    }
  }
  // Hide abandoned online checkouts from the default view: they were never orders.
  const hideAbandoned = filter === 'all' ? " AND o.status NOT IN ('created','expired','failed')" : '';
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.number, o.status, o.payment_method, o.total_paise, o.created_at, o.needs_attention, o.tracking_number,
            COALESCE(o.contact_name, c.name) AS customer_name,
            (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id) AS item_count,
            (SELECT method FROM payments WHERE order_id = o.id ORDER BY id DESC LIMIT 1) AS pay_method,
            n.id AS notification_id, n.read_at, n.read_by
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN notifications n ON n.order_id = o.id AND n.type = 'new_order'
      WHERE ${where}${hideAbandoned}${search}
      ORDER BY o.created_at DESC LIMIT 200`,
  )
    .bind(...params)
    .all();
  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM notifications WHERE read_at IS NULL) AS new_count,
       (SELECT COUNT(*) FROM orders WHERE status = 'cod_pending') AS cod_count,
       (SELECT COUNT(*) FROM orders WHERE status IN ('paid','confirmed')) AS pack_count,
       (SELECT COUNT(*) FROM orders WHERE status = 'packed') AS packed_count,
       (SELECT COUNT(*) FROM orders WHERE status = 'shipped') AS shipped_count,
       (SELECT COUNT(*) FROM orders WHERE needs_attention IS NOT NULL AND status NOT IN ('refunded','cancelled')) AS attention_count`,
  ).first();
  return c.json({ orders: results.map((o) => ({ ...o, label: orderLabel(o.number as number) })), counts });
});

adminApi.get('/orders/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Order not found.');
  const o = await c.env.DB.prepare(
    `SELECT o.*, COALESCE(o.contact_name, c.name) AS customer_name, c.phone AS customer_phone, COALESCE(o.contact_email, c.email) AS customer_email,
            a.line1, a.line2, a.city, a.state, a.pincode
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN addresses a ON a.id = o.address_id WHERE o.id = ?1`,
  )
    .bind(id)
    .first<Record<string, unknown> & { number: number }>();
  if (!o) throw new ApiError(404, 'not_found', 'Order not found.');
  const db = c.env.DB;
  const [items, payments, history] = await Promise.all([
    db.prepare('SELECT variant_id, product_name, variant_label, qty, unit_price_paise FROM order_items WHERE order_id = ?1').bind(id).all(),
    db.prepare('SELECT razorpay_payment_id, status, amount_paise, method, source, created_at FROM payments WHERE order_id = ?1 ORDER BY id').bind(id).all(),
    db.prepare("SELECT admin_email, action, details, created_at FROM audit_log WHERE entity = 'order' AND entity_id = ?1 ORDER BY id DESC LIMIT 50").bind(id).all(),
  ]);
  delete o.client_ip;
  return c.json({ ...o, label: orderLabel(o.number), items: items.results, payments: payments.results, history: history.results });
});

const TRANSITIONS: Record<string, string[]> = {
  cod_pending: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  paid: ['packed'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
};

adminApi.patch('/orders/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Order not found.');
  const body = parse(statusUpdateSchema, await readJson(c));
  const admin = c.get('adminEmail');
  const db = c.env.DB;
  const o = await db.prepare('SELECT status, payment_method FROM orders WHERE id = ?1').bind(id).first<{ status: string; payment_method: string }>();
  if (!o) throw new ApiError(404, 'not_found', 'Order not found.');
  if (!(TRANSITIONS[o.status] ?? []).includes(body.status)) {
    throw new ApiError(409, 'invalid_transition', `An order that is "${o.status}" cannot be marked "${body.status}".`);
  }
  if (body.status === 'cancelled' && o.payment_method !== 'cod') {
    throw new ApiError(409, 'refund_required', 'Online-paid orders are cancelled by issuing a refund.');
  }
  if (body.status === 'shipped' && !body.trackingNumber) {
    throw new ApiError(400, 'tracking_required', 'Add the courier tracking number before marking as shipped.');
  }
  const stmts: D1PreparedStatement[] = [];
  if (body.status === 'cancelled') {
    // COD stock was taken at order time; put it back.
    stmts.push(
      db
        .prepare(
          `UPDATE product_variants
              SET stock = stock + (SELECT qty FROM order_items oi WHERE oi.order_id = ?1 AND oi.variant_id = product_variants.id)
            WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?1)
              AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = ?2)`,
        )
        .bind(id, o.status),
    );
  }
  stmts.push(
    db
      .prepare(`UPDATE orders SET status = ?2, tracking_number = COALESCE(?3, tracking_number), handled_by = ?4, updated_at = ${NOW} WHERE id = ?1 AND status = ?5`)
      .bind(id, body.status, body.trackingNumber || null, admin, o.status),
    db.prepare(`UPDATE notifications SET read_at = ${NOW}, read_by = ?2 WHERE order_id = ?1 AND read_at IS NULL`).bind(id, admin),
    auditStmt(db, admin, `order.${body.status}`, 'order', id, { from: o.status, tracking: body.trackingNumber ?? null }, clientIp(c)),
  );
  const res = await db.batch(stmts);
  const changed = res[body.status === 'cancelled' ? 1 : 0]?.meta.changes ?? 0;
  if (!changed) throw new ApiError(409, 'conflict', 'The order changed meanwhile. Refresh and try again.');
  return c.json({ ok: true, status: body.status });
});

adminApi.post('/orders/:id/refund', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Order not found.');
  const admin = c.get('adminEmail');
  await rateLimit(c.env.DB, `refund:${admin}`, 20, 3600);
  const db = c.env.DB;
  const o = await db
    .prepare(
      `SELECT o.status, o.number, o.total_paise, p.razorpay_payment_id
         FROM orders o JOIN payments p ON p.order_id = o.id AND p.status = 'captured'
        WHERE o.id = ?1 AND o.payment_method = 'razorpay' ORDER BY p.id DESC LIMIT 1`,
    )
    .bind(id)
    .first<{ status: string; number: number; total_paise: number; razorpay_payment_id: string }>();
  if (!o) throw new ApiError(404, 'not_found', 'No captured online payment found for this order.');
  if (!['paid', 'packed', 'shipped', 'delivered'].includes(o.status)) {
    throw new ApiError(409, 'invalid_transition', `An order that is "${o.status}" cannot be refunded.`);
  }
  // Claim the order first so a double-click can't refund twice.
  const claim = await db
    .prepare(`UPDATE orders SET status = 'refunded', handled_by = ?2, updated_at = ${NOW} WHERE id = ?1 AND status = ?3`)
    .bind(id, admin, o.status)
    .run();
  if (!claim.meta.changes) throw new ApiError(409, 'conflict', 'The order changed meanwhile. Refresh and try again.');
  let refund: { id: string; status: string };
  try {
    refund = await refundPayment(c.env, o.razorpay_payment_id, o.total_paise, `${orderLabel(o.number)}-refund`);
  } catch (err) {
    await db.prepare(`UPDATE orders SET status = ?2, updated_at = ${NOW} WHERE id = ?1 AND status = 'refunded'`).bind(id, o.status).run();
    console.error('Refund failed', err instanceof Error ? err.message : err);
    throw new ApiError(502, 'refund_failed', 'Razorpay refused the refund. Check the Razorpay dashboard.');
  }
  const stmts = [auditStmt(db, admin, 'order.refunded', 'order', id, { amount: o.total_paise, refund: refund.id, from: o.status }, clientIp(c))];
  stmts.push(db.prepare(`UPDATE notifications SET read_at = ${NOW}, read_by = ?2 WHERE order_id = ?1 AND read_at IS NULL`).bind(id, admin));
  if (o.status === 'paid' || o.status === 'packed') {
    stmts.push(
      db
        .prepare(
          `UPDATE product_variants
              SET stock = stock + (SELECT qty FROM order_items oi WHERE oi.order_id = ?1 AND oi.variant_id = product_variants.id)
            WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?1)`,
        )
        .bind(id),
    );
  }
  await db.batch(stmts);
  return c.json({ ok: true, status: 'refunded', refundId: refund.id });
});

// ---------------------------------------------------------------- alerts
adminApi.get('/notifications', async (c) => {
  const since = Number.parseInt(c.req.query('since') ?? '0', 10) || 0;
  const unreadOnly = c.req.query('unread') === '1';
  const { results } = await c.env.DB.prepare(
    `SELECT id, order_id, title, body, created_at, read_at, read_by FROM notifications
      WHERE id > ?1 ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 30`,
  )
    .bind(since)
    .all<{ id: number }>();
  const unread = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL').first<{ n: number }>();
  const latest = await c.env.DB.prepare('SELECT COALESCE(MAX(id),0) AS id FROM notifications').first<{ id: number }>();
  return c.json({ unread: unread?.n ?? 0, latestId: latest?.id ?? 0, items: results });
});

adminApi.post('/notifications/read', async (c) => {
  const body = parse(z.object({ ids: z.array(z.number().int().positive()).max(100).optional(), all: z.boolean().optional() }), await readJson(c));
  const admin = c.get('adminEmail');
  if (body.all) {
    await c.env.DB.prepare(`UPDATE notifications SET read_at = ${NOW}, read_by = ?1 WHERE read_at IS NULL`).bind(admin).run();
  } else if (body.ids?.length) {
    const ph = body.ids.map((_, i) => `?${i + 2}`).join(',');
    await c.env.DB.prepare(`UPDATE notifications SET read_at = ${NOW}, read_by = ?1 WHERE read_at IS NULL AND id IN (${ph})`)
      .bind(admin, ...body.ids)
      .run();
  }
  return c.json({ ok: true });
});

adminApi.post('/push-subscriptions', async (c) => {
  const body = parse(pushSubscriptionSchema, await readJson(c));
  if (!isAllowedPushEndpoint(body.endpoint)) throw new ApiError(400, 'invalid_endpoint', 'Unsupported push service.');
  const admin = c.get('adminEmail');
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE admin_email = ?1').bind(admin).first<{ n: number }>();
  if ((count?.n ?? 0) >= 10) throw new ApiError(409, 'too_many_devices', 'Alerts are already on for 10 devices. Turn one off first.');
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (admin_email, endpoint, user_agent) VALUES (?1, ?2, ?3)
     ON CONFLICT (endpoint) DO UPDATE SET admin_email = excluded.admin_email, failures = 0`,
  )
    .bind(admin, body.endpoint, (c.req.header('User-Agent') ?? '').slice(0, 200))
    .run();
  await audit(c.env.DB, admin, 'push.subscribe', 'push', new URL(body.endpoint).hostname, {}, clientIp(c));
  return c.json({ ok: true });
});

adminApi.delete('/push-subscriptions', async (c) => {
  const body = parse(z.object({ endpoint: z.string().url().max(1024) }), await readJson(c));
  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(body.endpoint).run();
  return c.json({ ok: true });
});

adminApi.get('/push-subscriptions', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT admin_email, user_agent, created_at, last_success_at, failures FROM push_subscriptions ORDER BY id').all();
  return c.json({ devices: results });
});

adminApi.post('/push/test', async (c) => {
  await rateLimit(c.env.DB, `pushtest:${c.get('adminEmail')}`, 10, 600);
  const r = await pushToAdmins(c.env);
  return c.json(r);
});

// ---------------------------------------------------------------- catalogue
adminApi.get('/catalog', async (c) => {
  const db = c.env.DB;
  const [products, variants, images, brands, categories, publish] = await Promise.all([
    db.prepare('SELECT * FROM products ORDER BY id').all(),
    db.prepare('SELECT id, product_id, colour, colour_hex, size, sku, price_paise, mrp_paise, stock, reserved, is_active FROM product_variants ORDER BY product_id, sort_order').all(),
    db.prepare('SELECT id, product_id, colour, src, alt, sort_order FROM product_images ORDER BY product_id, sort_order').all(),
    db.prepare('SELECT id, name FROM brands ORDER BY id').all(),
    db.prepare('SELECT id, name FROM categories ORDER BY sort_order').all(),
    db.prepare("SELECT value, updated_at FROM settings WHERE key = 'last_publish'").first(),
  ]);
  return c.json({
    products: products.results,
    variants: variants.results,
    images: images.results,
    brands: brands.results,
    categories: categories.results,
    lastPublish: publish,
    mediaBase: c.env.MEDIA_BASE_URL,
  });
});

adminApi.patch('/variants/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, 'not_found', 'Variant not found.');
  const body = parse(variantUpdateSchema, await readJson(c));
  const db = c.env.DB;
  const v = await db.prepare('SELECT price_paise, mrp_paise, stock, reserved, is_active FROM product_variants WHERE id = ?1').bind(id).first<{
    price_paise: number;
    mrp_paise: number | null;
    stock: number;
    reserved: number;
    is_active: number;
  }>();
  if (!v) throw new ApiError(404, 'not_found', 'Variant not found.');
  const next = {
    price: body.pricePaise ?? v.price_paise,
    mrp: body.mrpPaise === undefined ? v.mrp_paise : body.mrpPaise,
    stock: body.stock ?? v.stock,
    active: body.isActive === undefined ? v.is_active : body.isActive ? 1 : 0,
  };
  if (next.stock < v.reserved) throw new ApiError(409, 'stock_reserved', `${v.reserved} are held in customers' checkouts. Stock can't go below that.`);
  if (next.mrp !== null && next.mrp < next.price) throw new ApiError(400, 'invalid_mrp', 'MRP must be at least the selling price.');
  await db.batch([
    db.prepare('UPDATE product_variants SET price_paise = ?2, mrp_paise = ?3, stock = ?4, is_active = ?5 WHERE id = ?1').bind(id, next.price, next.mrp, next.stock, next.active),
    auditStmt(db, c.get('adminEmail'), 'variant.update', 'variant', id, { before: v, after: next }, clientIp(c)),
  ]);
  return c.json({ ok: true });
});

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

adminApi.post('/products', async (c) => {
  const body = parse(productUpsertSchema, await readJson(c));
  const db = c.env.DB;
  let slug = slugify(body.name);
  const clash = await db.prepare('SELECT 1 FROM products WHERE slug = ?1').bind(slug).first();
  if (clash) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  const r = await db
    .prepare(
      `INSERT INTO products (brand_id, category_id, name, slug, description, fabric, gsm, care, is_active, is_new)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id`,
    )
    .bind(body.brandId, body.categoryId, body.name, slug, body.description, body.fabric, body.gsm, body.care, body.isActive ? 1 : 0, body.isNew ? 1 : 0)
    .first<{ id: number }>();
  await audit(db, c.get('adminEmail'), 'product.create', 'product', r?.id ?? 0, { name: body.name }, clientIp(c));
  return c.json({ ok: true, id: r?.id, slug });
});

adminApi.patch('/products/:id', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, 'not_found', 'Product not found.');
  const body = parse(productUpsertSchema, await readJson(c));
  const db = c.env.DB;
  const r = await db
    .prepare(
      `UPDATE products SET brand_id = ?2, category_id = ?3, name = ?4, description = ?5, fabric = ?6, gsm = ?7, care = ?8,
              is_active = ?9, is_new = ?10, updated_at = ${NOW} WHERE id = ?1`,
    )
    .bind(id, body.brandId, body.categoryId, body.name, body.description, body.fabric, body.gsm, body.care, body.isActive ? 1 : 0, body.isNew ? 1 : 0)
    .run();
  if (!r.meta.changes) throw new ApiError(404, 'not_found', 'Product not found.');
  await audit(db, c.get('adminEmail'), 'product.update', 'product', id, { name: body.name, active: body.isActive }, clientIp(c));
  return c.json({ ok: true });
});

adminApi.post('/products/:id/variants', async (c) => {
  const productId = Number(c.req.param('id'));
  const body = parse(newVariantSchema, await readJson(c));
  if (body.mrpPaise !== null && body.mrpPaise < body.pricePaise) throw new ApiError(400, 'invalid_mrp', 'MRP must be at least the selling price.');
  const db = c.env.DB;
  const p = await db.prepare('SELECT id FROM products WHERE id = ?1').bind(productId).first();
  if (!p) throw new ApiError(404, 'not_found', 'Product not found.');
  const sku = `VK${String(productId).padStart(3, '0')}-${body.colour.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase()}-${body.size.replace(/[^A-Za-z0-9]/g, '')}`;
  try {
    await db
      .prepare(
        `INSERT INTO product_variants (product_id, colour, colour_hex, size, sku, price_paise, mrp_paise, stock, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT COALESCE(MAX(sort_order),0)+1 FROM product_variants WHERE product_id = ?1))`,
      )
      .bind(productId, body.colour, body.colourHex, body.size, sku, body.pricePaise, body.mrpPaise, body.stock)
      .run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) throw new ApiError(409, 'duplicate', 'That colour and size already exists.');
    throw err;
  }
  await audit(db, c.get('adminEmail'), 'variant.create', 'product', productId, { colour: body.colour, size: body.size }, clientIp(c));
  return c.json({ ok: true });
});

/** Image upload: admin only, JPEG/PNG/WebP checked by file signature, max 5 MB. */
adminApi.post('/products/:id/images', async (c) => {
  const productId = Number(c.req.param('id'));
  const admin = c.get('adminEmail');
  await rateLimit(c.env.DB, `upload:${admin}`, 60, 3600);
  const p = await c.env.DB.prepare('SELECT name FROM products WHERE id = ?1').bind(productId).first<{ name: string }>();
  if (!p) throw new ApiError(404, 'not_found', 'Product not found.');
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (len > 6 * 1024 * 1024) throw new ApiError(413, 'too_large', 'Image must be 5 MB or smaller.');
  const form = await c.req.formData();
  const file = form.get('file');
  const colour = String(form.get('colour') ?? '').slice(0, 40) || null;
  if (!(file instanceof File)) throw new ApiError(400, 'no_file', 'Choose an image to upload.');
  if (file.size > 5 * 1024 * 1024) throw new ApiError(413, 'too_large', 'Image must be 5 MB or smaller.');
  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(buf);
  if (!kind) throw new ApiError(415, 'bad_type', 'Only JPG, PNG or WebP images are allowed.');
  const key = `products/${productId}/${crypto.randomUUID()}.${kind.ext}`;
  await c.env.MEDIA.put(key, buf, { httpMetadata: { contentType: kind.mime, cacheControl: 'public, max-age=31536000, immutable' } });
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO product_images (product_id, colour, src, alt, sort_order)
       VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(sort_order),0)+1 FROM product_images WHERE product_id = ?1))`,
    ).bind(productId, colour, `r2:${key}`, `${p.name}${colour ? ' in ' + colour : ''}`),
    auditStmt(c.env.DB, admin, 'image.upload', 'product', productId, { key, bytes: buf.length }, clientIp(c)),
  ]);
  return c.json({ ok: true, key });
});

adminApi.delete('/images/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const img = await c.env.DB.prepare('SELECT product_id, src FROM product_images WHERE id = ?1').bind(id).first<{ product_id: number; src: string }>();
  if (!img) throw new ApiError(404, 'not_found', 'Image not found.');
  await c.env.DB.prepare('DELETE FROM product_images WHERE id = ?1').bind(id).run();
  if (img.src.startsWith('r2:')) await c.env.MEDIA.delete(img.src.slice(3));
  await audit(c.env.DB, c.get('adminEmail'), 'image.delete', 'product', img.product_id, { src: img.src }, clientIp(c));
  return c.json({ ok: true });
});

export function sniffImage(b: Uint8Array): { ext: string; mime: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a)
    return { ext: 'png', mime: 'image/png' };
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP')
    return { ext: 'webp', mime: 'image/webp' };
  return null;
}

/** Rebuild the static storefront (new products, names, photos) via GitHub Actions. */
adminApi.post('/publish', async (c) => {
  const admin = c.get('adminEmail');
  await rateLimit(c.env.DB, 'publish', 12, 3600);
  if (!c.env.GITHUB_REPO || !c.env.GITHUB_DISPATCH_TOKEN) {
    throw new ApiError(501, 'not_configured', 'Publishing is not set up yet (GITHUB_REPO / GITHUB_DISPATCH_TOKEN). Ask the developer.');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(c.env.GITHUB_REPO)) throw new ApiError(500, 'bad_config', 'Invalid GITHUB_REPO.');
  const res = await fetch(`https://api.github.com/repos/${c.env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c.env.GITHUB_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'veeess-knits-admin',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: 'publish-storefront', client_payload: { by: admin } }),
  });
  if (!res.ok) throw new ApiError(502, 'publish_failed', `GitHub refused the publish request (${res.status}).`);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('last_publish', ?1, ${NOW}) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = ${NOW}`).bind(admin),
    auditStmt(c.env.DB, admin, 'storefront.publish', 'site', 'storefront', {}, clientIp(c)),
  ]);
  return c.json({ ok: true, message: 'Publishing started. The shop updates in about 2 minutes.' });
});

adminApi.get('/audit', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT admin_email, action, entity, entity_id, details, created_at FROM audit_log ORDER BY id DESC LIMIT 100').all();
  return c.json({ entries: results });
});
