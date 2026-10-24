import { api, el, formatINR, HttpError, setChildren, toast, $ } from '../util';
import { poll, timeAgo } from './shell';
import { currentSubscription, disablePush, enablePush, pushSupported } from './push';

interface Row {
  id: string; label: string; status: string; payment_method: string; total_paise: number; created_at: string; needs_attention: string | null;
  customer_name: string; item_count: number; pay_method: string | null; notification_id: number | null; read_at: string | null;
}
interface Counts { new_count: number; cod_count: number; pack_count: number; packed_count: number; shipped_count: number; attention_count: number }

const STATUS: Record<string, string> = {
  created: 'Awaiting payment', paid: 'Paid', cod_pending: 'COD to confirm', confirmed: 'Confirmed', packed: 'Packed', shipped: 'Shipped',
  delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded', expired: 'Expired', failed: 'Failed',
};
const FILTERS: [string, string, keyof Counts | null][] = [
  ['all', 'All', null], ['new', 'New', 'new_count'], ['cod', 'COD to confirm', 'cod_count'], ['pack', 'To pack', 'pack_count'],
  ['packed', 'Packed', 'packed_count'], ['shipped', 'Shipped', 'shipped_count'], ['attention', 'Needs attention', 'attention_count'], ['closed', 'Closed', null],
];

let filter = 'all';
let q = '';
let openId: string | null = null;

function payLabel(r: { payment_method: string; pay_method: string | null }) {
  if (r.payment_method === 'cod') return 'COD';
  const m = (r.pay_method ?? '').toLowerCase();
  return m === 'upi' ? 'UPI' : m === 'card' ? 'Card' : m === 'netbanking' ? 'Netbanking' : m === 'wallet' ? 'Wallet' : 'Online';
}

async function load() {
  const params = new URLSearchParams({ filter });
  if (q) params.set('q', q);
  let data: { orders: Row[]; counts: Counts };
  try {
    data = await api(`/api/admin/orders?${params}`);
  } catch (e) {
    setChildren($('[data-rows]'), el('tr', {}, el('td', { colspan: 8 }, e instanceof HttpError ? e.message : 'Could not load orders.')));
    return;
  }
  const c = data.counts;
  $('[data-summary-line]').textContent = `${c.new_count} new since you last checked · ${c.cod_count} cash-on-delivery order${c.cod_count === 1 ? '' : 's'} to confirm · ${c.pack_count} to pack`;
  setChildren(
    $('[data-filters]'),
    ...FILTERS.map(([key, label, ck]) =>
      el('button', { type: 'button', class: 'chip', 'aria-pressed': String(filter === key), onclick: () => { filter = key; load(); } }, label, ck ? el('span', { class: 'count' }, String(c[ck])) : null),
    ),
  );
  const rows = data.orders;
  if (!rows.length) {
    setChildren($('[data-rows]'), el('tr', {}, el('td', { colspan: 8, class: 'muted', style: 'text-align:center;padding:32px' }, 'No orders in this view.')));
    return;
  }
  setChildren(
    $('[data-rows]'),
    ...rows.map((r) => {
      const unread = r.notification_id && !r.read_at;
      const act = primaryAction(r);
      return el(
        'tr',
        { class: unread ? 'unread' : '', tabindex: 0, onclick: () => openDrawer(r.id), onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') openDrawer(r.id); } },
        el('td', { style: 'font-weight:600;white-space:nowrap' }, unread ? el('span', { class: 'newdot', 'aria-label': 'New' }) : null, r.label, r.needs_attention ? el('span', { class: 'attn' }, 'Needs attention') : null),
        el('td', { class: 'muted', style: 'white-space:nowrap' }, timeAgo(r.created_at)),
        el('td', {}, r.customer_name),
        el('td', {}, String(r.item_count)),
        el('td', { style: 'font-weight:600' }, formatINR(r.total_paise)),
        el('td', {}, el('span', { class: `pay-s${r.payment_method === 'cod' ? ' cod' : ''}` }, payLabel(r))),
        el('td', {}, el('span', { class: `pill-s st-${r.status}` }, STATUS[r.status] ?? r.status)),
        el('td', { style: 'text-align:right;white-space:nowrap' },
          act ? el('button', { type: 'button', class: `btn btn-sm${act.primary ? '' : ' btn-outline'}`, onclick: (e: Event) => { e.stopPropagation(); act.run(); } }, act.label) : el('button', { type: 'button', class: 'btn btn-sm btn-outline', onclick: (e: Event) => { e.stopPropagation(); openDrawer(r.id); } }, 'View')),
      );
    }),
  );
}

function primaryAction(r: Row): { label: string; primary: boolean; run: () => void } | null {
  if (r.status === 'cod_pending') return { label: 'Confirm COD', primary: true, run: () => setStatus(r.id, 'confirmed') };
  if (r.status === 'paid' || r.status === 'confirmed') return { label: 'Mark packed', primary: false, run: () => setStatus(r.id, 'packed') };
  if (r.status === 'packed') return { label: 'Ship…', primary: false, run: () => openDrawer(r.id) };
  if (r.status === 'shipped') return { label: 'Mark delivered', primary: false, run: () => setStatus(r.id, 'delivered') };
  return null;
}

async function setStatus(id: string, status: string, trackingNumber?: string) {
  try {
    await api(`/api/admin/orders/${id}`, { method: 'PATCH', body: { status, trackingNumber } });
    toast(`Order marked ${STATUS[status]?.toLowerCase() ?? status}.`);
    await Promise.all([load(), poll()]);
    if (openId === id) openDrawer(id);
  } catch (e) {
    toast(e instanceof HttpError ? e.message : 'Could not update the order.');
  }
}

async function refund(id: string) {
  try {
    await api(`/api/admin/orders/${id}/refund`, { body: {} });
    toast('Refund issued through Razorpay.');
    await load();
    openDrawer(id);
  } catch (e) {
    toast(e instanceof HttpError ? e.message : 'Refund failed.');
  }
}

/** Two-step button for destructive actions (no browser pop-ups). */
function confirmButton(label: string, confirmLabel: string, cls: string, run: () => void) {
  const b = el('button', { type: 'button', class: cls }, label);
  let armed = false;
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.textContent = confirmLabel;
      b.classList.add('danger');
      setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('danger'); }, 4000);
      return;
    }
    b.disabled = true;
    run();
  });
  return b;
}

