import { describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, createVerify } from 'node:crypto';
import { hmacSha256Hex, signOrderToken, timingSafeEqual, verifyOrderToken, b64urlDecode } from '../worker/lib/crypto';
import { verifyPaymentSignature, verifyWebhookSignature, isMock } from '../worker/lib/razorpay';
import { checkoutSchema, normalisePhone, parse } from '../worker/lib/validation';
import { isAllowedPushEndpoint, vapidAuthHeader } from '../worker/lib/webpush';
import { sniffImage } from '../worker/routes/admin';
import { emailList, escapeHtml } from '../worker/lib/email';
import { formatINR, shippingFor } from '../worker/lib/money';
import type { Env } from '../worker/lib/env';

const env = {
  ENVIRONMENT: 'production',
  RAZORPAY_KEY_ID: 'rzp_test_abcdef123',
  RAZORPAY_KEY_SECRET: 'test_secret_value_123',
  RAZORPAY_WEBHOOK_SECRET: 'webhook_secret_value_123',
  RAZORPAY_MOCK: '1',
  VAPID_SUBJECT: 'mailto:test@example.com',
} as unknown as Env;

describe('Razorpay signatures', () => {
  it('accepts a correct checkout signature and rejects a forged one', async () => {
    const sig = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update('order_ABC123|pay_XYZ789').digest('hex');
    expect(await verifyPaymentSignature(env, 'order_ABC123', 'pay_XYZ789', sig)).toBe(true);
    expect(await verifyPaymentSignature(env, 'order_ABC123', 'pay_OTHER1', sig)).toBe(false);
    expect(await verifyPaymentSignature(env, 'order_ABC123', 'pay_XYZ789', '0'.repeat(64))).toBe(false);
  });

  it('verifies webhook bodies byte-for-byte', async () => {
    const body = '{"event":"payment.captured","payload":{}}';
    const sig = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
    expect(await verifyWebhookSignature(env, body, sig)).toBe(true);
    expect(await verifyWebhookSignature(env, body + ' ', sig)).toBe(false);
    expect(await verifyWebhookSignature(env, body, undefined)).toBe(false);
  });

  it('refuses to run with placeholder secrets', async () => {
    const bad = { ...env, RAZORPAY_KEY_SECRET: 'REPLACE' } as Env;
    await expect(verifyPaymentSignature(bad, 'order_A', 'pay_B', 'x')).rejects.toThrow(/placeholder/);
  });

  it('never allows mock payments outside development', () => {
    expect(isMock(env)).toBe(false);
    expect(isMock({ ...env, ENVIRONMENT: 'development' } as Env)).toBe(true);
  });

  it('matches Node HMAC output', async () => {
    expect(await hmacSha256Hex('k', 'm')).toBe(createHmac('sha256', 'k').update('m').digest('hex'));
  });
});

