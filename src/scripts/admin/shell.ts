import { api, el, setChildren, $ } from '../util';

/**
 * Admin shell: who is signed in, the new-order bell, the toast + chime, and
 * polling every 20 seconds while the panel is open. Push notifications (for
 * when the panel is closed) are handled by the service worker in /admin/sw.js.
 */

interface Alert { id: number; order_id: string; title: string; body: string; created_at: string; read_at: string | null; read_by: string | null }
interface AlertsRes { unread: number; latestId: number; items: Alert[] }

const POLL_MS = 20_000;
let lastSeenId = Number(sessionStorage.getItem('vk_admin_last_alert') ?? '0');
let firstLoad = true;
let audio: AudioContext | null = null;

export const me = api<{ email: string; authMode: 'access' | 'local'; logoutUrl: string; vapidPublicKey: string | null; alertEmail: string | null }>('/api/admin/me');
me.then((m) => {
  $('[data-admin-email]').textContent = m.email;
  ($('[data-logout]') as HTMLAnchorElement).href = m.logoutUrl;
  if (m.authMode === 'local') $('[data-local-banner]').hidden = false;
  const ae = document.querySelector('[data-alert-email]');
  if (ae && m.alertEmail) ae.textContent = m.alertEmail;
}).catch(() => {});

// Browsers only allow sound after a user gesture; unlock it on the first click.
document.addEventListener('pointerdown', () => {
  if (!audio) {
    try {
      audio = new AudioContext();
    } catch {}
  }
  audio?.resume().catch(() => {});
}, { once: false, passive: true });

function chime() {
  if (!audio || audio.state !== 'running') return;
  const t = audio.currentTime;
  for (const [i, f] of [880, 1320].entries()) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = f;
    o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t + i * 0.18);
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.18 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.35);
    o.connect(g).connect(audio.destination);
    o.start(t + i * 0.18);
    o.stop(t + i * 0.18 + 0.4);
  }
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function openOrder(orderId: string) {
  if (location.pathname === '/admin/' || location.pathname === '/admin') {
    window.dispatchEvent(new CustomEvent('admin:open-order', { detail: orderId }));
  } else {
    location.href = `/admin/?order=${encodeURIComponent(orderId)}`;
  }
}

async function markRead(ids: number[] | 'all') {
  await api('/api/admin/notifications/read', { body: ids === 'all' ? { all: true } : { ids } }).catch(() => {});
  await poll();
  window.dispatchEvent(new CustomEvent('admin:refresh'));
}

function showToast(a: Alert) {
  const host = $('[data-toasts]');
  const t = el(
    'div',
    { class: 'toast', role: 'alert' },
    el('span', { style: 'flex:0 0 40px;height:40px;border-radius:50%;background:var(--marigold);color:var(--ink);display:flex;align-items:center;justify-content:center;font-weight:800' }, '!'),
    el(
      'div',
      { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px' },
      el('strong', {}, a.title),
      el('span', { style: 'font-size:14px;color:#d5d7de' }, a.body),
      el(
        'div',
        { style: 'display:flex;gap:8px;margin-top:6px' },
        el('button', { type: 'button', class: 'btn btn-accent btn-sm', onclick: () => { t.remove(); markRead([a.id]); openOrder(a.order_id); } }, 'View order'),
        el('button', { type: 'button', class: 'btn btn-sm', style: 'background:transparent;border-color:#4a4f5c', onclick: () => t.remove() }, 'Dismiss'),
      ),
    ),
  );
  host.append(t);
  setTimeout(() => t.remove(), 30_000);
}

function render(res: AlertsRes) {
  const badge = $('[data-bell-count]');
  badge.textContent = String(res.unread);
  badge.hidden = res.unread === 0;
  $('[data-bell]').setAttribute('aria-label', `New-order alerts, ${res.unread} unread`);
  document.title = document.title.replace(/^\(\d+\) /, '');
  if (res.unread) document.title = `(${res.unread}) ${document.title}`;
  const list = $('[data-bell-list]');
  if (!res.items.length) {
    setChildren(list, el('p', { class: 'muted', style: 'padding:16px;margin:0' }, 'No alerts yet.'));
    return;
  }
  setChildren(
    list,
    ...res.items.slice(0, 15).map((a) =>
      el(
        'button',
        { type: 'button', class: `bell-item${a.read_at ? '' : ' unread'}`, onclick: () => { markRead([a.id]); openOrder(a.order_id); closePanel(); } },
        el('span', { class: 'dot' }),
        el('span', { style: 'flex:1;min-width:0' },
          el('span', { class: 't' }, a.title),
          el('span', { class: 'b' }, a.body),
          el('span', { class: 'w' }, `${timeAgo(a.created_at)}${a.read_at ? ` · seen by ${a.read_by?.split('@')[0] ?? 'admin'}` : ''}`)),
      ),
    ),
  );
}

export async function poll(): Promise<void> {
  try {
    const res = await api<AlertsRes>('/api/admin/notifications');
    render(res);
    const fresh = res.items.filter((a) => a.id > lastSeenId && !a.read_at);
    if (!firstLoad && fresh.length) {
      fresh.slice(0, 3).reverse().forEach(showToast);
      chime();
      window.dispatchEvent(new CustomEvent('admin:refresh'));
    }
    if (res.latestId > lastSeenId) {
      lastSeenId = res.latestId;
      sessionStorage.setItem('vk_admin_last_alert', String(lastSeenId));
    }
    firstLoad = false;
  } catch {
    // Network blip: try again on the next tick.
  }
}

const panel = $('[data-bell-panel]');
const bell = $('[data-bell]');
function closePanel() {
  panel.hidden = true;
  bell.setAttribute('aria-expanded', 'false');
}
bell.addEventListener('click', (e) => {
  e.stopPropagation();
  panel.hidden = !panel.hidden;
  bell.setAttribute('aria-expanded', String(!panel.hidden));
});
document.addEventListener('click', (e) => {
  if (!panel.hidden && !panel.contains(e.target as Node)) closePanel();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanel();
});
$('[data-mark-all]').addEventListener('click', () => markRead('all'));

// First load: show unread as a toast once so nothing is missed after a reload.
poll().then(() => {
  firstLoad = false;
});
setInterval(() => {
  if (document.visibilityState === 'visible') poll();
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') poll();
});

// Register the service worker so push alerts can be switched on.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(() => {});
