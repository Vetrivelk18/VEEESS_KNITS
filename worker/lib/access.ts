import type { Context, MiddlewareHandler } from 'hono';
import { adminEmails, isLocalDevRequest, type Env } from './env';
import { b64urlDecode } from './crypto';

/**
 * Admin authentication via Cloudflare Access (Zero Trust, free up to 50 users).
 *
 * Cloudflare Access sits in front of /admin* and /api/admin* and asks the admin
 * for an email one-time code. It then forwards a signed JWT in the
 * `Cf-Access-Jwt-Assertion` header. We do NOT trust that header blindly:
 * we verify its RS256 signature against Access's public keys, check the
 * audience (our Access application), issuer and expiry, and finally check the
 * email is on our ADMIN_EMAILS allow-list. Anything else is rejected.
 */

type Jwk = JsonWebKey & { kid?: string };
let certCache: { at: number; keys: Jwk[] } | null = null;

async function getAccessKeys(teamDomain: string): Promise<Jwk[]> {
  if (certCache && Date.now() - certCache.at < 60 * 60 * 1000) return certCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } } as RequestInit);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  certCache = { at: Date.now(), keys: body.keys };
  return body.keys;
}

interface AccessClaims {
  aud: string | string[];
  email?: string;
  exp: number;
  nbf?: number;
  iss: string;
}

export async function verifyAccessJwt(token: string, env: Env): Promise<AccessClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const keys = await getAccessKeys(env.ACCESS_TEAM_DOMAIN);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    certCache = null; // keys may have rotated; refetch next time
    return null;
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(env.ACCESS_AUD)) return null;
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
  if (typeof claims.exp !== 'number' || claims.exp < now) return null;
  if (claims.nbf && claims.nbf > now + 60) return null;
  return claims;
}

export async function resolveAdmin(c: Context<{ Bindings: Env; Variables: AdminVars }>): Promise<string | null> {
  const env = c.env;
  const allowed = adminEmails(env);
  // Local development only: no Access in front of localhost.
  if (isLocalDevRequest(env, c.req.raw) && env.DEV_ADMIN_EMAIL) {
    const e = env.DEV_ADMIN_EMAIL.toLowerCase();
    return allowed.has(e) ? e : null;
  }
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const claims = await verifyAccessJwt(token, env);
    const email = claims?.email?.toLowerCase();
    if (!email || !allowed.has(email)) return null;
    return email;
  } catch (err) {
    console.error('Access verification error', err instanceof Error ? err.message : err);
    return null;
  }
}

export type AdminVars = { adminEmail: string };

export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: AdminVars }> = async (c, next) => {
  const email = await resolveAdmin(c);
  if (!email) {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/')) return c.json({ error: 'unauthorized', message: 'Admin login required.' }, 401);
    return c.text('Admin login required. Sign in through Cloudflare Access.', 401);
  }
  c.set('adminEmail', email);
  await next();
};
