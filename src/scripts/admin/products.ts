import { AUDIENCES } from '../../../shared/audience';
import { api, el, formatINR, HttpError, setChildren, toast, $ } from '../util';
import './shell';

interface P { id: number; name: string; slug: string; description: string; fabric: string; gsm: number | null; care: string; is_active: number; is_new: number; category_id: number; audience: string; size_chart_id: number | null }
interface V { id: number; product_id: number; colour: string; colour_hex: string; size: string; sku: string; price_paise: number; mrp_paise: number | null; stock: number; reserved: number; is_active: number }
interface I { id: number; product_id: number; colour: string | null; src: string; alt: string }
interface Catalog { products: P[]; variants: V[]; images: I[]; categories: { id: number; name: string }[]; sizeCharts: SizeChart[]; lastPublish: { value: string; updated_at: string } | null; mediaBase: string }

interface SizeChart { id: number; name: string; src: string; used_by: number }

let cat: Catalog;
const openIds = new Set<number>();

const rupees = (paise: number | null) => (paise == null ? '' : String(paise / 100));
const toPaise = (v: string) => (v.trim() === '' ? null : Math.round(Number(v) * 100));
const imgSrc = (src: string) => (src.startsWith('r2:') ? `${cat.mediaBase.replace(/\/$/, '')}/${src.slice(3)}` : src);

function err(e: unknown, fallback: string) {
  toast(e instanceof HttpError ? e.message : fallback);
}

function productForm(form: HTMLFormElement, p?: P) {
  // Every product is Wordle (the only brand), so there is no brand picker.
  const sel = (name: string, opts: { id: number; name: string }[], val?: number) =>
    el('label', { class: 'field' }, 'Category',
      el('select', { name, required: true }, ...opts.map((o) => el('option', { value: o.id, selected: o.id === val }, o.name))));
  setChildren(
    form,
    el('div', { class: 'form-grid' },
      el('label', { class: 'field full' }, 'Product name', el('input', { name: 'name', required: true, minlength: 3, maxlength: 100, value: p?.name ?? '' })),
      sel('categoryId', cat.categories, p?.category_id),
      el('label', { class: 'field' }, 'For',
        el('select', { name: 'audience', required: true },
          ...AUDIENCES.map((a) => el('option', { value: a.id, selected: (p?.audience ?? 'unisex') === a.id }, a.id === 'unisex' ? 'Unisex (shows under Men and Women)' : a.label)))),
      el('label', { class: 'field' }, 'Size chart',
        el('select', { name: 'sizeChartId' },
          el('option', { value: '' }, 'No size chart'),
          ...cat.sizeCharts.map((s) => el('option', { value: s.id, selected: p?.size_chart_id === s.id }, s.name)))),
      el('label', { class: 'field full' }, 'Description', el('textarea', { name: 'description', rows: 3, maxlength: 2000, style: 'border:1px solid var(--line-2);border-radius:4px;padding:10px;font-weight:400' }, p?.description ?? '')),
      el('label', { class: 'field' }, 'Fabric', el('input', { name: 'fabric', maxlength: 120, value: p?.fabric ?? '' })),
      el('label', { class: 'field' }, 'GSM', el('input', { name: 'gsm', type: 'number', min: 80, max: 600, value: p?.gsm ?? '' })),
      el('label', { class: 'field full' }, 'Care', el('input', { name: 'care', maxlength: 300, value: p?.care ?? 'Machine wash cold, inside out. Do not bleach. Dry in shade.' })),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'isActive', checked: p ? p.is_active === 1 : true }), 'Show in shop'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'isNew', checked: p ? p.is_new === 1 : true }), 'Mark as new arrival'),
    ),
    el('div', { style: 'margin-top:14px' }, el('button', { type: 'submit', class: 'btn btn-sm' }, p ? 'Save product details' : 'Create product')),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body = {
      name: String(f.get('name')).trim(),
      categoryId: Number(f.get('categoryId')),
      description: String(f.get('description') ?? '').trim(),
      fabric: String(f.get('fabric') ?? '').trim(),
      gsm: f.get('gsm') ? Number(f.get('gsm')) : null,
      care: String(f.get('care') ?? '').trim(),
      isActive: f.get('isActive') === 'on',
      isNew: f.get('isNew') === 'on',
      audience: String(f.get('audience') ?? 'unisex'),
      sizeChartId: f.get('sizeChartId') ? Number(f.get('sizeChartId')) : null,
    };
    try {
      if (p) {
        await api(`/api/admin/products/${p.id}`, { method: 'PATCH', body });
        toast('Saved. Press "Publish storefront" to update the shop pages.');
      } else {
        const r = await api<{ id: number }>('/api/admin/products', { body });
        openIds.add(r.id);
        toast('Product created. Add sizes and photos below, then publish.');
        ($('[data-new-product]') as HTMLDetailsElement).open = false;
        form.reset();
      }
      await load();
    } catch (e2) {
      err(e2, 'Could not save.');
    }
  };
}

