import { describe, expect, it } from 'vitest';
import { orderLookupSchema, parse, parseOrderNumber } from '../worker/lib/validation';

describe('track your order (D48)', () => {
  it('reads order numbers the way customers type them', () => {
    for (const s of ['VK-1042', 'vk-1042', 'VK 1042', 'vk1042', '#1042', '1042', ' VK-1042 ']) expect(parseOrderNumber(s)).toBe(1042);
  });
  it('rejects anything that is not an order number', () => {
    for (const s of ['', 'VK-', 'VK-10a', '1042; DROP TABLE orders', 'AB-1042', '0', '12345678901']) expect(parseOrderNumber(s)).toBeNull();
  });
  it('needs a valid order number and Indian mobile number', () => {
    expect(parse(orderLookupSchema, { orderNumber: 'VK-1042', phone: '+91 98765 43210' })).toMatchObject({ orderNumber: 1042, phone: '9876543210' });
    expect(() => parse(orderLookupSchema, { orderNumber: 'VK-1042', phone: '12345' })).toThrow();
    expect(() => parse(orderLookupSchema, { orderNumber: 'hello', phone: '9876543210' })).toThrow();
    expect(() => parse(orderLookupSchema, { orderNumber: 'VK-1042' })).toThrow();
  });
});
