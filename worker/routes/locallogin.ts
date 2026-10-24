import { Hono } from 'hono';
import { adminEmails, type Env } from '../lib/env';
import { clearCookie, createLocalSession, localAdminStatus, safeNext, sessionCookie } from '../lib/localauth';

/**
 * /__local/login and /__local/logout — LOCAL TESTING ONLY.
 * Stands in for the Cloudflare Access sign-in screen on localhost.
 * Returns 404 unless local sign-in is enabled (never on the live site).
 */
export const localLogin = new Hono<{ Bindings: Env }>();

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

localLogin.use('*', async (c, next) => {
  if (!localAdminStatus(c.env, c.req.raw).enabled) return c.text('Not found', 404);
  await next();
  c.header('Content-Security-Policy', CSP);
  c.header('Cache-Control', 'no-store');
});

localLogin.get('/login', (c) => {
  const next = safeNext(c.req.query('next'));
  const emails = [...adminEmails(c.env)];
  const preferred = (c.env.DEV_ADMIN_EMAIL ?? '').toLowerCase();
  const error = c.req.query('error') === '1';
  const options = emails
    .map(
      (e, i) =>
        `<label style="display:flex;gap:10px;align-items:center;padding:12px;border:1px solid #DAD8D0;border-radius:6px;margin-bottom:8px;background:#fff;cursor:pointer">
          <input type="radio" name="email" value="${esc(e)}" ${e === preferred || (!preferred && i === 0) ? 'checked' : ''} style="width:18px;height:18px"> ${esc(e)}</label>`,
    )
    .join('');
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Local admin sign-in</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;background:#F6F5F1;color:#14161F">
<div style="background:#F2B233;padding:10px 16px;text-align:center;font-weight:600;font-size:14px">LOCAL TESTING ONLY · This page replaces Cloudflare Access on your computer. It does not exist on the live site.</div>
<main style="max-width:440px;margin:40px auto;padding:0 16px">
  <h1 style="font-size:26px;margin:0 0 6px">Sign in to Veeess Admin</h1>
  <p style="color:#4A4F5C;margin:0 0 20px">Choose which admin to act as. Emails come from <code>ADMIN_EMAILS</code>.</p>
  ${error ? '<p role="alert" style="background:#fdf0ef;border:1px solid #f0b4ae;padding:10px;border-radius:6px">That email is not in ADMIN_EMAILS.</p>' : ''}
  <form method="post" action="/__local/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <fieldset style="border:0;padding:0;margin:0 0 16px"><legend style="font-weight:600;margin-bottom:8px">Admin email</legend>${options}</fieldset>
    <button type="submit" style="width:100%;height:48px;border:0;border-radius:4px;background:#14161F;color:#fff;font-size:16px;font-weight:600;cursor:pointer">Sign in (local test)</button>
  </form>
  <p style="color:#5A5F6E;font-size:13px;margin-top:20px">Your session lasts 8 hours or until you restart <code>npm run dev</code>.</p>
</main></body></html>`);
});

localLogin.post('/login', async (c) => {
  // Same-origin check: the form must be submitted from this local site.
  const origin = c.req.header('Origin');
  if (origin && origin !== new URL(c.req.url).origin) return c.text('Cross-site request blocked.', 403);
  const form = await c.req.parseBody();
  const email = String(form.email ?? '').trim().toLowerCase();
  const next = safeNext(String(form.next ?? ''));
  if (!adminEmails(c.env).has(email)) return c.redirect(`/__local/login?error=1&next=${encodeURIComponent(next)}`, 303);
  c.header('Set-Cookie', sessionCookie(await createLocalSession(c.env, email)));
  console.log(`[local] signed in as ${email}`);
  return c.redirect(next, 303);
});

localLogin.get('/logout', (c) => {
  c.header('Set-Cookie', clearCookie());
  return c.redirect('/__local/login', 303);
});
