// Track your order (D48): order number + phone → the private order page.
import { api, HttpError, $ } from './util';

declare global {
  interface Window {
    turnstile?: { render(el: HTMLElement, opts: Record<string, unknown>): string; reset(id?: string): void; getResponse(id?: string): string | undefined };
  }
}

const form = $('[data-track-form]') as HTMLFormElement;
const errBox = $('[data-track-error]');
const submit = $('[data-track-submit]') as HTMLButtonElement;
let turnstileId: string | undefined;

function showError(msg: string) {
  errBox.textContent = msg;
  errBox.hidden = false;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('load failed'));
    document.head.append(s);
  });
}

api<{ turnstileSiteKey: string }>('/api/config')
  .then(async (cfg) => {
    await loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit');
    turnstileId = window.turnstile?.render($('[data-turnstile]'), { sitekey: cfg.turnstileSiteKey, theme: 'light', size: 'flexible', action: 'track' });
  })
  .catch(() => {
    // If the widget can't load, the server will ask to retry.
  });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errBox.hidden = true;
  const f = new FormData(form);
  const orderNumber = String(f.get('orderNumber') ?? '').trim();
  const phone = String(f.get('phone') ?? '').trim();
  if (!orderNumber || !phone) {
    showError('Please enter your order number and mobile number.');
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Finding your order…';
  try {
    const r = await api<{ orderId: string; token: string }>('/api/orders/lookup', {
      body: { orderNumber, phone, turnstileToken: window.turnstile?.getResponse(turnstileId) || undefined },
    });
    location.href = `/order/?id=${encodeURIComponent(r.orderId)}&t=${encodeURIComponent(r.token)}`;
  } catch (err) {
    if (err instanceof HttpError) {
      const fields = (err.data.fields as { message: string }[] | undefined) ?? [];
      showError(fields[0]?.message ?? err.message);
    } else showError('Something went wrong. Please try again.');
    window.turnstile?.reset(turnstileId);
    submit.disabled = false;
    submit.textContent = 'Track order';
  }
});
