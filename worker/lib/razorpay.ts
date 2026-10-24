import { hmacSha256Hex, timingSafeEqual } from './crypto';
import { assertSecrets, isDev, type Env } from './env';

/**
 * Razorpay integration (Standard Checkout).
 * Card / UPI details are entered on Razorpay's hosted checkout and never reach us.
 * Docs: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/
 */

const API = 'https://api.razorpay.com/v1';

export function isMock(env: Env): boolean {
  // Mock mode is impossible in production, whatever the variable says.
  return isDev(env) && env.RAZORPAY_MOCK === '1';
}

function authHeader(env: Env): string {
  assertSecrets(env, ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET']);
  return 'Basic ' + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
}

async function call<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: authHeader(env), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // Log the Razorpay error code only; never log keys or full payloads.
    let code = 'unknown';
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? 'unknown';
    } catch {}
    throw new Error(`Razorpay ${method} ${path.split('/')[1]} failed: ${res.status} ${code}`);
  }
  return JSON.parse(text) as T;
}

export interface RzpOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

export async function createRazorpayOrder(
  env: Env,
  amountPaise: number,
  receipt: string,
  notes: Record<string, string>,
): Promise<RzpOrder> {
  if (isMock(env)) {
    const id = 'order_MOCK' + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
    return { id, amount: amountPaise, currency: 'INR', receipt, status: 'created' };
  }
  return call<RzpOrder>(env, 'POST', '/orders', { amount: amountPaise, currency: 'INR', receipt, notes });
}

export interface RzpPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method?: string;
}

export async function fetchOrderPayments(env: Env, rzpOrderId: string): Promise<RzpPayment[]> {
  if (isMock(env)) return [];
  const r = await call<{ items: RzpPayment[] }>(env, 'GET', `/orders/${encodeURIComponent(rzpOrderId)}/payments`);
  return r.items ?? [];
}

export async function fetchPayment(env: Env, paymentId: string): Promise<RzpPayment | null> {
  if (isMock(env)) return null;
  return call<RzpPayment>(env, 'GET', `/payments/${encodeURIComponent(paymentId)}`);
}

export async function refundPayment(env: Env, paymentId: string, amountPaise: number, receipt: string): Promise<{ id: string; status: string }> {
  if (isMock(env)) return { id: 'rfnd_MOCK' + crypto.randomUUID().slice(0, 8), status: 'processed' };
  return call(env, 'POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount: amountPaise, receipt, speed: 'normal' });
}

/** Checkout success signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export async function verifyPaymentSignature(env: Env, rzpOrderId: string, paymentId: string, signature: string): Promise<boolean> {
  assertSecrets(env, ['RAZORPAY_KEY_SECRET']);
  const expected = await hmacSha256Hex(env.RAZORPAY_KEY_SECRET, `${rzpOrderId}|${paymentId}`);
  return timingSafeEqual(expected, signature);
}

/** Webhook signature: HMAC_SHA256(raw request body, webhook_secret). */
export async function verifyWebhookSignature(env: Env, rawBody: string, signature: string | undefined): Promise<boolean> {
  if (!signature) return false;
  assertSecrets(env, ['RAZORPAY_WEBHOOK_SECRET']);
  const expected = await hmacSha256Hex(env.RAZORPAY_WEBHOOK_SECRET, rawBody);
  return timingSafeEqual(expected, signature);
}
