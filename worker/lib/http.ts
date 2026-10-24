import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Security headers for every Worker response (API, media, admin pages). */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://checkout.razorpay.com")');
  h.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) {
    // API responses are data only: nothing may be scripted, framed or cached.
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  }
};

/**
 * CSRF protection: state-changing requests must come from our own pages.
 * Browsers always send Origin on cross-site POST/PATCH/DELETE.
 * Razorpay's server-to-server webhook is exempt (it is HMAC-signed instead).
 */
export const sameOriginWrites: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const path = new URL(c.req.url).pathname;
  if (path === '/api/webhooks/razorpay') return next();
  const origin = c.req.header('Origin');
  const self = new URL(c.req.url).origin;
  const allowed = new Set([self, c.env.SITE_URL.replace(/\/$/, '')]);
  if (!origin || !allowed.has(origin)) {
    return c.json({ error: 'forbidden', message: 'Cross-site request blocked.' }, 403);
  }
  const ct = c.req.header('Content-Type') ?? '';
  if (!ct.startsWith('application/json') && !ct.startsWith('multipart/form-data')) {
    return c.json({ error: 'unsupported_media_type', message: 'Send JSON.' }, 415);
  }
  return next();
};

export function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') ?? '0.0.0.0';
}

export function errorResponse(c: Context, err: unknown): Response {
  if (err instanceof ApiError) {
    return c.json({ error: err.code, message: err.message, ...(err.extra ?? {}) }, err.status as 400);
  }
  // Never leak internals (stack traces, SQL) to the client.
  console.error('Unhandled error', err instanceof Error ? err.stack ?? err.message : String(err));
  return c.json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
}

/** Read a JSON body with a hard size limit (default 32 KB). */
export async function readJson(c: Context, maxBytes = 32 * 1024): Promise<unknown> {
  const len = Number(c.req.header('Content-Length') ?? '0');
  if (len > maxBytes) throw new ApiError(413, 'too_large', 'Request too large.');
  const text = await c.req.text();
  if (text.length > maxBytes) throw new ApiError(413, 'too_large', 'Request too large.');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'bad_json', 'Invalid JSON.');
  }
}