function variantRow(v: V): HTMLElement {
  const price = el('input', { type: 'number', min: 1, step: '1', value: rupees(v.price_paise), 'aria-label': `Price for ${v.colour} ${v.size}` }) as HTMLInputElement;
  const mrp = el('input', { type: 'number', min: 1, step: '1', value: rupees(v.mrp_paise), 'aria-label': `MRP for ${v.colour} ${v.size}`, placeholder: '—' }) as HTMLInputElement;
  const stock = el('input', { type: 'number', min: v.reserved, step: '1', value: v.stock, 'aria-label': `Stock for ${v.colour} ${v.size}` }) as HTMLInputElement;
  const active = el('input', { type: 'checkbox', checked: v.is_active === 1, 'aria-label': `Sell ${v.colour} ${v.size}` }) as HTMLInputElement;
  const save = el('button', { type: 'button', class: 'btn btn-sm btn-outline' }, 'Save');
  save.addEventListener('click', async () => {
    try {
      await api(`/api/admin/variants/${v.id}`, {
        method: 'PATCH',
        body: { pricePaise: toPaise(price.value) ?? v.price_paise, mrpPaise: toPaise(mrp.value), stock: Number(stock.value), isActive: active.checked },
      });
      toast(`${v.colour} / ${v.size} saved — live in the shop now.`);
      save.textContent = 'Saved ✓';
      setTimeout(() => (save.textContent = 'Save'), 1500);
    } catch (e) {
      err(e, 'Could not save.');
    }
  });
  return el('tr', {},
    el('td', {}, el('span', { style: `display:inline-block;width:14px;height:14px;border-radius:50%;border:1px solid var(--line-2);vertical-align:middle;margin-right:6px;background:${/^#[0-9a-f]{6}$/i.test(v.colour_hex) ? v.colour_hex : '#888'}` }), `${v.colour}`),
    el('td', {}, v.size),
    el('td', {}, '₹ ', price),
    el('td', {}, '₹ ', mrp),
    el('td', {}, stock, v.reserved ? el('div', { class: 'small muted' }, `${v.reserved} in checkouts`) : null),
    el('td', {}, active),
    el('td', {}, save),
  );
}

function addVariantForm(p: P): HTMLElement {
  const form = el('form', { class: 'toolbar', style: 'gap:8px' },
    el('input', { class: 'inline-input', name: 'colour', placeholder: 'Colour name', required: true, maxlength: 40, 'aria-label': 'Colour name' }),
    el('input', { type: 'color', name: 'colourHex', value: '#1F2B5C', 'aria-label': 'Colour', style: 'height:40px;width:48px;border:1px solid var(--line-2);border-radius:4px' }),
    el('input', { class: 'inline-input', name: 'size', placeholder: 'Size (e.g. M)', required: true, maxlength: 12, style: 'width:110px', 'aria-label': 'Size' }),
    el('input', { class: 'inline-input', name: 'price', type: 'number', placeholder: 'Price ₹', required: true, min: 1, style: 'width:110px', 'aria-label': 'Price in rupees' }),
    el('input', { class: 'inline-input', name: 'mrp', type: 'number', placeholder: 'MRP ₹', min: 1, style: 'width:110px', 'aria-label': 'MRP in rupees' }),
    el('input', { class: 'inline-input', name: 'stock', type: 'number', placeholder: 'Stock', required: true, min: 0, style: 'width:90px', 'aria-label': 'Stock' }),
    el('button', { type: 'submit', class: 'btn btn-sm' }, 'Add size'),
  ) as HTMLFormElement;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    try {
      await api(`/api/admin/products/${p.id}/variants`, {
        body: {
          colour: String(f.get('colour')).trim(), colourHex: String(f.get('colourHex')).toUpperCase(), size: String(f.get('size')).trim(),
          pricePaise: toPaise(String(f.get('price'))), mrpPaise: toPaise(String(f.get('mrp') ?? '')), stock: Number(f.get('stock')),
        },
      });
      toast('Size added.');
      await load();
    } catch (e2) {
      err(e2, 'Could not add.');
    }
  };
  return form;
}

