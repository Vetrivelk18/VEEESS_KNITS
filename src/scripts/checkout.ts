import { clearCart, getCart } from './cart';
import { refreshQuote, type Quote } from './quote';
import { api, el, formatINR, HttpError, $ } from './util';

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open(): void; on(evt: string, cb: (r: unknown) => void): void };
    turnstile?: { render(el: HTMLElement, opts: Record<string, unknown>): string; reset(id?: string): void; getResponse(id?: string): string | undefined };
  }
}

interface Config { razorpayKeyId: string; turnstileSiteKey: string; mockPayments: boolean; freeShippingMinPaise: number }
interface CheckoutRes {
  orderId: string; label: string; totalPaise: number; paymentMethod: 'razorpay' | 'cod'; status: string; token: string;
  razorpay: null | { key: string; orderId: string; amount: number; currency: string; name: string; description: string; prefill: Record<string, string>; mock: boolean };
}

const form = $('[data-checkout-form]') as HTMLFormElement;
const errBox = $('[data-form-error]');
const submit = $('[data-submit]') as HTMLButtonElement;
let quote: Quote | null = null;
let turnstileId: string | undefined;
let pending: CheckoutRes | null = null; // an online order awaiting payment (re-used on retry)

function showError(msg: string) {
  errBox.textContent = msg;
  errBox.hidden = false;
  errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function method(): 'razorpay' | 'cod' {
  return (form.querySelector<HTMLInputElement>('input[name=paymentMethod]:checked')?.value as 'razorpay' | 'cod') ?? 'razorpay';
}

function updateButton() {
  const cod = method() === 'cod';
  submit.textContent = quote ? (cod ? `Place order · ${formatINR(quote.total)}` : `Pay ${formatINR(quote.total)}`) : cod ? 'Place order' : 'Pay securely';
}

async function loadSummary() {
  if (!getCart().length) {
    location.replace('/cart/');
    return;
  }
  try {
    quote = (await refreshQuote()).quote;
  } catch {
    showError('Could not load prices. Check your connection and refresh.');
    return;
  }
  const items = $('[data-items]');
  items.replaceChildren(
    ...quote.lines.map((l) =>
      el('div', { style: 'display:flex;justify-content:space-between;gap:8px' }, el('span', {}, `${l.productName} · ${l.variantLabel} × ${l.qty}`), el('span', {}, formatINR(l.linePaise))),
    ),
  );
  $('[data-subtotal]').textContent = formatINR(quote.subtotal);
  $('[data-shipping]').textContent = quote.shipping ? formatINR(quote.shipping) : 'Free';
  $('[data-total]').textContent = formatINR(quote.total);
  if (quote.unavailable.length) showError('Some items in your cart are no longer available in that quantity. Please update your cart.');
  updateButton();
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('load failed'));
    document.head.append(s);
  });
}

async function setupTurnstile(cfg: Config) {
  try {
    await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    const host = $('[data-turnstile]');
    turnstileId = window.turnstile?.render(host, { sitekey: cfg.turnstileSiteKey, theme: 'light', size: 'flexible', action: 'checkout' });
  } catch {
    // If the widget can't load, the server decides (it will ask to retry).
  }
}

function readForm() {
  const f = new FormData(form);
  const s = (k: string) => String(f.get(k) ?? '').trim();
  return {
    items: getCart().map((l) => ({ variantId: l.variantId, qty: l.qty })),
    customer: { name: s('name'), phone: s('phone'), email: s('email') },
    address: { line1: s('line1'), line2: s('line2'), city: s('city'), state: s('state'), pincode: s('pincode') },
    paymentMethod: method(),
    consent: f.get('consent') === 'on',
    turnstileToken: window.turnstile?.getResponse(turnstileId) || undefined,
  };
}

function markInvalid(fields: { path: string; message: string }[] = []) {
  form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
  for (const f of fields) {
    const name = f.path.split('.').pop() ?? '';
    form.querySelector(`[name="${CSS.escape(name)}"]`)?.setAttribute('aria-invalid', 'true');
  }
}

function done(orderId: string, token: string) {
  clearCart();
  sessionStorage.removeItem('vk_pending');
  location.href = `/order/?id=${encodeURIComponent(orderId)}&t=${encodeURIComponent(token)}&new=1`;
}

async function verify(orderId: string, r: Record<string, string>) {
  submit.disabled = true;
  submit.textContent = 'Confirming payment…';
  try {
    const v = await api<{ orderId: string; token: string; status: string }>('/api/payments/verify', { body: { orderId, ...r } });
    done(v.orderId, v.token);
  } catch (e) {
    showError(e instanceof HttpError ? `${e.message} If money was deducted, it will be confirmed automatically within 15 minutes or refunded by Razorpay.` : 'Could not confirm payment.');
    submit.disabled = false;
    updateButton();
  }
}

async function openPayment(o: CheckoutRes) {
  const rp = o.razorpay!;
  if (rp.mock) {
    const box = $('[data-mock]');
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('[data-mock-pay]').onclick = async () => {
      const r = await api<Record<string, string>>('/api/dev/mock-pay', { body: { orderId: o.orderId } });
      box.hidden = true;
      await verify(o.orderId, r);
    };
    $('[data-mock-cancel]').onclick = () => {
      box.hidden = true;
      showError('Payment cancelled. Your items are held for 30 minutes — you can try again.');
      submit.disabled = false;
      updateButton();
    };
    return;
  }
  try {
    await loadScript('https://checkout.razorpay.com/v1/checkout.js');
  } catch {
    showError('Could not load the payment window. Check your connection, or choose cash on delivery.');
    submit.disabled = false;
    updateButton();
    return;
  }
  const rzp = new window.Razorpay!({
    key: rp.key,
    amount: rp.amount,
    currency: rp.currency,
    name: rp.name,
    description: rp.description,
    order_id: rp.orderId,
    prefill: rp.prefill,
    theme: { color: '#1F2B5C' },
    retry: { enabled: true },
    handler: (resp: Record<string, string>) => verify(o.orderId, resp),
    modal: {
      ondismiss: () => {
        showError('Payment window closed. Your items are held for 30 minutes — press Pay to try again.');
        submit.disabled = false;
        updateButton();
      },
    },
  });
  rzp.on('payment.failed', () => {
    showError('The payment did not go through. You can try again, use another method, or choose cash on delivery.');
  });
  rzp.open();
}

form.addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).name === 'paymentMethod') {
    updateButton();
    pending = null; // switching method starts a fresh order
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.hidden = true;
  markInvalid();
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  if (pending && pending.paymentMethod === 'razorpay' && method() === 'razorpay') {
    submit.disabled = true;
    await openPayment(pending);
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Placing order…';
  try {
    const o = await api<CheckoutRes>('/api/checkout', { body: readForm() });
    if (o.paymentMethod === 'cod') return done(o.orderId, o.token);
    pending = o;
    sessionStorage.setItem('vk_pending', JSON.stringify({ orderId: o.orderId, token: o.token }));
    await openPayment(o);
  } catch (err) {
    if (err instanceof HttpError) {
      markInvalid((err.data.fields as { path: string; message: string }[]) ?? []);
      showError(err.message);
      if (err.code === 'out_of_stock') loadSummary();
    } else showError('Something went wrong. Please try again.');
    window.turnstile?.reset(turnstileId);
    submit.disabled = false;
    updateButton();
  }
});

loadSummary();
api<Config>('/api/config')
  .then((cfg) => setupTurnstile(cfg))
  .catch(() => {});
