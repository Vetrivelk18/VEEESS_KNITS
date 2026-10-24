import { api, el, HttpError, setChildren, toast, $ } from '../util';
import { currentSubscription, disablePush, enablePush, pushSupported } from './push';
import './shell';

const sw = $('[data-push-switch]');
async function syncSwitch() {
  const sub = await currentSubscription().catch(() => null);
  sw.setAttribute('aria-checked', String(Boolean(sub) && 'Notification' in window && Notification.permission === 'granted'));
  if (!pushSupported()) $('[data-push-note]').textContent = 'This browser cannot receive push alerts. You will still get the in-panel alert and the backup email.';
}
sw.addEventListener('click', async () => {
  if (sw.getAttribute('aria-checked') === 'true') {
    await disablePush();
    toast('Alerts turned off for this device.');
  } else {
    const r = await enablePush().catch(() => ({ ok: false, message: 'Could not turn on alerts.' }));
    toast(r.message);
  }
  syncSwitch();
  loadDevices();
});

$('[data-test-push]').addEventListener('click', async () => {
  try {
    const r = await api<{ sent: number; failed: number }>('/api/admin/push/test', { body: {} });
    toast(r.sent ? `Test alert sent to ${r.sent} device${r.sent === 1 ? '' : 's'}.` : 'No devices have alerts turned on yet.');
  } catch (e) {
    toast(e instanceof HttpError ? e.message : 'Could not send.');
  }
});

async function loadDevices() {
  const r = await api<{ devices: { admin_email: string; user_agent: string; created_at: string; last_success_at: string | null; failures: number }[] }>('/api/admin/push-subscriptions').catch(() => ({ devices: [] }));
  const box = $('[data-devices]');
  if (!r.devices.length) return setChildren(box, el('p', { class: 'muted', style: 'margin:0' }, 'No devices yet. Turn alerts on above, on each admin\'s phone and laptop.'));
  setChildren(box, ...r.devices.map((d) => {
    const ua = d.user_agent;
    const kind = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Device';
    return el('div', { style: 'padding:6px 0;border-bottom:1px solid #eeede7' }, `${d.admin_email} · ${kind} · since ${new Date(d.created_at).toLocaleDateString('en-IN')}${d.last_success_at ? ' · last alert ' + new Date(d.last_success_at).toLocaleString('en-IN') : ''}${d.failures ? ` · ${d.failures} failed` : ''}`);
  }));
}

async function loadAudit() {
  const r = await api<{ entries: { admin_email: string; action: string; entity: string; entity_id: string; created_at: string }[] }>('/api/admin/audit').catch(() => ({ entries: [] }));
  setChildren($('[data-audit]'), ...r.entries.map((a) => el('tr', {},
    el('td', { style: 'white-space:nowrap' }, new Date(a.created_at).toLocaleString('en-IN')),
    el('td', {}, a.admin_email),
    el('td', {}, a.action),
    el('td', { class: 'muted small' }, `${a.entity} ${a.entity_id.slice(0, 8)}`))));
}

syncSwitch();
loadDevices();
loadAudit();
