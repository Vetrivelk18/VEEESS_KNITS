// Cart lives in the browser (localStorage). It only holds variant ids,
// quantities and display info — the server re-prices everything at checkout.
export interface CartLine {
  variantId: number;
  qty: number;
  slug: string;
  name: string;
  brand: string;
  colour: string;
  size: string;
  image: string;
  pricePaise: number; // display only, refreshed from /api/cart/quote
}

const KEY = 'vk_cart_v1';

function safeParse(raw: string | null): CartLine[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    if (!Array.isArray(v)) return [];
    return v
      .filter((l) => l && Number.isInteger(l.variantId) && Number.isInteger(l.qty) && l.qty > 0 && l.qty <= 10)
      .slice(0, 20);
  } catch {
    return [];
  }
}

export function getCart(): CartLine[] {
  try {
    return safeParse(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function saveCart(lines: CartLine[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {}
  updateBadges();
  window.dispatchEvent(new CustomEvent('cart:changed'));
}

export function addToCart(line: CartLine): { ok: boolean; message?: string } {
  const lines = getCart();
  const existing = lines.find((l) => l.variantId === line.variantId);
  if (existing) {
    if (existing.qty + line.qty > 10) return { ok: false, message: 'Maximum 10 of one item per order.' };
    existing.qty += line.qty;
  } else {
    if (lines.length >= 20) return { ok: false, message: 'Your cart is full (20 items).' };
    lines.push(line);
  }
  saveCart(lines);
  return { ok: true };
}

export function setQty(variantId: number, qty: number): void {
  const lines = getCart()
    .map((l) => (l.variantId === variantId ? { ...l, qty: Math.max(0, Math.min(10, qty)) } : l))
    .filter((l) => l.qty > 0);
  saveCart(lines);
}

export function clearCart(): void {
  saveCart([]);
}

export function cartCount(): number {
  return getCart().reduce((a, l) => a + l.qty, 0);
}

export function updateBadges(): void {
  const n = cartCount();
  document.querySelectorAll<HTMLElement>('[data-cart-count]').forEach((b) => {
    b.textContent = String(n);
    b.hidden = n === 0;
  });
  document.querySelectorAll<HTMLElement>('[data-cart-link]').forEach((a) => a.setAttribute('aria-label', `Cart, ${n} item${n === 1 ? '' : 's'}`));
}