function closeDrawer() {
  openId = null;
  setChildren($('[data-drawer-root]'));
  const u = new URL(location.href);
  u.searchParams.delete('order');
  history.replaceState(null, '', u);
}

async function openDrawer(id: string) {
  openId = id;
  const u = new URL(location.href);
  u.searchParams.set('order', id);
  history.replaceState(null, '', u);
  let o: Record<string, unknown> & { items: { product_name: string; variant_label: string; qty: number; unit_price_paise: number }[]; payments: Record<string, unknown>[]; history: { admin_email: string; action: string; created_at: string }[] };
  try {
    o = await api(`/api/admin/orders/${id}`);
  } catch (e) {
    toast(e instanceof HttpError ? e.message : 'Could not open the order.');
    return;
  }
  const s = String(o.status);
  const cod = o.payment_method === 'cod';
  const actions: Node[] = [];
  if (s === 'cod_pending') actions.push(el('button', { type: 'button', class: 'btn btn-sm', onclick: () => setStatus(id, 'confirmed') }, 'Confirm COD order'));
  if (s === 'paid' || s === 'confirmed') actions.push(el('button', { type: 'button', class: 'btn btn-sm', onclick: () => setStatus(id, 'packed') }, 'Mark packed'));
  if (s === 'packed') {
    const input = el('input', { class: 'inline-input', placeholder: 'Courier tracking no.', 'aria-label': 'Tracking number', maxlength: 60 });
    actions.push(el('div', { style: 'display:flex;gap:8px;width:100%' }, input, el('button', { type: 'button', class: 'btn btn-sm', onclick: () => setStatus(id, 'shipped', (input as HTMLInputElement).value.trim()) }, 'Mark shipped')));
  }
  if (s === 'shipped') actions.push(el('button', { type: 'button', class: 'btn btn-sm', onclick: () => setStatus(id, 'delivered') }, 'Mark delivered'));
  if (cod && ['cod_pending', 'confirmed', 'packed'].includes(s)) actions.push(confirmButton('Cancel order', 'Tap again to cancel', 'btn btn-sm btn-outline', () => setStatus(id, 'cancelled')));
  if (!cod && ['paid', 'packed', 'shipped', 'delivered'].includes(s)) actions.push(confirmButton(`Refund ${formatINR(Number(o.total_paise))}`, 'Tap again to refund', 'btn btn-sm btn-outline', () => refund(id)));

  const phone = String(o.customer_phone);
  const drawer = el(
    'aside',
    { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Order ${o.label}` },
    el('div', { class: 'drawer-head' },
      el('div', {}, el('strong', { style: 'font-size:18px' }, String(o.label)), ' ', el('span', { class: `pill-s st-${s}` }, STATUS[s] ?? s)),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: closeDrawer }, '✕')),
    el('div', { class: 'drawer-body' },
      o.needs_attention ? el('div', { class: 'notice bad' }, String(o.needs_attention)) : null,
      actions.length ? el('div', { class: 'actions' }, ...actions) : null,
      el('div', { class: 'card' },
        el('strong', {}, 'Customer'),
        el('dl', { class: 'kv', style: 'margin:10px 0 0' },
          el('dt', {}, 'Name'), el('dd', {}, String(o.customer_name)),
          el('dt', {}, 'Phone'), el('dd', {}, el('a', { href: `tel:+91${phone}` }, `+91 ${phone}`), ' · ', el('a', { href: `https://wa.me/91${phone}`, target: '_blank', rel: 'noopener noreferrer' }, 'WhatsApp')),
          el('dt', {}, 'Email'), el('dd', {}, String(o.customer_email)),
          el('dt', {}, 'Address'), el('dd', {}, [o.line1, o.line2, `${o.city}, ${o.state} ${o.pincode}`].filter(Boolean).join(', ')),
        )),
      el('div', { class: 'card' },
        el('strong', {}, 'Items'),
        ...o.items.map((i) => el('div', { class: 'r', style: 'display:flex;justify-content:space-between;gap:8px;margin-top:8px;font-size:14px' }, el('span', {}, `${i.product_name} · ${i.variant_label} × ${i.qty}`), el('span', {}, formatINR(i.unit_price_paise * i.qty)))),
        el('div', { style: 'display:flex;justify-content:space-between;margin-top:10px;border-top:1px solid var(--line);padding-top:8px;font-size:14px' }, el('span', {}, 'Shipping'), el('span', {}, Number(o.shipping_paise) ? formatINR(Number(o.shipping_paise)) : 'Free')),
        el('div', { style: 'display:flex;justify-content:space-between;font-weight:700' }, el('span', {}, 'Total'), el('span', {}, formatINR(Number(o.total_paise)))),
      ),
      el('div', { class: 'card' },
        el('strong', {}, 'Payment'),
        el('dl', { class: 'kv', style: 'margin:10px 0 0' },
          el('dt', {}, 'Method'), el('dd', {}, cod ? 'Cash on delivery (no extra charge)' : 'Online via Razorpay'),
          ...(o.payments.length ? o.payments.flatMap((p) => [el('dt', {}, String(p.source)), el('dd', {}, `${p.razorpay_payment_id} · ${p.status} · ${formatINR(Number(p.amount_paise))}${p.method ? ' · ' + p.method : ''}`)]) : []),
          o.razorpay_order_id ? el('dt', {}, 'Razorpay order') : null, o.razorpay_order_id ? el('dd', {}, String(o.razorpay_order_id)) : null,
          o.tracking_number ? el('dt', {}, 'Tracking') : null, o.tracking_number ? el('dd', {}, String(o.tracking_number)) : null,
        )),
      el('div', { class: 'card' },
        el('strong', {}, 'History'),
        el('div', { class: 'hist', style: 'margin-top:8px' },
          el('span', {}, `Placed ${new Date(String(o.created_at)).toLocaleString('en-IN')}`),
          ...o.history.map((h) => el('span', {}, `${new Date(h.created_at).toLocaleString('en-IN')} · ${h.action.replace('order.', '')} by ${h.admin_email}`)),
        )),
    ),
  );
  setChildren($('[data-drawer-root]'), el('div', { class: 'drawer-bg', onclick: closeDrawer }), drawer);
  // Mark this order's alert read (shared across admins).
  api('/api/admin/notifications').then((r: unknown) => {
    const items = (r as { items: { id: number; order_id: string; read_at: string | null }[] }).items;
    const ids = items.filter((n) => n.order_id === id && !n.read_at).map((n) => n.id);
    if (ids.length) return api('/api/admin/notifications/read', { body: { ids } }).then(() => { poll(); load(); });
  }).catch(() => {});
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openId) closeDrawer();
});
window.addEventListener('admin:refresh', () => load());
window.addEventListener('admin:open-order', (e) => openDrawer((e as CustomEvent<string>).detail));
($('[data-search]') as HTMLFormElement).addEventListener('submit', (e) => {
  e.preventDefault();
  q = (($('[data-search] input') as HTMLInputElement).value ?? '').trim();
  filter = 'all';
  load();
});
($('[data-search] input') as HTMLInputElement).addEventListener('search', (e) => {
  if (!(e.target as HTMLInputElement).value) { q = ''; load(); }
});

// Device alert switch
const sw = $('[data-push-switch]');
const note = $('[data-push-note]');
async function syncSwitch() {
  const sub = await currentSubscription().catch(() => null);
  sw.setAttribute('aria-checked', String(Boolean(sub) && Notification.permission === 'granted'));
  if (!pushSupported()) note.textContent = 'In-panel alerts + chime only on this browser';
}
sw.addEventListener('click', async () => {
  const on = sw.getAttribute('aria-checked') === 'true';
  if (on) {
    await disablePush();
    toast('Alerts turned off for this device.');
  } else {
    try {
      const r = await enablePush();
      toast(r.message);
    } catch {
      toast('Could not turn on alerts. Try again.');
    }
  }
  syncSwitch();
});
syncSwitch();

load();
const initial = new URLSearchParams(location.search).get('order');
if (initial && /^[0-9a-f-]{36}$/.test(initial)) openDrawer(initial);
