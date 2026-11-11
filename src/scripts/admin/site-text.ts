// Admin → Site text (D50): edit the shop's home-page wording and announcement bar.
import { api, el, HttpError, setChildren, toast, $ } from '../util';
import { SITE_TEXT_FIELDS, SITE_TEXT_GROUPS, checkSiteText, cleanSiteText, type SiteTextField } from '../../../shared/siteText';
import './shell';

interface Saved { key: string; value: string; updated_by: string; updated_at: string }
interface Res { saved: Saved[]; lastPublish: { value: string; updated_at: string } | null }

const form = $('[data-site-text-form]') as HTMLFormElement;
const saveBtn = $('[data-save]') as HTMLButtonElement;
const dirtyNote = $('[data-dirty-note]');
/** What the shop will show after the next publish, per key (saved value or default). */
let current: Record<string, string> = {};
let savedMeta: Record<string, Saved> = {};
let needsPublish = false;
const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();

const len = (s: string) => [...s].length;

function fieldRow(f: SiteTextField): HTMLElement {
  const multi = f.breaks > 0;
  const input = multi
    ? (el('textarea', { name: f.key, rows: f.max > 150 ? 4 : 2, maxlength: f.max + 20, spellcheck: 'true' }) as HTMLTextAreaElement)
    : (el('input', { name: f.key, type: 'text', maxlength: f.max + 20, spellcheck: 'true' }) as HTMLInputElement);
  input.value = current[f.key] ?? f.def;
  inputs.set(f.key, input);
  const counter = el('span', { class: 'st-count' });
  const err = el('span', { class: 'st-err', role: 'alert' });
  const badge = el('span', { class: 'st-badge' }, 'Changed from default');
  const reset = el('button', { type: 'button', class: 'link-like small' }, 'Reset to default');
  const hint = [f.hint, f.breaks ? `Press Enter for a new line (up to ${f.breaks}).` : 'One line.'].filter(Boolean).join(' ');

  const refresh = () => {
    const v = cleanSiteText(input.value);
    counter.textContent = `${len(v)} / ${f.max}`;
    const problem = checkSiteText(f, v);
    err.textContent = problem && v ? problem.replace(`${f.label}: `, '') : '';
    input.setAttribute('aria-invalid', String(Boolean(problem)));
    counter.classList.toggle('over', len(v) > f.max);
    badge.hidden = v === f.def;
    reset.hidden = v === f.def;
    updateDirty();
  };
  input.addEventListener('input', refresh);
  reset.addEventListener('click', () => { input.value = f.def; refresh(); input.focus(); });
  queueMicrotask(refresh);

  const meta = savedMeta[f.key];
  return el('div', { class: 'st-field' },
    el('div', { class: 'st-label' }, el('label', { for: `st-${f.key}` }, f.label), badge),
    Object.assign(input, { id: `st-${f.key}` }),
    el('div', { class: 'st-meta' },
      el('span', { class: 'muted small' }, hint, meta ? ` Last changed by ${meta.updated_by}, ${new Date(meta.updated_at).toLocaleString('en-IN')}.` : ''),
      el('span', { style: 'display:flex;gap:12px;align-items:center' }, reset, counter)),
    err);
}

function changes(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of SITE_TEXT_FIELDS) {
    const v = cleanSiteText(inputs.get(f.key)?.value ?? '');
    if (v !== current[f.key]) out[f.key] = v === f.def ? null : v;
  }
  return out;
}

function updateDirty() {
  const n = Object.keys(changes()).length;
  const invalid = SITE_TEXT_FIELDS.some((f) => checkSiteText(f, cleanSiteText(inputs.get(f.key)?.value ?? '')));
  saveBtn.disabled = n === 0 || invalid;
  dirtyNote.textContent = n === 0
    ? needsPublish ? 'Saved. Press Publish storefront to update the shop.' : 'No unsaved changes.'
    : `${n} unsaved change${n === 1 ? '' : 's'}${invalid ? ' · fix the highlighted text first' : ''}.`;
  dirtyNote.classList.toggle('st-warn', n > 0 || needsPublish);
}

async function load() {
  try {
    const r = await api<Res>('/api/admin/site-text');
    savedMeta = Object.fromEntries(r.saved.map((s) => [s.key, s]));
    current = Object.fromEntries(SITE_TEXT_FIELDS.map((f) => [f.key, savedMeta[f.key]?.value ?? f.def]));
    inputs.clear();
    setChildren($('[data-groups]'), ...SITE_TEXT_GROUPS.map((g) => el('section', { class: 'card st-group' },
      el('h2', { class: 'st-title' }, g.title),
      el('p', { class: 'muted small', style: 'margin:0 0 6px' }, g.note),
      ...SITE_TEXT_FIELDS.filter((f) => f.group === g.id).map(fieldRow))));
    const lp = r.lastPublish;
    $('[data-publish-info]').textContent = lp ? `Last published ${new Date(lp.updated_at).toLocaleString('en-IN')} by ${lp.value}` : 'Not published from the panel yet';
    updateDirty();
  } catch (e) {
    setChildren($('[data-groups]'), el('p', {}, e instanceof HttpError ? e.message : 'Could not load the site text.'));
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = changes();
  if (!Object.keys(values).length) return;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    await api('/api/admin/site-text', { method: 'PUT', body: { values } });
    needsPublish = true;
    toast('Saved. Press "Publish storefront" to update the shop.');
    await load();
  } catch (err) {
    toast(err instanceof HttpError ? err.message : 'Could not save. Please try again.');
    saveBtn.disabled = false;
  } finally {
    saveBtn.textContent = 'Save changes';
  }
});

$('[data-publish]').addEventListener('click', async () => {
  if (Object.keys(changes()).length && !confirm('You have unsaved changes. Publish anyway? Unsaved changes will not be included.')) return;
  const b = $('[data-publish]') as HTMLButtonElement;
  b.disabled = true;
  try {
    const r = await api<{ message: string }>('/api/admin/publish', { body: {} });
    needsPublish = false;
    toast(r.message);
    await load();
  } catch (err) {
    toast(err instanceof HttpError ? err.message : 'Could not publish.');
  } finally {
    b.disabled = false;
  }
});

// Warn before leaving with unsaved edits.
window.addEventListener('beforeunload', (e) => { if (Object.keys(changes()).length) e.preventDefault(); });

load();