function imagesBlock(p: P, imgs: I[], colours: string[]): HTMLElement {
  const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Choose photo' }) as HTMLInputElement;
  const colour = el('select', { class: 'inline-input', 'aria-label': 'Photo colour' }, el('option', { value: '' }, 'Any colour'), ...colours.map((c) => el('option', { value: c }, c))) as HTMLSelectElement;
  const up = el('button', { type: 'button', class: 'btn btn-sm' }, 'Upload photo');
  up.addEventListener('click', async () => {
    const f = file.files?.[0];
    if (!f) return toast('Choose a photo first.');
    if (f.size > 5 * 1024 * 1024) return toast('Photo must be 5 MB or smaller.');
    const form = new FormData();
    form.append('file', f);
    form.append('colour', colour.value);
    up.setAttribute('disabled', '');
    try {
      await api(`/api/admin/products/${p.id}/images`, { form });
      toast('Photo uploaded. Publish the storefront to show it in the shop.');
      await load();
    } catch (e) {
      err(e, 'Upload failed.');
    } finally {
      up.removeAttribute('disabled');
    }
  });
  return el('div', {},
    el('strong', {}, 'Photos'),
    el('div', { class: 'thumbs', style: 'margin:10px 0' },
      ...imgs.map((i) => {
        const del = el('button', { type: 'button', class: 'link-btn' }, 'Remove');
        let armed = false;
        del.addEventListener('click', async () => {
          if (!armed) { armed = true; del.textContent = 'Tap to confirm'; return; }
          try { await api(`/api/admin/images/${i.id}`, { method: 'DELETE', body: {} }); await load(); } catch (e) { err(e, 'Could not remove.'); }
        });
        return el('figure', {}, el('img', { src: imgSrc(i.src), alt: i.alt, loading: 'lazy' }), el('figcaption', {}, i.colour ?? 'Any colour'), del);
      }),
    ),
    el('div', { class: 'toolbar', style: 'gap:8px' }, file, colour, up),
    el('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'JPG, PNG or WebP, up to 5 MB. Portrait 3:4 photos look best.'),
  );
}

function sizeChartsBlock(): HTMLElement {
  const name = el('input', { class: 'inline-input', placeholder: 'Chart name, e.g. Women\u2019s T-shirt · S–3XL', maxlength: 80, 'aria-label': 'Size chart name' }) as HTMLInputElement;
  const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', 'aria-label': 'Choose size chart image' }) as HTMLInputElement;
  const up = el('button', { type: 'button', class: 'btn btn-sm' }, 'Upload chart');
  up.addEventListener('click', async () => {
    const f = file.files?.[0];
    if (name.value.trim().length < 2) return toast('Give the chart a name first.');
    if (!f) return toast('Choose the size chart image.');
    if (f.size > 5 * 1024 * 1024) return toast('Image must be 5 MB or smaller.');
    const form = new FormData();
    form.append('file', f);
    form.append('name', name.value.trim());
    up.setAttribute('disabled', '');
    try {
      await api('/api/admin/size-charts', { form });
      toast('Size chart added. Pick it in a product\u2019s details, then publish.');
      await load();
    } catch (e) {
      err(e, 'Upload failed.');
    } finally {
      up.removeAttribute('disabled');
    }
  });
  return el('div', {},
    el('div', { class: 'thumbs charts', style: 'margin:12px 0' },
      ...cat.sizeCharts.map((s) => {
        const del = el('button', { type: 'button', class: 'link-btn' }, 'Remove');
        let armed = false;
        del.addEventListener('click', async () => {
          if (!armed) { armed = true; del.textContent = s.used_by ? `Used by ${s.used_by} — tap to remove anyway` : 'Tap to confirm'; return; }
          try { await api(`/api/admin/size-charts/${s.id}`, { method: 'DELETE', body: {} }); await load(); } catch (e) { err(e, 'Could not remove.'); }
        });
        return el('figure', {},
          el('a', { href: imgSrc(s.src), target: '_blank', rel: 'noopener' }, el('img', { src: imgSrc(s.src), alt: s.name, loading: 'lazy' })),
          el('figcaption', {}, s.name, el('br'), el('span', { class: 'muted' }, s.used_by ? `Used by ${s.used_by} product${s.used_by === 1 ? '' : 's'}` : 'Not used yet')),
          del);
      }),
    ),
    el('div', { class: 'toolbar', style: 'gap:8px' }, name, file, up),
    el('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'Upload a chart once, then choose it on every product that uses it (product → Details → Size chart). JPG, PNG or WebP, up to 5 MB.'),
  );
}

function render() {
  setChildren($('[data-size-charts-body]'), sizeChartsBlock());
  const root = $('[data-products]');
  setChildren(root, ...cat.products.map((p) => {
    const vs = cat.variants.filter((v) => v.product_id === p.id);
    const imgs = cat.images.filter((i) => i.product_id === p.id);
    const stock = vs.reduce((a, v) => a + v.stock, 0);
    const low = vs.filter((v) => v.is_active && v.stock - v.reserved <= 2).length;
    const prices = vs.map((v) => v.price_paise);
    const d = el('details', { class: 'prod', open: openIds.has(p.id) }) as HTMLDetailsElement;
    d.addEventListener('toggle', () => (d.open ? openIds.add(p.id) : openIds.delete(p.id)));
    const editForm = el('form') as HTMLFormElement;
    productForm(editForm, p);
    d.append(
      el('summary', {},
        imgs[0] ? el('img', { src: imgSrc(imgs[0].src), alt: '' }) : el('span', { style: 'width:56px;height:70px;background:var(--placeholder);border-radius:4px' }),
        el('span', { style: 'flex:1;min-width:0' },
          el('strong', { style: 'display:block' }, p.name),
          el('span', { class: 'muted small' }, `${AUDIENCES.find((a) => a.id === p.audience)?.label ?? 'Unisex'} · ${cat.categories.find((c) => c.id === p.category_id)?.name ?? ''}${p.size_chart_id ? '' : ' · no size chart'} · ${prices.length ? formatINR(Math.min(...prices)) : 'no sizes yet'} · ${stock} in stock${low ? ` · ${low} size${low === 1 ? '' : 's'} low` : ''}`)),
        el('span', { class: `pill-s ${p.is_active ? 'st-paid' : 'st-cancelled'}` }, p.is_active ? 'In shop' : 'Hidden'),
      ),
      el('div', { class: 'pbody' },
        el('div', {}, el('strong', {}, 'Sizes, prices and stock'),
          el('div', { class: 'table-wrap', style: 'margin-top:8px' },
            el('table', { class: 'data vars', style: 'min-width:720px' },
              el('thead', {}, el('tr', {}, ...['Colour', 'Size', 'Price', 'MRP', 'Stock', 'Sell', ''].map((h) => el('th', {}, h)))),
              el('tbody', {}, ...vs.map(variantRow)))),
          el('div', { style: 'margin-top:10px' }, addVariantForm(p))),
        imagesBlock(p, imgs, [...new Set(vs.map((v) => v.colour))]),
        el('div', {}, el('strong', {}, 'Details'), editForm),
      ),
    );
    return d;
  }));
  const lp = cat.lastPublish;
  $('[data-publish-info]').textContent = lp ? `Last published ${new Date(lp.updated_at).toLocaleString('en-IN')} by ${lp.value}` : 'Not published from the panel yet';
}

async function load() {
  try {
    cat = await api<Catalog>('/api/admin/catalog');
    render();
    const nf = $('[data-product-form="new"]') as HTMLFormElement;
    // Rebuild the new-product form unless it is open (keeps the size-chart list current).
    if (!nf.childElementCount || !($('[data-new-product]') as HTMLDetailsElement).open) productForm(nf);
  } catch (e) {
    setChildren($('[data-products]'), el('p', {}, e instanceof HttpError ? e.message : 'Could not load products.'));
  }
}

$('[data-publish]').addEventListener('click', async () => {
  const b = $('[data-publish]') as HTMLButtonElement;
  b.disabled = true;
  try {
    const r = await api<{ message: string }>('/api/admin/publish', { body: {} });
    toast(r.message);
    await load();
  } catch (e) {
    err(e, 'Could not publish.');
  } finally {
    b.disabled = false;
  }
});

load();
