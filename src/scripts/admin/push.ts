import { api } from '../util';
import { me } from './shell';

function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/admin/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  if (!pushSupported()) {
    return { ok: false, message: /iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone, first add this admin panel to your Home Screen (Share → Add to Home Screen), then open it from there.' : 'This browser does not support push notifications.' };
  }
  const { vapidPublicKey } = await me;
  if (!vapidPublicKey) return { ok: false, message: 'Push is not configured on the server yet (VAPID keys).' };
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return { ok: false, message: 'Notifications are blocked. Allow them in your browser settings for this site.' };
  const reg = await navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidPublicKey) });
  await api('/api/admin/push-subscriptions', { body: { endpoint: sub.endpoint } });
  return { ok: true, message: 'Alerts are on for this device.' };
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/api/admin/push-subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}
