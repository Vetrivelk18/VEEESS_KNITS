import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { adminEmails, type Env } from './env';
import { devHelp, LOCAL_COOKIE, localAdminStatus, readLocalSession } from './localauth';
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
  // Local testing only: a signed local session stands in for Cloudflare Access.
  // Never active in production (see localauth.ts for the three conditions).
  if (localAdminStatus(env, c.req.raw).enabled) {
    const email = await readLocalSession(env, getCookie(c, LOCAL_COOKIE));
    if (email) c.set('authMode', 'local');
    return email;
  }
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const claims = await verifyAccessJwt(token, env);
    const email = claims?.email?.toLowerCase();
    if (!email || !allowed.has(email)) return null;
    c.set('authMode', 'access');
    return email;
  } catch (err) {
    console.error('Access verification error', err instanceof Error ? err.message : err);
    return null;
  }
}

export type AdminVars = { adminEmail: string; authMode: 'access' | 'local' };

export const requireAdmin: MiddlewareHandler<{ Bindings: Env; Variables: AdminVars }> = async (c, next) => {
  const email = await resolveAdmin(c);
  if (!email) {
    const url = new URL(c.req.url);
    const local = localAdminStatus(c.env, c.req.raw);
    const help = devHelp(c.env, c.req.raw); // only ever present in development
    if (url.pathname.startsWith('/api/')) {
      return c.json({ error: 'unauthorized', message: 'Admin login required.', ...(help ? { localHelp: local.enabled ? ['Sign in at /__local/login'] : help } : {}) }, 401);
    }
    // Same flow as production: unauthenticated admin pages go to a sign-in page.
    if (local.enabled) return c.redirect(`/__local/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    if (help) return c.html(localHelpPage(help), 401);
    return c.text('Admin login required. Sign in through Cloudflare Access.', 401);
  }
  c.set('adminEmail', email);
  await next();
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

/** Development-only troubleshooting page (never shown in production). */
function localHelpPage(problems: string[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local admin sign-in is off</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#14161F">
<h1 style="font-size:24px">Local admin sign-in is switched off</h1>
<p>On the live site, admins sign in through Cloudflare Access. On your computer a local sign-in page is used instead, but it is off because:</p>
<ul>${problems.map((p) => `<li style="margin:6px 0">${esc(p)}</li>`).join('')}</ul>
<p><strong>Fix:</strong> run <code>npm run setup:local</code> (creates <code>.dev.vars</code>), or add <code>ENVIRONMENT=development</code> and <code>LOCAL_ADMIN_BYPASS=1</code> to <code>.dev.vars</code>. Then stop and restart <code>npm run dev</code> and open <a href="http://localhost:8787/admin/">http://localhost:8787/admin/</a>.</p>
<p>Check your setup any time with <code>npm run check:local</code>.</p>
</body></html>`;
}
