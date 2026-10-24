// Small DOM helpers. All user-visible text is set with textContent — never
// innerHTML — so data from the server or the user can't inject markup.

type Attrs = Record<string, string | number | boolean | undefined | null | ((e: Event) => void)>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (typeof v === 'function') node.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function formatINR(paise: number): string {
  const r = paise / 100;
  return '₹' + r.toLocaleString('en-IN', { minimumFractionDigits: r % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public data: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const init: RequestInit = { method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'), credentials: 'same-origin', headers: {} };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new HttpError(0, 'network', 'Network problem. Check your connection and try again.');
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new HttpError(res.status, String(data.error ?? 'error'), String(data.message ?? 'Something went wrong.'), data);
  return data as T;
}

export function toast(message: string, link?: { href: string; text: string }, ms = 5000): void {
  const host = document.querySelector('[data-toasts]');
  if (!host) return;
  const t = el('div', { class: 'toast', role: 'status' }, el('span', { style: 'flex:1' }, message), link ? el('a', { href: link.href }, link.text) : null);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

/** replaceChildren that skips null/false entries (they would otherwise print as text). */
export function setChildren(node: Element, ...children: (Node | string | null | undefined | false)[]): void {
  node.replaceChildren(...(children.filter((c) => c !== null && c !== undefined && c !== false) as (Node | string)[]));
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const n = root.querySelector<HTMLElement>(sel);
  if (!n) throw new Error(`Missing element ${sel}`);
  return n;
}
