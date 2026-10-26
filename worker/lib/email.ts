import type { Env } from './env';
import { formatINR, orderLabel } from './money';

/** Escape text before putting it in HTML email (customer names are user input). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

/** Comma-separated address list (e.g. ALERT_EMAIL_TO) → clean, de-duplicated array (max 10). */
export function emailList(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((e) => e.trim()).filter((e) => /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(e)))].slice(0, 10);
}

export async function sendEmail(env: Env, to: string | string[], subject: string, html: string, text: string): Promise<boolean> {
  const recipients = Array.isArray(to) ? to : [to];
  if (!recipients.length) return false;
  if (!env.RESEND_API_KEY) {
    console.log(`[email skipped: no RESEND_API_KEY] to=${recipients.map((r) => r.replace(/(.).*@/, '$1***@')).join(',')} subject="${subject}"`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients, subject, html, text }),
    });
    if (!res.ok) console.error('Email send failed', res.status);
    return res.ok;
  } catch (err) {
    console.error('Email send error', err instanceof Error ? err.message : err);
    return false;
  }
}

interface EmailOrder {
  number: number;
  total_paise: number;
  payment_method: string;
  customer_name: string;
  customer_email: string;
  items: { product_name: string; variant_label: string; qty: number; unit_price_paise: number }[];
}

export function customerConfirmation(o: EmailOrder, orderUrl: string) {
  const label = orderLabel(o.number);
  const pay = o.payment_method === 'cod' ? `Cash on delivery — please keep ${formatINR(o.total_paise)} ready. No extra charge.` : `Paid online: ${formatINR(o.total_paise)}`;
  const rows = o.items
    .map((i) => `<tr><td>${escapeHtml(i.product_name)}<br><small>${escapeHtml(i.variant_label)}</small></td><td>× ${i.qty}</td><td>${formatINR(i.unit_price_paise * i.qty)}</td></tr>`)
    .join('');
  const html = `<div style="font-family:Arial,sans-serif;color:#14161F;max-width:560px">
<h2>Thank you, ${escapeHtml(o.customer_name.split(' ')[0] ?? '')}! Your order ${label} is confirmed.</h2>
<table cellpadding="6" style="border-collapse:collapse;width:100%">${rows}</table>
<p><strong>Total: ${formatINR(o.total_paise)}</strong><br>${escapeHtml(pay)}</p>
<p><a href="${escapeHtml(orderUrl)}">View your order status</a></p>
<p style="color:#5A5F6E;font-size:13px">Veeess Knits · Gandhi Nagar, Tiruppur 641603</p></div>`;
  const text = `Your order ${label} is confirmed.\n${o.items.map((i) => `${i.product_name} (${i.variant_label}) x${i.qty}`).join('\n')}\nTotal: ${formatINR(o.total_paise)}\n${pay}\nTrack: ${orderUrl}`;
  return { subject: `Order ${label} confirmed — Veeess Knits`, html, text };
}

export function adminBackupAlert(title: string, body: string, adminUrl: string) {
  // No address or phone in the email either: open the admin panel for details.
  const html = `<div style="font-family:Arial,sans-serif"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(adminUrl)}">Open admin panel</a></p></div>`;
  return { subject: title, html, text: `${title}\n${body}\n${adminUrl}` };
}