describe('Order link tokens', () => {
  const secret = 'order-link-secret-for-tests-0123456789';
  const id = '6f1c2a1e-1111-4222-8333-944455556666';
  it('round-trips and is bound to the order id', async () => {
    const t = await signOrderToken(secret, id);
    expect(await verifyOrderToken(secret, id, t)).toBe(true);
    expect(await verifyOrderToken(secret, '6f1c2a1e-1111-4222-8333-944455556667', t)).toBe(false);
    expect(await verifyOrderToken('another-secret-xxxxxxxxxxxxxxxxxx', id, t)).toBe(false);
  });
  it('expires', async () => {
    const t = await signOrderToken(secret, id, -10);
    expect(await verifyOrderToken(secret, id, t)).toBe(false);
  });
  it('rejects malformed tokens', async () => {
    expect(await verifyOrderToken(secret, id, 'abc')).toBe(false);
    expect(await verifyOrderToken(secret, id, '')).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('Checkout validation', () => {
  const good = {
    items: [{ variantId: 1, qty: 2 }],
    customer: { name: 'Priya Sharma', phone: '+91 98765 43210', email: 'Priya@Example.com' },
    address: { line1: '12 Gandhi Road', city: 'Tiruppur', state: 'Tamil Nadu', pincode: '641603' },
    paymentMethod: 'cod',
    consent: true,
  };
  it('normalises phone and email', () => {
    const r = parse(checkoutSchema, good);
    expect(r.customer.phone).toBe('9876543210');
    expect(r.customer.email).toBe('priya@example.com');
  });
  it('rejects script tags, bad phones, bad PIN codes, huge quantities, no consent', () => {
    expect(() => parse(checkoutSchema, { ...good, customer: { ...good.customer, name: '<script>x</script>' } })).toThrow();
    expect(() => parse(checkoutSchema, { ...good, customer: { ...good.customer, phone: '12345' } })).toThrow();
    expect(() => parse(checkoutSchema, { ...good, address: { ...good.address, pincode: '041603' } })).toThrow();
    expect(() => parse(checkoutSchema, { ...good, items: [{ variantId: 1, qty: 50 }] })).toThrow();
    expect(() => parse(checkoutSchema, { ...good, consent: false })).toThrow();
    expect(() => parse(checkoutSchema, { ...good, address: { ...good.address, state: 'Atlantis' } })).toThrow();
  });
  it('ignores any price the browser sends', () => {
    const r = parse(checkoutSchema, { ...good, items: [{ variantId: 1, qty: 1, price: 1 }], total: 1 }) as Record<string, unknown>;
    expect(r.total).toBeUndefined();
    expect((r.items as Record<string, unknown>[])[0]).not.toHaveProperty('price');
  });
  it('phone normaliser', () => {
    expect(normalisePhone('09876543210')).toBe('9876543210');
    expect(normalisePhone('919876543210')).toBe('9876543210');
  });
});

describe('Uploads and push endpoints', () => {
  it('detects real image signatures only', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext).toBe('png');
    expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });
  it('only allows known push services (no SSRF)', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc')).toBe(true);
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isAllowedPushEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isAllowedPushEndpoint('https://evil.com/fcm.googleapis.com')).toBe(false);
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.evil.com/x')).toBe(false);
  });
  it('signs a valid VAPID ES256 JWT', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const pub = publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]).toString('base64url');
    const e = { ...env, VAPID_PRIVATE_JWK: JSON.stringify(jwk), VAPID_PUBLIC_KEY: raw } as Env;
    const h = await vapidAuthHeader(e, 'https://fcm.googleapis.com/fcm/send/abc');
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h!);
    expect(m).not.toBeNull();
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m![2]!)));
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    const v = createVerify('SHA256');
    v.update(`${m![1]}.${m![2]}`);
    expect(v.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m![3]!, 'base64url'))).toBe(true);
  });
});

describe('Output safety and money', () => {
  it('escapes HTML in emails', () => {
    expect(escapeHtml(`<img src=x onerror="a">'`)).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&#39;');
  });
  it('reads a list of alert emails safely', () => {
    expect(emailList('a@x.com, b@y.in ,a@x.com,,not-an-email,c@z.org')).toEqual(['a@x.com', 'b@y.in', 'c@z.org']);
    expect(emailList('')).toEqual([]);
    expect(emailList('evil@x.com>, <bcc@y.com')).toEqual([]);
  });
  it('formats rupees and shipping', () => {
    expect(formatINR(159800)).toBe('₹1,598');
    expect(formatINR(12345678)).toBe('₹1,23,456.78');
    expect(shippingFor(99900, 99900, 7900)).toBe(0);
    expect(shippingFor(99800, 99900, 7900)).toBe(7900);
    expect(shippingFor(500000, 0, 7900)).toBe(7900); // no free-delivery threshold
    expect(shippingFor(100, 0, 0)).toBe(0); // free delivery
    expect(shippingFor(100, 99900, 0)).toBe(0);
  });
});
