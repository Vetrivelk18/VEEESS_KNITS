import { b64urlEncode } from './crypto';
import type { Env } from './env';

/**
 * Web Push to admin devices, implemented with the Web Crypto API only.
 *
 * Design choice: pushes carry NO payload. The push just wakes the admin
 * panel's service worker, which then fetches the alert text from our own API
 * (behind Cloudflare Access). So no order data ever passes through Google /
 * Apple / Mozilla push servers, and we avoid payload-encryption code entirely.
 * Auth uses VAPID (RFC 8292): an ES256-signed JWT per push service origin.
 */

// Only real browser push services may be stored as endpoints (prevents SSRF:
// the server POSTs to whatever endpoint is saved).
const ALLOWED_PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
  /^android\.googleapis\.com$/,
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && ALLOWED_PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

let keyCache: CryptoKey | null = null;
async function vapidKey(env: Env): Promise<CryptoKey | null> {
  if (keyCache) return keyCache;
  if (!env.VAPID_PRIVATE_JWK) return null;
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey;
  keyCache = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return keyCache;
}

export async function vapidAuthHeader(env: Env, endpoint: string): Promise<string | null> {
  const key = await vapidKey(env);
  if (!key || !env.VAPID_PUBLIC_KEY) return null;
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64urlEncode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

/** Wake every subscribed admin device. Dead subscriptions are removed. */
export async function pushToAdmins(env: Env): Promise<{ sent: number; failed: number }> {
  const { results } = await env.DB.prepare('SELECT id, endpoint FROM push_subscriptions').all<{ id: number; endpoint: string }>();
  let sent = 0;
  let failed = 0;
  for (const s of results) {
    if (!isAllowedPushEndpoint(s.endpoint)) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?1').bind(s.id).run();
      continue;
    }
    try {
      const auth = await vapidAuthHeader(env, s.endpoint);
      if (!auth) return { sent, failed: results.length };
      const res = await fetch(s.endpoint, {
        method: 'POST',
        headers: { Authorization: auth, TTL: '86400', Urgency: 'high', 'Content-Length': '0' },
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?1').bind(s.id).run();
        failed++;
      } else if (res.ok) {
        await env.DB.prepare("UPDATE push_subscriptions SET last_success_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), failures = 0 WHERE id = ?1").bind(s.id).run();
        sent++;
      } else {
        await env.DB.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?1').bind(s.id).run();
        failed++;
      }
    } catch (err) {
      console.error('Push failed', err instanceof Error ? err.message : err);
      failed++;
    }
  }
  return { sent, failed };
}
