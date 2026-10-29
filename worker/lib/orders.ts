import { ApiError } from './http';
import { intVar, type Env } from './env';
import { formatINR, orderLabel, shippingFor } from './money';
import { randomId } from './crypto';
import { createRazorpayOrder, fetchOrderPayments, type RzpPayment } from './razorpay';
import type { CheckoutInput } from './validation';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

interface VariantRow {
  id: number;
  product_id: number;
  product_name: string;
  colour: string;
  size: string;
  price_paise: number;
  stock: number;
  reserved: number;
  v_active: number;
  p_active: number;
}

export interface QuoteLine {
  variantId: number;
  productName: string;
  variantLabel: string;
  qty: number;
  unitPricePaise: number;
  linePaise: number;
}

/**
 * Price the cart ON THE SERVER from the database. Anything the browser says
 * about prices is ignored — this is what stops "pay ₹1" tampering.
 */
export async function quoteCart(env: Env, items: { variantId: number; qty: number }[]) {
  // Merge duplicate lines so one variant cannot bypass the per-item limit.
  const merged = new Map<number, number>();
  for (const it of items) merged.set(it.variantId, (merged.get(it.variantId) ?? 0) + it.qty);
  if ([...merged.values()].some((q) => q > 10)) throw new ApiError(400, 'qty_limit', 'Maximum 10 of one item per order.');
  const totalQty = [...merged.values()].reduce((a, b) => a + b, 0);
  if (totalQty > 20) throw new ApiError(400, 'qty_limit', 'Maximum 20 items per order.');

  const ids = [...merged.keys()];
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.product_id, p.name AS product_name, v.colour, v.size, v.price_paise, v.stock, v.reserved,
            v.is_active AS v_active, p.is_active AS p_active
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE v.id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<VariantRow>();
  const byId = new Map(results.map((r) => [r.id, r]));

  const lines: QuoteLine[] = [];
  const unavailable: { variantId: number; available: number }[] = [];
  for (const [variantId, qty] of merged) {
    const v = byId.get(variantId);
    if (!v || !v.v_active || !v.p_active) {
      unavailable.push({ variantId, available: 0 });
      continue;
    }
    const available = v.stock - v.reserved;
    if (available < qty) unavailable.push({ variantId, available: Math.max(0, available) });
    lines.push({
      variantId,
      productName: v.product_name,
      variantLabel: `${v.colour} / ${v.size}`,
      qty,
      unitPricePaise: v.price_paise,
      linePaise: v.price_paise * qty,
    });
  }
  const subtotal = lines.reduce((a, l) => a + l.linePaise, 0);
  const shipping = lines.length
    ? shippingFor(subtotal, intVar(env.FREE_SHIPPING_MIN_PAISE, 0), intVar(env.SHIPPING_FEE_PAISE, 0))
    : 0;
  return { lines, unavailable, subtotal, shipping, total: subtotal + shipping };
}

export interface CreatedOrder {
  id: string;
  number: number;
  label: string;
  totalPaise: number;
  paymentMethod: 'razorpay' | 'cod';
  razorpayOrderId: string | null;
  status: string;
}

