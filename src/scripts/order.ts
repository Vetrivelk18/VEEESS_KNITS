import { api, el, formatINR, setChildren, $ } from './util';
import { courierById } from '../../shared/couriers';

interface Order {
  label: string; status: string; payment_method: string; subtotal_paise: number; shipping_paise: number; total_paise: number;
  tracking_number: string | null; courier: string | null; created_at: string; name: string; line1: string; line2: string; city: string; state: string; pincode: string;
  items: { product_name: string; variant_label: string; qty: number; unit_price_paise: number }[];
}

const root = $('[data-order]');
const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
const token = params.get('t') ?? '';
const isNew = params.get('new') === '1';

const LABELS: Record<string, string> = {
  created: 'Awaiting payment', paid: 'Order confirmed', cod_pending: 'Order placed', confirmed: 'Order confirmed', packed: 'Packed',
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded', expired: 'Payment not completed', failed: 'Payment not completed',
};
const STEP = (s: string) => (['created', 'cod_pending', 'paid', 'confirmed'].includes(s) ? 1 : s === 'packed' ? 2 : s === 'shipped' ? 3 : s === 'delivered' ? 4 : 0);

function trackingBox(tracking: string, courierId: string | null): HTMLElement {
  const courier = courierById(courierId);
  const copy = el('button', { type: 'button', class: 'btn btn-sm btn-outline' }, 'Copy') as HTMLButtonElement;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(tracking);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Select and copy the number';
    }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2500);
  });
  return el('div', { class: 'notice track-box', style: 'margin-top:16px' },
    el('div', {}, el('strong', {}, 'Shipped with ', courier && courier.id !== 'other' ? courier.name : 'our courier')),
    el('div', { class: 'track-row' }, el('span', {}, 'Tracking number: ', el('strong', { class: 'track-no' }, tracking)), copy),
    courier?.trackUrl
      ? el('div', {}, el('a', { class: 'btn btn-sm', href: courier.trackUrl, target: '_blank', rel: 'noopener noreferrer' }, `Track on ${courier.name} →`),
          el('p', { class: 'muted small', style: 'margin:8px 0 0' }, `Copy the number, then paste it on the ${courier.name} page.`))
      : el('p', { class: 'muted small', style: 'margin:0' }, 'Call or WhatsApp +91 96005 77555 if you need help tracking your parcel.'),
  );
}

async function load(tries = 0) {
  let o: Order;
  try {
    o = await api<Order>(`/api/orders/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`);
  } catch {
    root.replaceChildren(el('div', { class: 'empty', style: 'margin-top:32px' }, el('p', {}, 'We could not find this order, or the link has expired. Please use the link in your confirmation email, or call +91 96005 77555.')));
    return;
  }
  // Payment confirmations can take a few seconds: poll briefly.
  if (o.status === 'created' && tries < 6) setTimeout(() => load(tries + 1), 3000);
  const step = STEP(o.status);
  const cod = o.payment_method === 'cod';
  setChildren(root,
    el('div', { class: 'page-title' },
      el('span', { class: 'eyebrow' }, `Order ${o.label}`),
      el('h1', { class: 'display h2', style: 'margin-top:8px' }, isNew && step === 1 ? `Thank you, ${o.name.split(' ')[0]}! Your order is placed.` : LABELS[o.status] ?? o.status),
      el('p', { class: 'muted' }, cod ? `Cash on delivery: please keep ${formatINR(o.total_paise)} ready when it arrives. No extra charge.` : `Paid online: ${formatINR(o.total_paise)}.`,
        ' A confirmation has been emailed to you. Save this page to check your order later.'),
    ),
    step > 0
      ? el('ol', { class: 'status-steps', 'aria-label': 'Order progress' },
          ...['Confirmed', 'Packed', 'Shipped', 'Delivered'].map((t, i) => el('li', { class: i < step ? 'done' : '', 'aria-current': i === step - 1 ? 'step' : undefined }, t)))
      : el('div', { class: 'notice bad' }, o.status === 'created' ? 'We are waiting for the payment confirmation. This page updates automatically.' : 'This order is not active. If money was deducted, Razorpay returns it automatically.'),
    o.tracking_number ? trackingBox(o.tracking_number, o.courier) : null,
    el('div', { class: 'summary', style: 'margin-top:24px' },
      el('strong', {}, 'Items'),
      ...o.items.map((i) => el('div', { class: 'r' }, el('span', {}, `${i.product_name} · ${i.variant_label} × ${i.qty}`), el('span', {}, formatINR(i.unit_price_paise * i.qty)))),
      el('div', { class: 'r', style: 'border-top:1px solid var(--line);padding-top:10px' }, el('span', {}, 'Shipping'), el('span', {}, o.shipping_paise ? formatINR(o.shipping_paise) : 'Free')),
      cod ? el('div', { class: 'r' }, el('span', {}, 'Cash on delivery charge'), el('span', { class: 'free' }, 'Free')) : null,
      el('div', { class: 'r total' }, el('span', {}, 'Total'), el('span', {}, formatINR(o.total_paise))),
    ),
    el('div', { class: 'summary', style: 'margin-top:16px' },
      el('strong', {}, 'Delivering to'),
      el('span', {}, o.name),
      el('span', { class: 'muted' }, [o.line1, o.line2, `${o.city}, ${o.state} ${o.pincode}`].filter(Boolean).join(', ')),
    ),
    el('p', { style: 'margin-top:24px' }, el('a', { class: 'btn btn-outline', href: '/shop/' }, 'Continue shopping')),
  );
}

if (!id || !token) root.replaceChildren(el('div', { class: 'empty', style: 'margin-top:32px' }, el('p', {}, 'Open this page from the link in your order confirmation email.')));
else load();
