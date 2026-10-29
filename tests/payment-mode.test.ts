import { describe, expect, it } from 'vitest';
import { createOrder } from '../worker/lib/orders';
import type { Env } from '../worker/lib/env';

const input = {
  items: [{ productId: 'p1', size: 'M', qty: 1 }],
  customer: { name: 'Test', phone: '9876543210', email: 'a@b.in' },
  address: { line1: '12 Gandhi Road', city: 'Tiruppur', state: 'Tamil Nadu', pincode: '641603' },
  paymentMethod: 'cod' as const,
  consent: true,
};

describe('online payment only', () => {
  it('refuses cash on delivery when COD_ENABLED is not "1"', async () => {
    for (const flag of [undefined, '0', '']) {
      const env = { COD_ENABLED: flag } as unknown as Env; // no DB: the check must run first
      await expect(createOrder(env, input as never, '1.2.3.4')).rejects.toMatchObject({ code: 'cod_unavailable' });
    }
  });
});
