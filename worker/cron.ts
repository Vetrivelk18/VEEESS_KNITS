import type { Env } from './lib/env';
import { reconcileAndExpire } from './lib/orders';
import { realertUnread } from './lib/alerts';
import { purgeOldRateLimits } from './lib/ratelimit';

const BACKUP_TABLES = [
  'brands', 'categories', 'products', 'product_variants', 'product_images', 'customers', 'addresses',
  'orders', 'order_items', 'payments', 'notifications', 'audit_log', 'settings',
];

export async function runScheduled(cron: string, env: Env): Promise<void> {
  if (cron === '0 21 * * SUN') {
    await weeklyBackup(env);
    return;
  }
  const r = await reconcileAndExpire(env);
  const realerted = await realertUnread(env);
  await purgeOldRateLimits(env.DB);
  console.log(JSON.stringify({ job: 'every15', ...r, realerted }));
}

/**
 * Weekly JSON export of every business table to R2 (private, under backups/).
 * This is in addition to D1 Time Travel (point-in-time restore).
 */
export async function weeklyBackup(env: Env): Promise<string> {
  const dump: Record<string, unknown[]> = {};
  for (const t of BACKUP_TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    dump[t] = results;
  }
  const key = `backups/${new Date().toISOString().slice(0, 10)}.json`;
  await env.MEDIA.put(key, JSON.stringify({ createdAt: new Date().toISOString(), tables: dump }), {
    httpMetadata: { contentType: 'application/json' },
  });
  // Keep the last 12 weekly backups.
  const list = await env.MEDIA.list({ prefix: 'backups/' });
  const old = list.objects.map((o) => o.key).sort().slice(0, -12);
  for (const k of old) await env.MEDIA.delete(k);
  console.log(JSON.stringify({ job: 'backup', key, removed: old.length }));
  return key;
}
