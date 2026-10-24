import { getCart, saveCart, type CartLine } from './cart';
import { api } from './util';

export interface Quote {
  lines: { variantId: number; productName: string; variantLabel: string; qty: number; unitPricePaise: number; linePaise: number }[];
  unavailable: { variantId: number; available: number }[];
  subtotal: number;
  shipping: number;
  total: number;
}

/** Ask the server for real prices/stock, and refresh the stored display prices. */
export async function refreshQuote(): Promise<{ cart: CartLine[]; quote: Quote }> {
  const cart = getCart();
  const quote = await api<Quote>('/api/cart/quote', { body: { items: cart.map((l) => ({ variantId: l.variantId, qty: l.qty })) } });
  let changed = false;
  for (const l of cart) {
    const ql = quote.lines.find((x) => x.variantId === l.variantId);
    if (ql && ql.unitPricePaise !== l.pricePaise) {
      l.pricePaise = ql.unitPricePaise;
      changed = true;
    }
  }
  if (changed) saveCart(cart);
  return { cart, quote };
}
