// Напоминания глоссария: показываем уведомление, клик открывает сайт.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { body: event.data ? event.data.text() : '' }; }
  const base = self.registration.scope;
  event.waitUntil(self.registration.showNotification(d.title || 'Глоссарий', {
    body: d.body || '', data: { url: d.url || base }
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  }));
});
