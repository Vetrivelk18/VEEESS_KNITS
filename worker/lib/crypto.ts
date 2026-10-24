const enc = new TextEncoder();

export function bytesToHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function b64urlEncode(input: ArrayBuffer | Uint8Array | string): string {
  const bytes = typeof input === 'string' ? enc.encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return bytesToHex(sig);
}

export async function hmacSha256B64url(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message));
  return b64urlEncode(sig);
}

/** Constant-time string comparison (avoids timing attacks on signatures). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function randomId(): string {
  return crypto.randomUUID();
}

/**
 * Signed, expiring link token for the customer's order page.
 * token = <expUnix>.<hmac(orderId.exp)>  — proves the link came from us.
 */
export async function signOrderToken(secret: string, orderId: string, ttlSeconds = 60 * 60 * 24 * 30): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const mac = await hmacSha256B64url(secret, `order:${orderId}.${exp}`);
  return `${exp}.${mac}`;
}

export async function verifyOrderToken(secret: string, orderId: string, token: string): Promise<boolean> {
  const m = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacSha256B64url(secret, `order:${orderId}.${exp}`);
  return timingSafeEqual(expected, m[2] ?? '');
}
