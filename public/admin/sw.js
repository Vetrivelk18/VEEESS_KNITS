// Veeess admin service worker: shows new-order alerts when the panel is closed.
// Pushes carry no data; we fetch the alert text from our own API instead.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let title = 'Veeess admin';
    let body = 'Alerts are working on this device.';
    let orderId = null;
    let count = 0;
    try {
      const res = await fetch('/api/admin/notifications?unread=1', { credentials: 'include', cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        count = data.unread || 0;
        const latest = data.items && data.items[0];
        if (latest) {
          title = latest.title;
          body = count > 1 ? `${latest.body} · ${count} unread` : latest.body;
          orderId = latest.order_id;
        }
      } else if (res.status === 401 || res.status === 403) {
        title = 'New order — sign in to view';
        body = 'Open the admin panel to see the order.';
      }
    } catch (_) {
      title = 'New order';
      body = 'Open the admin panel to see the order.';
    }
    await self.registration.showNotification(title, {
      body,
      tag: 'new-order',
      renotify: true,
      requireInteraction: true,
      icon: '/admin/icon-192.png',
      badge: '/admin/icon-192.png',
      data: { url: orderId ? `/admin/?order=${encodeURIComponent(orderId)}` : '/admin/' },
    });
    if (count && 'setAppBadge' in self.navigator) self.navigator.setAppBadge(count).catch(() => {});
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/admin/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).pathname.startsWith('/admin')) {
        await c.focus();
        return c.navigate(url);
      }
    }
    return self.clients.openWindow(url);
  })());
});
