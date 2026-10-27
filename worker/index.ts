import { Hono } from 'hono';
import type { Env } from './lib/env';
import { errorResponse, sameOriginWrites, securityHeaders } from './lib/http';
import { publicApi } from './routes/public';
import { adminApi } from './routes/admin';
import { localLogin } from './routes/locallogin';
import { requireAdmin, type AdminVars } from './lib/access';
import { runScheduled } from './cron';

const app = new Hono<{ Bindings: Env; Variables: AdminVars }>();

app.use('*', securityHeaders);
app.use('/api/*', sameOriginWrites);
app.onError((err, c) => errorResponse(c, err));
app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not_found' }, 404) : c.env.ASSETS.fetch(c.req.raw)));

app.get('/api/health', async (c) => {
  // Used by the uptime monitor: checks the database answers.
  const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
  return c.json({ ok: row?.ok === 1, time: new Date().toISOString() });
});

app.route('/__local', localLogin); // local testing only; 404 on the live site
app.route('/api/admin', adminApi);
app.route('/api', publicApi);

/** Admin-uploaded product photos and size charts from R2. Only these exact
 *  key shapes are public; everything else in the bucket (e.g. backups) is not. */
export const PUBLIC_MEDIA_KEY = /^(products\/\d+|size-charts)\/[0-9a-f-]{36}\.(jpg|png|webp)$/;
app.get('/media/*', async (c) => {
  const key = decodeURIComponent(c.req.path.slice('/media/'.length));
  if (!PUBLIC_MEDIA_KEY.test(key)) return c.text('Not found', 404);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.text('Not found', 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(obj.body, { headers });
});

/** Admin pages: static HTML, but only served after the admin check passes. */
app.use('/admin', requireAdmin);
app.use('/admin/*', requireAdmin);
app.get('/admin/*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-store');
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
});
app.get('/admin', (c) => c.redirect('/admin/', 301));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(event.cron, env));
  },
} satisfies ExportedHandler<Env>;
