/**
 * Couriers the admin can choose when marking an order shipped.
 * Shared by the Worker (validation, emails) and the storefront/admin pages.
 *
 * `trackUrl` is the courier's official tracking page. Courier sites do not
 * accept the tracking number in the link reliably (some need a captcha or
 * an OTP), so the customer gets a button to open the page plus a one-tap
 * "Copy" for the number. Checked 26 Oct 2026.
 */
export const COURIERS = [
  { id: 'dtdc', name: 'DTDC', trackUrl: 'https://www.dtdc.com/track-your-shipment/' },
  { id: 'delhivery', name: 'Delhivery', trackUrl: 'https://www.delhivery.com/tracking' },
  { id: 'stcourier', name: 'ST Courier', trackUrl: 'https://stcourier.com/track/shipment' },
  { id: 'indiapost', name: 'India Post', trackUrl: 'https://www.indiapost.gov.in/' },
  { id: 'professional', name: 'The Professional Couriers', trackUrl: 'https://www.tpcindia.com/' },
  { id: 'other', name: 'Other courier', trackUrl: null },
] as const;

export type CourierId = (typeof COURIERS)[number]['id'];
export const COURIER_IDS = COURIERS.map((c) => c.id) as [CourierId, ...CourierId[]];

export function courierById(id: string | null | undefined) {
  return COURIERS.find((c) => c.id === id) ?? null;
}
