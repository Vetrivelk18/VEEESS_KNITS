import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { AUDIENCE_IDS, showsOn } from '../shared/audience';
import { parse, productUpsertSchema, sizeChartNameSchema } from '../worker/lib/validation';
import { ORDER_LINK_DAYS, signOrderToken, verifyOrderToken } from '../worker/lib/crypto';
import { PUBLIC_MEDIA_KEY } from '../worker/index';

const migration = readFileSync(new URL('../migrations/0006_size_charts_audience.sql', import.meta.url), 'utf8');
const base = { name: 'Test tee', categoryId: 1, description: '', fabric: '', gsm: null, care: '', isActive: true, isNew: false };

describe('Men / Women / Kids', () => {
  it('match the database rule in migration 0006', () => {
    const allowed = [...(migration.match(/audience IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(allowed).toEqual([...AUDIENCE_IDS]);
  });

  it('show unisex products to men and women, but not under kids', () => {
    expect(showsOn('men', 'unisex')).toBe(true);
    expect(showsOn('women', 'unisex')).toBe(true);
    expect(showsOn('kids', 'unisex')).toBe(false);
    expect(showsOn('men', 'women')).toBe(false);
    expect(showsOn('kids', 'kids')).toBe(true);
  });

  it('defaults to unisex with no size chart, and rejects unknown values', () => {
    const p = parse(productUpsertSchema, base);
    expect(p.audience).toBe('unisex');
    expect(p.sizeChartId).toBeNull();
    expect(parse(productUpsertSchema, { ...base, audience: 'women', sizeChartId: 3 })).toMatchObject({ audience: 'women', sizeChartId: 3 });
    expect(() => parse(productUpsertSchema, { ...base, audience: 'pets' })).toThrow();
    expect(() => parse(productUpsertSchema, { ...base, sizeChartId: -1 })).toThrow();
  });
});

describe('size charts', () => {
  it('ship every built-in chart image the migration refers to', () => {
    const srcs = [...migration.matchAll(/'(\/images\/size-charts\/[^']+)'/g)].map((m) => m[1]);
    expect(srcs.length).toBe(10);
    for (const s of srcs) expect(existsSync(new URL(`../public${s}`, import.meta.url))).toBe(true);
  });

  it('are public in storage, while backups and other files stay private', () => {
    const u = '0b6f2d1e-8c2a-4b7e-9a51-2f0c3d4e5f60';
    expect(PUBLIC_MEDIA_KEY.test(`size-charts/${u}.jpg`)).toBe(true);
    expect(PUBLIC_MEDIA_KEY.test(`products/12/${u}.webp`)).toBe(true);
    expect(PUBLIC_MEDIA_KEY.test('backups/2026-10-26.sql.gz')).toBe(false);
    expect(PUBLIC_MEDIA_KEY.test(`size-charts/../backups/${u}.jpg`)).toBe(false);
    expect(PUBLIC_MEDIA_KEY.test(`size-charts/${u}.svg`)).toBe(false);
  });

  it('need a sensible name', () => {
    expect(parse(sizeChartNameSchema, "Women's T-shirt · S–3XL")).toBe("Women's T-shirt · S–3XL");
    expect(() => parse(sizeChartNameSchema, 'x')).toThrow();
  });
});

describe('order links', () => {
  it('last about 6 months', async () => {
    const t = await signOrderToken('secret-for-tests-0123456789', 'order-1');
    const exp = Number(t.split('.')[0]);
    const days = (exp - Date.now() / 1000) / 86400;
    expect(ORDER_LINK_DAYS).toBeGreaterThanOrEqual(180);
    expect(days).toBeGreaterThan(ORDER_LINK_DAYS - 1);
    expect(await verifyOrderToken('secret-for-tests-0123456789', 'order-1', t)).toBe(true);
    expect(await verifyOrderToken('secret-for-tests-0123456789', 'order-2', t)).toBe(false);
  });
});
