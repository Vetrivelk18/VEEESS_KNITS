/** ₹ formatting with Indian digit grouping, from integer paise. */
export function formatINR(paise: number): string {
  const rupees = paise / 100;
  return '₹' + rupees.toLocaleString('en-IN', { minimumFractionDigits: rupees % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/**
 * Delivery charge for an order.
 * feePaise: flat charge per order (0 = free delivery).
 * freeMinPaise: orders at or above this subtotal ship free (0 = no free-delivery threshold).
 */
export function shippingFor(subtotalPaise: number, freeMinPaise: number, feePaise: number): number {
  if (feePaise <= 0) return 0;
  return freeMinPaise > 0 && subtotalPaise >= freeMinPaise ? 0 : feePaise;
}

export function orderLabel(number: number): string {
  return `VK-${number}`;
}
