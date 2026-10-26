import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { COURIERS, courierById } from '../shared/couriers';
import { parse, statusUpdateSchema } from '../worker/lib/validation';
import { shippedEmail } from '../worker/lib/email';

describe('couriers', () => {
  it('match the database rule in migration 0005', () => {
    const sql = readFileSync(new URL('../migrations/0005_order_courier.sql', import.meta.url), 'utf8');
    const allowed = [...(sql.match(/IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(allowed).toEqual(COURIERS.map((c) => c.id));
  });

  it('only link to the couriers\' own https sites', () => {
    for (const c of COURIERS) if (c.trackUrl) expect(new URL(c.trackUrl).protocol).toBe('https:');
    expect(courierById('other')?.trackUrl).toBeNull();
    expect(courierById('nope')).toBeNull();
    expect(courierById(null)).toBeNull();
  });

  it('accept a known courier when shipping and reject anything else', () => {
    expect(parse(statusUpdateSchema, { status: 'shipped', courier: 'dtdc', trackingNumber: 'D123' }).courier).toBe('dtdc');
    expect(() => parse(statusUpdateSchema, { status: 'shipped', courier: 'javascript:alert(1)', trackingNumber: 'D123' })).toThrow();
  });
});

describe('shipped email', () => {
  it('names the courier, shows the tracking number and links to the courier page', () => {
    const m = shippedEmail({ number: 1002, customer_name: 'Vetrivel Pandian' }, 'DTDC', 'https://www.dtdc.com/track-your-shipment/', 'D1234567', 'https://x/order/?id=1&t=2');
    expect(m.subject).toBe('Order VK-1002 has shipped — Veeess Knits');
    expect(m.html).toContain('Track on DTDC');
    expect(m.html).toContain('D1234567');
    expect(m.text).toContain('Tracking number: D1234567');
  });

  it('escapes anything typed by admins or customers', () => {
    const m = shippedEmail({ number: 1, customer_name: '<b>x</b>' }, 'Other courier', null, '<script>1</script>', 'https://x/');
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).not.toContain('Track on');
  });
});
