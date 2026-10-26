import { Hono } from 'hono';
import { intVar, isLocalDevRequest, type Env } from '../lib/env';
import { ApiError, clientIp, readJson } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { verifyTurnstile } from '../lib/turnstile';
import { checkoutSchema, parse, verifyPaymentSchema } from '../lib/validation';
import { z } from 'zod';
import { createOrder, markPaid, quoteCart } from '../lib/orders';
import { fetchPayment, isMock, verifyPaymentSignature, verifyWebhookSignature } from '../lib/razorpay';
import { dispatchNewOrder } from '../lib/alerts';
import { hmacSha256Hex, signOrderToken, verifyOrderToken } from '../lib/crypto';
import { orderLabel } from '../lib/money';

export const publicApi = new Hono<{ Bindings: Env }>();

/** Public, non-secret settings the storefront needs. */
publicApi.get('/config', (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  return c.json({
    razorpayKeyId: c.env.RAZORPAY_KEY_ID,
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
    mockPayments: isMock(c.env),
    freeShippingMinPaise: intVar(c.env.FREE_SHIPPING_MIN_PAISE, 0),
    shippingFeePaise: intVar(c.env.SHIPPING_FEE_PAISE, 0),
  });
});

/** Live price and stock for one product (static pages may be a little stale). */
publicApi.get('/products/:slug', async (c) => {
  const slug = c.req.param('slug');
  if (!/^[a-z0-9-]{1,120}$/.test(slug)) throw new ApiError(404, 'not_found', 'Product not found.');
  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.colour, v.colour_hex, v.size, v.price_paise, v.mrp_paise,
            MAX(v.stock - v.reserved, 0) AS available
       FROM product_variants v JOIN products p ON p.id = v.product_id
      WHERE p.slug = ?1 AND p.is_active = 1 AND v.is_active = 1
      ORDER BY v.sort_order`,
  )
    .bind(slug)
    .all();
  if (!results.length) throw new ApiError(404, 'not_found', 'Product not found.');
  c.header('Cache-Control', 'public, max-age=15');
  return c.json({ variants: results });
});

const quoteSchema = z.object({
  items: z.array(z.object({ variantId: z.number().int().positive(), qty: z.number().int().min(1).max(10) })).max(20),
});

publicApi.post('/cart/quote', async (c) => {
  await rateLimit(c.env.DB, `quote:${clientIp(c)}`, 120, 600);
  const { items } = parse(quoteSchema, await readJson(c));
  if (!items.length) return c.json({ lines: [], unavailable: [], subtotal: 0, shipping: 0, total: 0 });
  return c.json(await quoteCart(c.env, items));
});

publicApi.post('/checkout', async (c) => {
  const ip = clientIp(c);
  await rateLimit(c.env.DB, `checkout:ip:${ip}`, 10, 600);
  const input = parse(checkoutSchema, await readJson(c));
  await rateLimit(c.env.DB, `checkout:phone:${input.customer.phone}`, 6, 3600);

  // Turnstile: real check everywhere except local dev with Cloudflare's test secret.
  const testSecret = c.env.TURNSTILE_SECRET_KEY === '1x0000000000000000000000000000000AA';
  if (!(isLocalDevRequest(c.env, c.req.raw) && testSecret)) {
    await verifyTurnstile(c.env, input.turnstileToken, ip);
  }

  const order = await createOrder(c.env, input, ip);
  const token = await signOrderToken(c.env.ORDER_LINK_SECRET, order.id);
  if (order.paymentMethod === 'cod') c.executionCtx.waitUntil(dispatchNewOrder(c.env, order.id));

  return c.json({
    orderId: order.id,
    label: order.label,
    totalPaise: order.totalPaise,
    paymentMethod: order.paymentMethod,
    status: order.status,
    token,
    razorpay:
      order.paymentMethod === 'razorpay'
        ? {
            key: c.env.RAZORPAY_KEY_ID,
            orderId: order.razorpayOrderId,
            amount: order.totalPaise,
            currency: 'INR',
            name: 'Veeess Knits',
            description: `Order ${order.label}`,
            prefill: { name: input.customer.name, email: input.customer.email, contact: input.customer.phone },
            mock: isMock(c.env),
          }
        : null,
  });
});

/** Called by the browser after Razorpay Checkout succeeds. Never trusted without the signature. */
publicApi.post('/payments/verify', async (c) => {
  await rateLimit(c.env.DB, `verify:${clientIp(c)}`, 30, 600);
  const body = parse(verifyPaymentSchema, await readJson(c));
  const order = await c.env.DB.prepare('SELECT id, number, status, total_paise, razorpay_order_id FROM orders WHERE id = ?1')
    .bind(body.orderId)
    .first<{ id: string; number: number; status: string; total_paise: number; razorpay_order_id: string | null }>();
  if (!order || order.razorpay_order_id !== body.razorpay_order_id) throw new ApiError(400, 'invalid_payment', 'Payment could not be verified.');

  const ok = await verifyPaymentSignature(c.env, body.razorpay_order_id, body.razorpay_payment_id, body.razorpay_signature);
  if (!ok) {
    console.warn('Invalid payment signature', { order: order.id });
    throw new ApiError(400, 'invalid_payment', 'Payment could not be verified.');
  }

  // Confirm with Razorpay that the money was actually captured (and how much).
  let payment = await fetchPayment(c.env, body.razorpay_payment_id).catch(() => null);
  if (!payment && isMock(c.env)) {
    payment = { id: body.razorpay_payment_id, order_id: body.razorpay_order_id, amount: order.total_paise, currency: 'INR', status: 'captured', method: 'upi' };
  }
  let status = order.status;
  if (payment && payment.status === 'captured' && payment.order_id === body.razorpay_order_id) {
    const moved = await markPaid(c.env, order.id, payment, 'verify');
    if (moved) c.executionCtx.waitUntil(dispatchNewOrder(c.env, order.id));
    status = 'paid';
  } else {
    // Authorised but not yet captured, or Razorpay API slow: webhook/reconcile will finish it.
    status = 'processing';
  }
  const token = await signOrderToken(c.env.ORDER_LINK_SECRET, order.id);
  return c.json({ orderId: order.id, label: orderLabel(order.number), status, token });
});

/** Razorpay → us, server to server. Authenticated by HMAC of the raw body. */
publicApi.post('/webhooks/razorpay', async (c) => {
  const raw = await c.req.text();
  if (raw.length > 256 * 1024) return c.json({ error: 'too_large' }, 413);
  const valid = await verifyWebhookSignature(c.env, raw, c.req.header('X-Razorpay-Signature'));
  if (!valid) {
    console.warn('Webhook with invalid signature rejected');
    return c.json({ error: 'invalid_signature' }, 400);
  }
  const eventId = c.req.header('X-Razorpay-Event-Id');
  let evt: { event?: string; payload?: { payment?: { entity?: Record<string, unknown> } } };
  try {
    evt = JSON.parse(raw);
  } catch {
    return c.json({ error: 'bad_json' }, 400);
  }
  if (eventId) {
    const seen = await c.env.DB.prepare('SELECT 1 FROM webhook_events WHERE event_id = ?1').bind(eventId.slice(0, 100)).first();
    if (seen) return c.json({ ok: true, duplicate: true });
  }
  const p = evt.payload?.payment?.entity as
    | { id: string; order_id: string; amount: number; currency: string; status: string; method?: string }
    | undefined;
  if ((evt.event === 'payment.captured' || evt.event === 'order.paid') && p?.order_id && p.status === 'captured') {
    const order = await c.env.DB.prepare('SELECT id FROM orders WHERE razorpay_order_id = ?1').bind(p.order_id).first<{ id: string }>();
    if (order) {
      const moved = await markPaid(c.env, order.id, p, 'webhook');
      if (moved) c.executionCtx.waitUntil(dispatchNewOrder(c.env, order.id));
    }
  }
  // Recorded only after successful processing, so a failed attempt is retried by Razorpay.
  if (eventId) {
    await c.env.DB.prepare('INSERT INTO webhook_events (event_id, type) VALUES (?1, ?2) ON CONFLICT DO NOTHING')
      .bind(eventId.slice(0, 100), String(evt.event ?? '').slice(0, 60))
      .run();
  }
  return c.json({ ok: true });
});

/** Order status for the customer, via the signed link from checkout / email. */
publicApi.get('/orders/:id', async (c) => {
  await rateLimit(c.env.DB, `order-view:${clientIp(c)}`, 60, 600);
  const id = c.req.param('id');
  const token = c.req.query('t') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(id) || !(await verifyOrderToken(c.env.ORDER_LINK_SECRET, id, token))) {
    throw new ApiError(404, 'not_found', 'Order not found or link expired.');
  }
  const o = await c.env.DB.prepare(
    `SELECT o.id, o.number, o.status, o.payment_method, o.subtotal_paise, o.shipping_paise, o.total_paise, o.tracking_number, o.created_at,
            COALESCE(o.contact_name, c.name) AS name, a.line1, a.line2, a.city, a.state, a.pincode
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN addresses a ON a.id = o.address_id WHERE o.id = ?1`,
  )
    .bind(id)
    .first<Record<string, unknown> & { number: number }>();
  if (!o) throw new ApiError(404, 'not_found', 'Order not found.');
  const { results: items } = await c.env.DB.prepare('SELECT product_name, variant_label, qty, unit_price_paise FROM order_items WHERE order_id = ?1')
    .bind(id)
    .all();
  return c.json({ ...o, label: orderLabel(o.number), items });
});

/**
 * LOCAL DEVELOPMENT ONLY: stands in for Razorpay's checkout popup so the full
 * flow can be tested offline. Refuses unless ENVIRONMENT=development AND the
 * request is to localhost AND RAZORPAY_MOCK=1.
 */
publicApi.post('/dev/mock-pay', async (c) => {
  if (!isLocalDevRequest(c.env, c.req.raw) || !isMock(c.env)) throw new ApiError(404, 'not_found', 'Not found.');
  const { orderId } = parse(z.object({ orderId: z.string().uuid() }), await readJson(c));
  const o = await c.env.DB.prepare('SELECT razorpay_order_id FROM orders WHERE id = ?1').bind(orderId).first<{ razorpay_order_id: string }>();
  if (!o?.razorpay_order_id) throw new ApiError(404, 'not_found', 'Not found.');
  const paymentId = 'pay_MOCK' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
  const signature = await hmacSha256Hex(c.env.RAZORPAY_KEY_SECRET, `${o.razorpay_order_id}|${paymentId}`);
  return c.json({ razorpay_order_id: o.razorpay_order_id, razorpay_payment_id: paymentId, razorpay_signature: signature });
});
