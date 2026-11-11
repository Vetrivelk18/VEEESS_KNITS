import { describe, expect, it } from 'vitest';
import { SITE_TEXT_FIELDS, checkSiteText, cleanSiteText, resolveSiteText, siteTextField } from '../shared/siteText';

const f = (k: string) => siteTextField(k)!;

describe('site text (D50)', () => {
  it('has 22 unique fields whose defaults pass their own rules', () => {
    expect(SITE_TEXT_FIELDS).toHaveLength(22);
    expect(new Set(SITE_TEXT_FIELDS.map((x) => x.key)).size).toBe(22);
    for (const x of SITE_TEXT_FIELDS) expect(checkSiteText(x, x.def), x.key).toBeNull();
  });

  it('keeps the current home page wording as the defaults', () => {
    expect(f('announce.text').def).toBe('Secure online payment · UPI, cards, netbanking · Made in Tiruppur');
    expect(f('hero.headline').def).toBe('From production to brand perfection.');
    expect(f('drop.title').def).toBe('Heavyweight\noversized tees');
    expect(f('about.step6.title').def).toBe('QC & packing');
  });

  it('tidies what admins type', () => {
    expect(cleanSiteText('  New   drop \r\n')).toBe('New drop');
    expect(cleanSiteText('Heavy\r\n\r\n\r\noversized')).toBe('Heavy\n\noversized');
    expect(cleanSiteText('a\u0007b​c')).toBe('abc');
  });

  it('refuses empty, too long, extra line breaks and < >', () => {
    expect(checkSiteText(f('drop.label'), '')).toMatch(/can't be empty/);
    expect(checkSiteText(f('drop.label'), 'x'.repeat(26))).toMatch(/too long/);
    expect(checkSiteText(f('announce.text'), 'one\ntwo')).toMatch(/one line/);
    expect(checkSiteText(f('hero.headline'), 'a\nb\nc\nd')).toMatch(/at most 2/);
    expect(checkSiteText(f('hero.intro'), 'Hi <script>alert(1)</script>')).toMatch(/aren't allowed/);
    expect(checkSiteText(f('hero.intro'), 'Cotton & linen · ₹799 "best" tees')).toBeNull();
  });

  it('falls back to defaults for missing, unknown, wrong-type or invalid saved values', () => {
    const r = resolveSiteText({ 'drop.label': 'Just in', 'hero.tag': 42, 'announce.text': 'x\ny', 'nope': 'ignored', 'about.button': '<b>' });
    expect(r['drop.label']).toBe('Just in');
    expect(r['hero.tag']).toBe(f('hero.tag').def);
    expect(r['announce.text']).toBe(f('announce.text').def);
    expect(r['about.button']).toBe(f('about.button').def);
    expect(r).not.toHaveProperty('nope');
    expect(Object.keys(resolveSiteText(null))).toHaveLength(22);
  });
});
