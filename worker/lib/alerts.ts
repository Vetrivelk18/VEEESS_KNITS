import type { Env } from './env';
import { pushToAdmins } from './webpush';
import { adminBackupAlert, customerConfirmation, emailList, sendEmail, shippedEmail } from './email';
import { courierById } from '../../shared/couriers';
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

/**
 * "Your order has shipped" email. Sent at most once per order: the
 * shipped_email_at claim makes a repeated call (retry, double tap) a no-op,
 * and it is cleared again if sending fails.
 */
export async function sendShippedEmail(env: Env, orderId: string): Promise<boolean> {
  const claim = await env.DB.prepare(
    `UPDATE orders SET shipped_email_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1 AND status = 'shipped' AND shipped_email_at IS NULL AND tracking_number IS NOT NULL`,
  )
    .bind(orderId)
    .run();
  if (!claim.meta.changes) return false;
  const o = await env.DB.prepare(
    `SELECT o.number, o.tracking_number, o.courier, COALESCE(o.contact_name, c.name) AS customer_name, COALESCE(o.contact_email, c.email) AS customer_email
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?1`,
  )
    .bind(orderId)
    .first<{ number: number; tracking_number: string; courier: string | null; customer_name: string; customer_email: string }>();
  if (!o?.customer_email) return false;
  const courier = courierById(o.courier);
  const token = await signOrderToken(env.ORDER_LINK_SECRET, orderId);
  const url = `${env.SITE_URL.replace(/\/$/, '')}/order/?id=${encodeURIComponent(orderId)}&t=${encodeURIComponent(token)}`;
  const m = shippedEmail(o, courier?.name ?? 'our courier', courier?.trackUrl ?? null, o.tracking_number, url);
  const sent = await sendEmail(env, o.customer_email, m.subject, m.html, m.text);
  // Only record it as sent if it really went out (e.g. no email key locally).
  if (!sent) await env.DB.prepare('UPDATE orders SET shipped_email_at = NULL WHERE id = ?1').bind(orderId).run();
  return sent;
}
