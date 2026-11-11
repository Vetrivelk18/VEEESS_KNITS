// Shop texts that admins can edit (D50). One list, used by the admin page, the API and the shop.
// The shop shows the saved text after "Publish storefront"; anything not saved uses `def`.
// Text is plain: no HTML. `breaks` = how many manual line breaks (Enter) are allowed.

export interface SiteTextField {
  key: string;
  group: SiteTextGroup;
  label: string;
  hint?: string;
  max: number;
  breaks: number;
  def: string;
}

export const SITE_TEXT_GROUPS = [
  { id: 'announce', title: 'Announcement bar', note: 'The strip at the very top of every page.' },
  { id: 'hero', title: 'Home page · top section', note: 'The first thing visitors see on the home page.' },
  { id: 'drop', title: 'Home page · “New drop” tile', note: 'The dark blue tile next to the big T-shirt photo.' },
  { id: 'about', title: 'Home page · “Made in our own unit” section', note: 'The dark blue section with the six steps.' },
] as const;
export type SiteTextGroup = (typeof SITE_TEXT_GROUPS)[number]['id'];

const STEP_DEFAULTS: [string, string][] = [
  ['Fabric sourcing', 'Knitted fabric sourced and inspected roll by roll.'],
  ['Pattern & grading', 'Professional patterns and size grading for a consistent fit.'],
  ['Cutting & stitching', 'Precision cutting and stitching in our own unit.'],
  ['Dyeing & finishing', 'Controlled garment dyeing and finishing.'],
  ['GSM & shrinkage tests', 'Fabric weight and shrinkage checked to spec.'],
  ['QC & packing', 'Measurement checks, final inspection, careful packing.'],
];

export const SITE_TEXT_FIELDS: SiteTextField[] = [
  { key: 'announce.text', group: 'announce', label: 'Announcement', max: 110, breaks: 0, def: 'Secure online payment · UPI, cards, netbanking · Made in Tiruppur' },

  { key: 'hero.tag', group: 'hero', label: 'Small tag above the headline', max: 45, breaks: 0, def: 'Tiruppur knitwear · 15+ years' },
  { key: 'hero.headline', group: 'hero', label: 'Headline', hint: 'Shown very large. Keep it short.', max: 70, breaks: 2, def: 'From production to brand perfection.' },
  { key: 'hero.intro', group: 'hero', label: 'Intro paragraph', max: 280, breaks: 2, def: 'Export-standard T-shirts and everyday knitwear, made in our own unit. Shop Wordle, our own label, straight from the factory. Pay securely online by UPI, card or netbanking.' },

  { key: 'drop.label', group: 'drop', label: 'Small label', max: 25, breaks: 0, def: 'New drop' },
  { key: 'drop.title', group: 'drop', label: 'Title', max: 45, breaks: 2, def: 'Heavyweight\noversized tees' },

  { key: 'about.eyebrow', group: 'about', label: 'Small label', max: 40, breaks: 0, def: 'Made in our own unit' },
  { key: 'about.headline', group: 'about', label: 'Headline', max: 80, breaks: 2, def: 'Every piece made and checked in Tiruppur.' },
  { key: 'about.body', group: 'about', label: 'Paragraph', max: 320, breaks: 2, def: 'Every Wordle piece is cut, stitched, finished and inspected in our own unit, to the export standard we have kept for 15+ years.' },
  { key: 'about.button', group: 'about', label: 'Button label', max: 30, breaks: 0, def: 'Shop the collection' },
  ...STEP_DEFAULTS.flatMap(([t, d], i): SiteTextField[] => [
    { key: `about.step${i + 1}.title`, group: 'about', label: `Step 0${i + 1} · title`, max: 35, breaks: 0, def: t },
    { key: `about.step${i + 1}.text`, group: 'about', label: `Step 0${i + 1} · description`, max: 110, breaks: 0, def: d },
  ]),
];

export const SITE_TEXT_KEYS = new Set(SITE_TEXT_FIELDS.map((f) => f.key));
export const siteTextField = (key: string) => SITE_TEXT_FIELDS.find((f) => f.key === key);

/** Tidy what an admin typed: unify line endings, drop control characters and edge spaces, collapse blank lines. */
export function cleanSiteText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')) // no runs of empty lines
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/** Returns an error message, or null if the (cleaned) text is acceptable for the field. */
export function checkSiteText(field: SiteTextField, value: string): string | null {
  if (!value) return `${field.label}: can't be empty. Use "Reset to default" to bring back the original text.`;
  if ([...value].length > field.max) return `${field.label}: too long (${[...value].length}/${field.max} characters).`;
  if (/[<>]/.test(value)) return `${field.label}: the characters < and > aren't allowed.`;
  const breaks = (value.match(/\n/g) ?? []).length;
  if (breaks > field.breaks) {
    return field.breaks === 0 ? `${field.label}: must be on one line.` : `${field.label}: at most ${field.breaks} line break${field.breaks === 1 ? '' : 's'}.`;
  }
  return null;
}

/** Saved values (possibly incomplete or stale) → a complete, safe set for the shop. Bad or missing values fall back to defaults. */
export function resolveSiteText(saved: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of SITE_TEXT_FIELDS) {
    const raw = saved?.[f.key];
    const v = typeof raw === 'string' ? cleanSiteText(raw) : '';
    out[f.key] = v && !checkSiteText(f, v) ? v : f.def;
  }
  return out;
}
