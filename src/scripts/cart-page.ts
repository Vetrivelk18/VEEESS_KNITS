import { getCart, setQty } from './cart';
import { refreshQuote } from './quote';
import { api, el, formatINR, $ } from './util';

let freeMin = 99900;
api<{ freeShippingMinPaise: number }>('/api/config').then((c) => { freeMin = c.freeShippingMinPaise; }).catch(() => {});

const linesEl = $('[data-lines]');
const summary = $('[data-summary]');

async function render() {
  const cart = getCart();
  if (!cart.length) {
    summary.hidden = true;
    linesEl.replaceChildren(el('div', { class: 'empty' }, el('p', { style: 'font-size:18px;margin:0 0 16px' }, 'Your cart is empty.'), el('a', { class: 'btn', href: '/shop/' }, 'Start shopping')));
    return;
  }
  let quote;
  try {
    quote = (await refreshQuote()).quote;
  } catch {
    quote = null;
  }
  const fresh = getCart();
  linesEl.replaceChildren(
    ...fresh.map((l) => {
      const bad = quote?.unavailable.find((u) => u.variantId === l.variantId);
      return el(
        'div',
        { class: 'line' },
        el('a', { href: `/p/${l.slug}/` }, el('img', { src: l.image, alt: '', width: 88, height: 110 })),
        el(
          'div',
          { class: 'body' },
          el('span', { class: 'brand' }, l.brand),
          el('a', { href: `/p/${l.slug}/`, style: 'font-weight:600;color:var(--ink);text-decoration:none' }, l.name),
          el('span', { class: 'muted', style: 'font-size:14px' }, `${l.colour} / ${l.size}`),
          bad ? el('span', { class: 'warn' }, bad.available > 0 ? `Only ${bad.available} left — please reduce the quantity.` : 'Sold out — please remove.') : null,
          el(
            'div',
            { class: 'row' },
            el(
              'div',
              { class: 'qty sm', role: 'group', 'aria-label': `Quantity for ${l.name}` },
              el('button', { type: 'button', 'aria-label': 'Decrease', onclick: () => { setQty(l.variantId, l.qty - 1); render(); } }, '−'),
              el('output', {}, String(l.qty)),
              el('button', { type: 'button', 'aria-label': 'Increase', onclick: () => { setQty(l.variantId, l.qty + 1); render(); } }, '+'),
            ),
            el('span', { class: 'price' }, formatINR(l.pricePaise * l.qty)),
            el('button', { type: 'button', class: 'link-btn', onclick: () => { setQty(l.variantId, 0); render(); } }, 'Remove'),
          ),
        ),
      );
    }),
  );
  summary.hidden = false;
  const count = fresh.reduce((a, l) => a + l.qty, 0);
  $('[data-sub-label]').textContent = `Subtotal (${count} item${count === 1 ? '' : 's'})`;
  if (quote) {
    $('[data-subtotal]').textContent = formatINR(quote.subtotal);
    $('[data-shipping]').textContent = quote.shipping ? formatINR(quote.shipping) : 'Free';
    $('[data-shipping]').className = quote.shipping ? '' : 'free';
    $('[data-total]').textContent = formatINR(quote.total);
    $('[data-ship-hint]').textContent = quote.shipping ? `Add ${formatINR(freeMin - quote.subtotal)} more for free shipping.` : '';
    const checkout = $('[data-checkout]') as HTMLAnchorElement;
    const blocked = quote.unavailable.length > 0;
    checkout.setAttribute('aria-disabled', String(blocked));
    checkout.style.pointerEvents = blocked ? 'none' : '';
    checkout.style.opacity = blocked ? '.55' : '';
  } else {
    $('[data-total]').textContent = 'Could not load prices — check your connection.';
  }
}

render();
