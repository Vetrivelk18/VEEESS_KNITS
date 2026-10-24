import { describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { createLocalSession, readLocalSession, safeNext } from '../worker/lib/localauth';
import type { Env } from '../worker/lib/env';

const assets = { fetch: async () => new Response('<h1>admin page</h1>', { status: 200, headers: { 'Content-Type': 'text/html' } }) };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

function env(over: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'development',
    LOCAL_ADMIN_BYPASS: '1',
    ADMIN_EMAILS: 'admin1@example.com,admin2@example.com',
    DEV_ADMIN_EMAIL: 'admin1@example.com',
    ORDER_LINK_SECRET: 'test-order-link-secret-0123456789abcdef',
    SITE_URL: 'http://localhost:8787',
    ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
    ACCESS_AUD: 'aud',
    VAPID_PUBLIC_KEY: '',
    ASSETS: assets,
    ...over,
  } as unknown as Env;
}

const call = (e: Env, url: string, init: RequestInit = {}) => worker.fetch(new Request(url, { redirect: 'manual', ...init }), e, ctx);

async function signIn(e: Env, email = 'admin1@example.com', host = 'http://localhost:8787'): Promise<string> {
  const body = new URLSearchParams({ email, next: '/admin/' });
  const res = await call(e, `${host}/__local/login`, { method: 'POST', body, headers: { Origin: host, 'Content-Type': 'application/x-www-form-urlencoded' } });
  expect(res.status).toBe(303);
  return (res.headers.get('Set-Cookie') ?? '').split(';')[0]!;
}

describe('local admin sign-in (development on localhost)', () => {
  it('redirects admin pages to the local sign-in page, like Cloudflare Access does', async () => {
    const res = await call(env(), 'http://localhost:8787/admin/products/');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/__local/login?next=%2Fadmin%2Fproducts%2F');
  });

  it('shows the sign-in page with the admin emails', async () => {
    const res = await call(env(), 'http://localhost:8787/__local/login');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('LOCAL TESTING ONLY');
    expect(html).toContain('admin2@example.com');
  });

  it('signs in, opens the admin API and pages, then signs out', async () => {
    const e = env();
    const cookie = await signIn(e, 'admin2@example.com');
    const me = await call(e, 'http://localhost:8787/api/admin/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'admin2@example.com', authMode: 'local', logoutUrl: '/__local/logout' });
    const page = await call(e, 'http://localhost:8787/admin/', { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    const out = await call(e, 'http://localhost:8787/__local/logout', { headers: { Cookie: cookie } });
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('works on 127.0.0.1 too', async () => {
    const e = env();
    const cookie = await signIn(e, 'admin1@example.com', 'http://127.0.0.1:8787');
    const me = await call(e, 'http://127.0.0.1:8787/api/admin/me', { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
  });

  it('rejects emails that are not in ADMIN_EMAILS', async () => {
    const e = env();
    const res = await call(e, 'http://localhost:8787/__local/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'intruder@example.com' }),
      headers: { Origin: 'http://localhost:8787', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.headers.get('Location')).toContain('error=1');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });

  it('blocks a sign-in form posted from another site', async () => {
    const res = await call(env(), 'http://localhost:8787/__local/login', {
      method: 'POST',
      body: new URLSearchParams({ email: 'admin1@example.com' }),
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects tampered, forged or expired session cookies', async () => {
    const e = env();
    const cookie = await signIn(e);
    const value = cookie.split('=')[1]!;
    const forgedEmail = Buffer.from('admin2@example.com').toString('base64url');
    const forged = `vk_local_admin=${forgedEmail}.${value.split('.')[1]}.${value.split('.')[2]}`;
    expect((await call(e, 'http://localhost:8787/api/admin/me', { headers: { Cookie: forged } })).status).toBe(401);
    expect((await call(e, 'http://localhost:8787/api/admin/me', { headers: { Cookie: 'vk_local_admin=garbage' } })).status).toBe(401);
    const expired = `${Buffer.from('admin1@example.com').toString('base64url')}.1000000000.${'A'.repeat(43)}`;
    expect(await readLocalSession(e, expired)).toBeNull();
  });

  it('drops a session if the email is later removed from ADMIN_EMAILS', async () => {
    const value = await createLocalSession(env(), 'admin2@example.com');
    expect(await readLocalSession(env({ ADMIN_EMAILS: 'admin1@example.com' }), value)).toBeNull();
  });

  it('only redirects back into /admin (no open redirect)', () => {
    expect(safeNext('/admin/products/')).toBe('/admin/products/');
    expect(safeNext('https://evil.example')).toBe('/admin/');
    expect(safeNext('//evil.example')).toBe('/admin/');
    expect(safeNext('/admin/../shop')).toBe('/admin/');
    expect(safeNext('/administrator')).toBe('/admin/');
    expect(safeNext('/admin/?order=abc-123')).toBe('/admin/?order=abc-123');
  });
});

describe('local sign-in can never work on the live site', () => {
  it('is off in production even with LOCAL_ADMIN_BYPASS=1, on localhost, with a valid cookie', async () => {
    const dev = env();
    const cookie = await signIn(dev);
    const prod = env({ ENVIRONMENT: 'production' });
    expect((await call(prod, 'http://localhost:8787/api/admin/me', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await call(prod, 'http://localhost:8787/__local/login')).status).toBe(404);
    const page = await call(prod, 'http://localhost:8787/admin/');
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('Cloudflare Access'); // no local hints in production
  });

  it('gives no local troubleshooting details in production API errors', async () => {
    const res = await call(env({ ENVIRONMENT: 'production' }), 'https://www.veeessknits.com/api/admin/me');
    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty('localHelp');
  });

  it('is off on a real domain even in development', async () => {
    const e = env();
    expect((await call(e, 'https://www.veeessknits.com/__local/login')).status).toBe(404);
    const res = await call(e, 'https://www.veeessknits.com/api/admin/me');
    expect(res.status).toBe(401);
  });

  it('is off without the explicit LOCAL_ADMIN_BYPASS=1 opt-in, and explains why', async () => {
    const e = env({ LOCAL_ADMIN_BYPASS: undefined });
    const page = await call(e, 'http://localhost:8787/admin/');
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('LOCAL_ADMIN_BYPASS is not set to 1');
    const api = await call(e, 'http://localhost:8787/api/admin/me');
    expect(((await api.json()) as { localHelp: string[] }).localHelp[0]).toContain('LOCAL_ADMIN_BYPASS');
  });

  it('a missing .dev.vars (production defaults) is explained locally', async () => {
    // Without .dev.vars, wrangler uses wrangler.jsonc: ENVIRONMENT=production → Access only.
    const e = env({ ENVIRONMENT: 'production', LOCAL_ADMIN_BYPASS: undefined });
    const page = await call(e, 'http://localhost:8787/admin/');
    expect(page.status).toBe(401);
  });
});
