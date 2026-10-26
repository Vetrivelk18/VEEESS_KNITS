import type { Env } from './env';
import { pushToAdmins } from './webpush';
import { adminBackupAlert, customerConfirmation, emailList, sendEmail } from './email';
import { signOrderToken } from './crypto';

/**
 * Fan out a new order: Web Push to admin devices, backup email to admins,
 * confirmation email to the customer. Runs in the background (waitUntil) so
 * the shopper never waits for it. The in-panel bell reads the notifications
 * table directly, so it works even if push/email fail.
 */
export async function dispatchNewOrder(env: Env, orderId: string): Promise<void> {
  const n = await env.DB.prepare("SELECT title, body FROM notifications WHERE type = 'new_order' AND order_id = ?1")
    .bind(orderId)
    .first<{ title: string; body: string }>();
  if (!n) return;

  const tasks: Promise<unknown>[] = [pushToAdmins(env)];

  const adminUrl = `${env.SITE_URL.replace(/\/$/, '')}/admin/?order=${encodeURIComponent(orderId)}`;
  const a = adminBackupAlert(n.title, n.body, adminUrl);
  const alertTo = emailList(env.ALERT_EMAIL_TO);
  if (alertTo.length) tasks.push(sendEmail(env, alertTo, a.subject, a.html, a.text));

  const o = await env.DB.prepare(
    `SELECT o.number, o.total_paise, o.payment_method, COALESCE(o.contact_name, c.name) AS customer_name, COALESCE(o.contact_email, c.email) AS customer_email
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?1`,
  )
    .bind(orderId)
    .first<{ number: number; total_paise: number; payment_method: string; customer_name: string; customer_email: string }>();
  if (o) {
    const { results: items } = await env.DB.prepare('SELECT product_name, variant_label, qty, unit_price_paise FROM order_items WHERE order_id = ?1')
      .bind(orderId)
      .all<{ product_name: string; variant_label: string; qty: number; unit_price_paise: number }>();
    const token = await signOrderToken(env.ORDER_LINK_SECRET, orderId);
    const url = `${env.SITE_URL.replace(/\/$/, '')}/order/?id=${encodeURIComponent(orderId)}&t=${encodeURIComponent(token)}`;
    const m = customerConfirmation({ ...o, items }, url);
    tasks.push(sendEmail(env, o.customer_email, m.subject, m.html, m.text));
  }
  await Promise.allSettled(tasks);
}

/** Cron: re-alert once for new-order alerts still unread after 15 minutes. */
export async function realertUnread(env: Env): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE notifications SET realerted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE read_at IS NULL AND realerted_at IS NULL
        AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')`,
  ).run();
  const n = res.meta.changes ?? 0;
  if (n > 0) await pushToAdmins(env);
  return n;
}