export async function createOrder(env: Env, input: CheckoutInput, ip: string): Promise<CreatedOrder> {
  // Online payment only unless COD_ENABLED is "1" (D44). Checked before any database work.
  if (input.paymentMethod === 'cod' && env.COD_ENABLED !== '1') {
    throw new ApiError(400, 'cod_unavailable', 'Cash on delivery is not available. Please pay online.');
  }
  const q = await quoteCart(env, input.items);
  if (q.unavailable.length) {
    throw new ApiError(409, 'out_of_stock', 'Some items are no longer available in that quantity.', { unavailable: q.unavailable });
  }
  const isCod = input.paymentMethod === 'cod';

  if (isCod) {
    const maxOpen = intVar(env.COD_MAX_OPEN_PER_PHONE, 2);
    const open = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE c.phone = ?1 AND o.payment_method = 'cod'
          AND o.status IN ('cod_pending','confirmed','packed','shipped')`,
    )
      .bind(input.customer.phone)
      .first<{ n: number }>();
    if ((open?.n ?? 0) >= maxOpen) {
      throw new ApiError(409, 'cod_limit', `You already have ${maxOpen} cash-on-delivery orders on the way. Please pay online for this order, or wait for them to arrive.`);
    }
    const maxValue = intVar(env.COD_MAX_ORDER_PAISE, 0);
    if (maxValue > 0 && q.total > maxValue) {
      throw new ApiError(409, 'cod_value_limit', `Cash on delivery is available for orders up to ${formatINR(maxValue)}. Please pay online.`);
    }
  }

  const id = randomId();
  const expiryMin = intVar(env.ORDER_EXPIRY_MINUTES, 30);
  const expiresAt = new Date(Date.now() + expiryMin * 60_000).toISOString();
  const db = env.DB;
  const c = input.customer;
  const a = input.address;

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO customers (name, phone, email) VALUES (?1, ?2, ?3)
         ON CONFLICT (phone) DO UPDATE SET name = excluded.name, email = excluded.email, updated_at = ${NOW}`,
      )
      .bind(c.name, c.phone, c.email),
    db
      .prepare(
        `INSERT INTO addresses (customer_id, line1, line2, city, state, pincode)
         VALUES ((SELECT id FROM customers WHERE phone = ?1), ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(c.phone, a.line1, a.line2 ?? '', a.city, a.state, a.pincode),
    db
      .prepare(
        `INSERT INTO orders (id, number, customer_id, address_id, status, payment_method,
                             subtotal_paise, shipping_paise, cod_fee_paise, total_paise, client_ip, expires_at,
                             contact_name, contact_email)
         VALUES (?1, (SELECT COALESCE(MAX(number), 1000) + 1 FROM orders),
                 (SELECT id FROM customers WHERE phone = ?2),
                 (SELECT MAX(id) FROM addresses WHERE customer_id = (SELECT id FROM customers WHERE phone = ?2)),
                 ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(id, c.phone, isCod ? 'cod_pending' : 'created', input.paymentMethod, q.subtotal, q.shipping, q.total, ip, isCod ? null : expiresAt, c.name, c.email),
  ];
  for (const l of q.lines) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO order_items (order_id, variant_id, product_name, variant_label, qty, unit_price_paise)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(id, l.variantId, l.productName, l.variantLabel, l.qty, l.unitPricePaise),
    );
    // The CHECK (reserved <= stock AND stock >= 0) constraint makes this fail —
    // and the whole batch roll back — if two shoppers race for the last item.
    stmts.push(
      isCod
        ? db.prepare('UPDATE product_variants SET stock = stock - ?1 WHERE id = ?2').bind(l.qty, l.variantId)
        : db.prepare('UPDATE product_variants SET reserved = reserved + ?1 WHERE id = ?2').bind(l.qty, l.variantId),
    );
  }

  try {
    await db.batch(stmts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/CHECK constraint/i.test(msg)) {
      throw new ApiError(409, 'out_of_stock', 'Sorry, an item just sold out. Please review your cart.');
    }
    throw err;
  }

  const row = await db.prepare('SELECT number FROM orders WHERE id = ?1').bind(id).first<{ number: number }>();
  const number = row?.number ?? 0;

  if (isCod) {
    await insertNewOrderAlert(db, id, number, q.total, 'COD', q.lines.reduce((s, l) => s + l.qty, 0), c.name);
    return { id, number, label: orderLabel(number), totalPaise: q.total, paymentMethod: 'cod', razorpayOrderId: null, status: 'cod_pending' };
  }

  try {
    const rzp = await createRazorpayOrder(env, q.total, orderLabel(number), { order_id: id });
    await db.prepare(`UPDATE orders SET razorpay_order_id = ?1, updated_at = ${NOW} WHERE id = ?2`).bind(rzp.id, id).run();
    return { id, number, label: orderLabel(number), totalPaise: q.total, paymentMethod: 'razorpay', razorpayOrderId: rzp.id, status: 'created' };
  } catch (err) {
    console.error('Razorpay order creation failed', err instanceof Error ? err.message : err);
    await releaseOrder(db, id, 'failed');
    throw new ApiError(502, 'payment_unavailable', 'Online payment is unavailable right now. Please try again or choose cash on delivery.');
  }
}

/** Release reserved stock and close an unpaid online order. Safe to call twice. */
export async function releaseOrder(db: D1Database, orderId: string, status: 'expired' | 'failed' | 'cancelled'): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare(
        `UPDATE product_variants
            SET reserved = reserved - (SELECT qty FROM order_items oi WHERE oi.order_id = ?1 AND oi.variant_id = product_variants.id)
          WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?1)
            AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = 'created')`,
      )
      .bind(orderId),
    db.prepare(`UPDATE orders SET status = ?2, updated_at = ${NOW} WHERE id = ?1 AND status = 'created'`).bind(orderId, status),
  ]);
  return (res[1]?.meta.changes ?? 0) > 0;
}

interface OrderRow {
  id: string;
  number: number;
  status: string;
  total_paise: number;
  razorpay_order_id: string | null;
  payment_method: string;
  customer_name: string;
  item_count: number;
}

async function loadOrder(db: D1Database, orderId: string): Promise<OrderRow | null> {
  return db
    .prepare(
      `SELECT o.id, o.number, o.status, o.total_paise, o.razorpay_order_id, o.payment_method, COALESCE(o.contact_name, c.name) AS customer_name,
              (SELECT COALESCE(SUM(qty),0) FROM order_items WHERE order_id = o.id) AS item_count
         FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?1`,
    )
    .bind(orderId)
    .first<OrderRow>();
}

export async function insertNewOrderAlert(
  db: D1Database,
  orderId: string,
  number: number,
  totalPaise: number,
  method: string,
  items: number,
  customerName: string,
): Promise<void> {
  // Alert text deliberately excludes address and phone (it may show on a lock screen).
  const firstName = customerName.split(/\s+/)[0]?.slice(0, 20) ?? '';
  await db
    .prepare(`INSERT INTO notifications (type, order_id, title, body) VALUES ('new_order', ?1, ?2, ?3) ON CONFLICT (type, order_id) DO NOTHING`)
    .bind(orderId, `New order ${orderLabel(number)}`, `${formatINR(totalPaise)} · ${method} · ${items} item${items === 1 ? '' : 's'} · ${firstName}`)
    .run();
}

