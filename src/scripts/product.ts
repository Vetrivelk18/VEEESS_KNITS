import { addToCart } from './cart';
import { api, formatINR, toast, el } from './util';

interface V { id: number; colour: string; colour_hex: string; size: string; price_paise: number; mrp_paise: number | null; available: number }
interface Data { slug: string; name: string; brand: string; variants: V[]; colours: { name: string; hex: string }[]; sizes: string[]; images: { src: string; alt: string; colour: string | null }[] }

const raw = document.getElementById('product-data')?.textContent ?? '{}';
const data = JSON.parse(raw) as Data;
let variants = data.variants;
let colour = data.colours[0]?.name ?? '';
let size: string | null = null;
let qty = 1;

const q = <T extends HTMLElement>(s: string) => document.querySelector<T>(s);
const priceEl = q('[data-price]');
const mrpEl = q('[data-mrp]');
const offEl = q('[data-off]');
const qtyEl = q('[data-qty]');
const sizeName = q('[data-size-name]');
const sizeErr = q('[data-size-err]');
const stockNote = q('[data-stock-note]');
const gallery = q('[data-gallery]');

function current(): V | undefined {
  return size ? variants.find((v) => v.colour === colour && v.size === size) : undefined;
}

function render() {
  document.querySelectorAll<HTMLButtonElement>('[data-colour]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.colour === colour)));
  const nameEl = q('[data-colour-name]');
  if (nameEl) nameEl.textContent = colour;
  document.querySelectorAll<HTMLButtonElement>('[data-size]').forEach((b) => {
    const v = variants.find((x) => x.colour === colour && x.size === b.dataset.size);
    const avail = v ? v.available : 0;
    b.disabled = avail <= 0;
    b.setAttribute('aria-pressed', String(b.dataset.size === size));
    b.setAttribute('aria-label', `${b.dataset.size}${avail <= 0 ? ', sold out' : ''}`);
  });
  const v = current();
  if (v && v.available <= 0) size = null;
  if (sizeName) sizeName.textContent = size ?? 'Select';
  const shown = v ?? variants.find((x) => x.colour === colour) ?? variants[0];
  if (shown && priceEl) {
    priceEl.textContent = formatINR(shown.price_paise);
    if (mrpEl) mrpEl.textContent = shown.mrp_paise ? formatINR(shown.mrp_paise) : '';
    if (offEl) offEl.textContent = shown.mrp_paise && shown.mrp_paise > shown.price_paise ? `${Math.round(((shown.mrp_paise - shown.price_paise) / shown.mrp_paise) * 100)}% off` : '';
  }
  if (stockNote) stockNote.textContent = v && v.available > 0 && v.available <= 3 ? `Only ${v.available} left in this size.` : '';
  if (qtyEl) qtyEl.textContent = String(qty);
}

function renderGallery() {
  if (!gallery) return;
  const imgs = data.images.filter((i) => i.colour === colour);
  const list = (imgs.length ? imgs : data.images).slice(0, 3);
  gallery.replaceChildren(
    ...list.map((g, i) => el('div', { class: i === 0 ? 'main' : '' }, el('img', { src: g.src, alt: g.alt, width: 1200, height: i === 0 ? 900 : 1200 }))),
  );
}

document.querySelectorAll<HTMLButtonElement>('[data-colour]').forEach((b) =>
  b.addEventListener('click', () => {
    colour = b.dataset.colour ?? colour;
    renderGallery();
    render();
  }),
);
document.querySelectorAll<HTMLButtonElement>('[data-size]').forEach((b) =>
  b.addEventListener('click', () => {
    size = b.dataset.size ?? null;
    if (sizeErr) sizeErr.hidden = true;
    render();
  }),
);
q('[data-dec]')?.addEventListener('click', () => {
  qty = Math.max(1, qty - 1);
  render();
});
q('[data-inc]')?.addEventListener('click', () => {
  const v = current();
  qty = Math.min(10, v ? Math.max(1, Math.min(v.available, qty + 1)) : qty + 1);
  render();
});

function add(): boolean {
  const v = current();
  if (!v) {
    if (sizeErr) sizeErr.hidden = false;
    q<HTMLButtonElement>('[data-size]:not(:disabled)')?.focus();
    return false;
  }
  if (qty > v.available) {
    toast(`Only ${v.available} left in this size.`);
    return false;
  }
  const img = data.images.find((i) => i.colour === colour) ?? data.images[0];
  const r = addToCart({
    variantId: v.id, qty, slug: data.slug, name: data.name, brand: data.brand, colour: v.colour, size: v.size,
    image: img?.src ?? '', pricePaise: v.price_paise,
  });
  if (!r.ok) {
    toast(r.message ?? 'Could not add to cart.');
    return false;
  }
  return true;
}

q('[data-add]')?.addEventListener('click', () => {
  if (add()) {
    const btn = q<HTMLButtonElement>('[data-add]');
    if (btn) {
      btn.textContent = 'Added ✓';
      setTimeout(() => (btn.textContent = 'Add to cart'), 1800);
    }
    toast(`${data.name} (${colour} / ${size}) added to cart.`, { href: '/cart/', text: 'View cart' });
  }
});
q('[data-buy]')?.addEventListener('click', () => {
  if (add()) location.href = '/checkout/';
});

render();
// Refresh live stock and price (static page may be a few minutes old).
api<{ variants: V[] }>(`/api/products/${encodeURIComponent(data.slug)}`)
  .then((r) => {
    variants = r.variants;
    render();
  })
  .catch(() => {});

// Size chart popup (a native <dialog>: Esc closes it and focus returns to the button).
const sizeDialog = q<HTMLDialogElement>('[data-size-chart]');
const sizeOpen = q<HTMLButtonElement>('[data-size-chart-open]');
sizeOpen?.addEventListener('click', () => sizeDialog?.showModal());
q('[data-size-chart-close]')?.addEventListener('click', () => sizeDialog?.close());
// Tap outside the chart (on the dark backdrop) to close.
sizeDialog?.addEventListener('click', (e) => { if (e.target === sizeDialog) sizeDialog.close(); });
