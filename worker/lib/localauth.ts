import { adminEmails, type Env } from './env';
import { b64urlDecode, b64urlEncode, hmacSha256B64url, timingSafeEqual } from './crypto';

/**
 * LOCAL TESTING ONLY — a stand-in for Cloudflare Access on your own computer.
 *
 * On the live site, Cloudflare Access asks admins for an email one-time code
 * and the Worker verifies Access's signed token (see access.ts). Access does
 * not exist on localhost, so for local testing we provide the same *flow*:
 * an admin page redirects to a sign-in page, you pick one of ADMIN_EMAILS,
 * a signed session cookie is set, and you can sign out again.
 *
 * It switches on ONLY when ALL of these are true:
 *   1. ENVIRONMENT = "development"   (comes from .dev.vars; production config says "production")
 *   2. LOCAL_ADMIN_BYPASS = "1"      (explicit opt-in in .dev.vars)
 *   3. the request is to localhost / 127.0.0.1 / [::1]
 * The email must still be in ADMIN_EMAILS. The deploy check
 * (scripts/check-prod-config.mjs) refuses to deploy if production config
 * contains any of these local settings.
 */

export const LOCAL_COOKIE = 'vk_local_admin';
const SESSION_SECONDS = 8 * 60 * 60;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// A fresh random key every time the dev server starts: restarting signs you out,
// and a cookie from one machine/run is useless anywhere else. Created on first
// use, because Workers do not allow random values at start-up (global scope).
let processKey: string | null = null;

let warned = false;

export interface LocalStatus {
  enabled: boolean;
  /** Plain-language reasons it is off (shown only in development). */
  problems: string[];
}

export function localAdminStatus(env: Env, req: Request): LocalStatus {
  const problems: string[] = [];
  const host = new URL(req.url).hostname;
  if (env.ENVIRONMENT !== 'development') {
    if (env.LOCAL_ADMIN_BYPASS && !warned) {
      warned = true;
      console.warn('LOCAL_ADMIN_BYPASS is set but ENVIRONMENT is not "development" — ignored.');
    }
    problems.push(`ENVIRONMENT is "${env.ENVIRONMENT ?? '(not set)'}". Local sign-in needs ENVIRONMENT=development in .dev.vars (is the .dev.vars file missing?).`);
  }
  if (env.LOCAL_ADMIN_BYPASS !== '1') problems.push('LOCAL_ADMIN_BYPASS is not set to 1 in .dev.vars.');
  if (!LOOPBACK.has(host)) problems.push(`You opened the site as "${host}". Use http://localhost:8787 (local sign-in only works on localhost).`);
  if (adminEmails(env).size === 0) problems.push('ADMIN_EMAILS is empty.');
  return { enabled: problems.length === 0, problems };
}

/** Problems are only ever shown when running in development. */
export function devHelp(env: Env, req: Request): string[] | undefined {
  return env.ENVIRONMENT === 'development' ? localAdminStatus(env, req).problems : undefined;
}

function secret(env: Env): string {
  processKey ??= `${crypto.randomUUID()}${crypto.randomUUID()}`;
  return `${processKey}|${env.ORDER_LINK_SECRET ?? ''}`;
}

export async function createLocalSession(env: Env, email: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const payload = `${b64urlEncode(email)}.${exp}`;
  const mac = await hmacSha256B64url(secret(env), `local-admin:${payload}`);
  return `${payload}.${mac}`;
}

export async function readLocalSession(env: Env, cookieValue: string | undefined): Promise<string | null> {
  if (!cookieValue) return null;
  const m = /^([A-Za-z0-9_-]{1,400})\.(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(cookieValue);
  if (!m) return null;
  const [, emailB64, expStr, mac] = m as unknown as [string, string, string, string];
  if (Number(expStr) < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmacSha256B64url(secret(env), `local-admin:${emailB64}.${expStr}`);
  if (!timingSafeEqual(expected, mac)) return null;
  let email: string;
  try {
    email = new TextDecoder().decode(b64urlDecode(emailB64)).toLowerCase();
  } catch {
    return null;
  }
  return adminEmails(env).has(email) ? email : null;
}

export function sessionCookie(value: string): string {
  // No "Secure" flag: localhost is plain http. HttpOnly + SameSite=Strict.
  return `${LOCAL_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearCookie(): string {
  return `${LOCAL_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** Only allow redirects back into the admin area (no open redirects). */
export function safeNext(next: string | undefined | null): string {
  return next && !next.includes('..') && /^\/admin(\/[A-Za-z0-9/_\-?=&.%]*)?$/.test(next) ? next : '/admin/';
}