export type PaySource = 'verify' | 'webhook' | 'reconcile';

/**
 * Record a captured payment and mark the order paid — exactly once.
 * Called from three places (browser verify, webhook, reconciliation); whichever
 * arrives first wins and the others become no-ops.
 * Returns true only for the call that actually moved the order to "paid".
 */
export async function markPaid(
  env: Env,
  orderId: string,
  p: { id: string; amount: number; currency?: string; method?: string; status: string },
  source: PaySource,
): Promise<boolean> {
  const db = env.DB;
  const order = await loadOrder(db, orderId);
  if (!order) return false;

  await db
    .prepare(
      `INSERT INTO payments (order_id, razorpay_payment_id, status, amount_paise, method, source)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (razorpay_payment_id) DO NOTHING`,
    )
    .bind(orderId, p.id, p.status, p.amount, p.method ?? null, source)
    .run();

  const amountOk = p.amount === order.total_paise && (p.currency ?? 'INR') === 'INR';
  const attention = amountOk ? null : `Amount mismatch: paid ${formatINR(p.amount)}, order total ${formatINR(order.total_paise)}`;

  let moved = false;
  if (order.status === 'created') {
    const res = await db.batch([
      db
        .prepare(
          `UPDATE product_variants
              SET stock = stock - (SELECT qty FROM order_items oi WHERE oi.order_id = ?1 AND oi.variant_id = product_variants.id),
                  reserved = reserved - (SELECT qty FROM order_items oi WHERE oi.order_id = ?1 AND oi.variant_id = product_variants.id)
            WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?1)
              AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = 'created')`,
        )
        .bind(orderId),
      db
        .prepare(`UPDATE orders SET status = 'paid', paid_at = ${NOW}, updated_at = ${NOW}, needs_attention = COALESCE(?2, needs_attention) WHERE id = ?1 AND status = 'created'`)
        .bind(orderId, attention),
    ]);
    moved = (res[1]?.meta.changes ?? 0) > 0;
  } else if (order.status === 'expired' || order.status === 'failed') {
    // Paid after the reservation lapsed: take stock now if we still have it.
    try {
      const res = await db.batch([
        db
          .prepare(
            `UPDATE product_variants
                SET stock = stock - (SELECT qty FROM order_items oi WHERE oi.order_id = ?1 AND oi.variant_id = product_variants.id)
              WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?1)
                AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status IN ('expired','failed'))`,
          )
          .bind(orderId),
        db
          .prepare(`UPDATE orders SET status = 'paid', paid_at = ${NOW}, updated_at = ${NOW}, needs_attention = ?2 WHERE id = ?1 AND status IN ('expired','failed')`)
          .bind(orderId, attention ?? 'Paid after the order had expired — stock was re-checked'),
      ]);
      moved = (res[1]?.meta.changes ?? 0) > 0;
    } catch {
      const res = await db
        .prepare(`UPDATE orders SET status = 'paid', paid_at = ${NOW}, updated_at = ${NOW}, needs_attention = ?2 WHERE id = ?1 AND status IN ('expired','failed')`)
        .bind(orderId, 'Paid after expiry but an item is OUT OF STOCK — refund or restock')
        .run();
      moved = (res.meta.changes ?? 0) > 0;
    }
  }

  if (moved) {
    const method = p.method ? p.method.toUpperCase() : 'ONLINE';
    await insertNewOrderAlert(db, orderId, order.number, order.total_paise, method === 'UPI' ? 'UPI' : method === 'CARD' ? 'Card' : method, order.item_count, order.customer_name);
  }
  return moved;
}

/** Cron: check Razorpay for orders still "created", then expire stale ones. */
export async function reconcileAndExpire(env: Env): Promise<{ paid: number; expired: number }> {
  const db = env.DB;
  let paid = 0;
  let expired = 0;
  const { results } = await db
    .prepare(
      `SELECT id, razorpay_order_id, expires_at FROM orders
        WHERE status = 'created' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')
        ORDER BY created_at LIMIT 40`,
    )
    .all<{ id: string; razorpay_order_id: string | null; expires_at: string | null }>();

  for (const o of results) {
    let payments: RzpPayment[] = [];
    if (o.razorpay_order_id) {
      try {
        payments = await fetchOrderPayments(env, o.razorpay_order_id);
      } catch (err) {
        console.error('Reconcile fetch failed', o.id, err instanceof Error ? err.message : err);
        continue; // never expire an order we could not check
      }
    }
    const captured = payments.find((p) => p.status === 'captured');
    if (captured) {
      if (await markPaid(env, o.id, captured, 'reconcile')) paid++;
      continue;
    }
    const authorized = payments.some((p) => p.status === 'authorized');
    if (!authorized && o.expires_at && o.expires_at < new Date().toISOString()) {
      if (await releaseOrder(db, o.id, 'expired')) expired++;
    }
  }
  return { paid, expired };
}
