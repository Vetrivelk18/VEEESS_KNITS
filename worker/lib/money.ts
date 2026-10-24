/** ₹ formatting with Indian digit grouping, from integer paise. */
export function formatINR(paise: number): string {
  const rupees = paise / 100;
  return '₹' + rupees.toLocaleString('en-IN', { minimumFractionDigits: rupees % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

export function shippingFor(subtotalPaise: number, freeMinPaise: number, feePaise: number): number {
  return subtotalPaise >= freeMinPaise ? 0 : feePaise;
}

export function orderLabel(number: number): string {
  return `VK-${number}`;
}
