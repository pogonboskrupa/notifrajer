const CACHE = 'pin-reminder-v1';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.svg', '/icon-512.svg'];

// ── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// ── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

// ── Fetch (offline-first) ──────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res && res.status === 200 && e.request.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});

// ── Scheduled notification timers ─────────────────────────────────────────
const timers = {};

self.addEventListener('message', e => {
  const { type } = e.data;

  if (type === 'SCHEDULE') {
    const { id, title, note, fireAt } = e.data;
    const delay = fireAt - Date.now();
    if (delay < 0) return;

    if (timers[id]) clearTimeout(timers[id]);
    timers[id] = setTimeout(() => {
      delete timers[id];
      self.registration.showNotification('🔔 ' + title, {
        body: note || 'Tvoj podsjetnik je aktivan.',
        icon: '/icon-192.svg',
        badge: '/icon-192.svg',
        tag: 'reminder-' + id,
        requireInteraction: true,
        silent: false,
        vibrate: [200, 100, 200, 100, 200],
        actions: [
          { action: 'open', title: 'Unesi PIN' }
        ],
        data: { reminderId: id, title, note }
      });
    }, delay);
  }

  if (type === 'CANCEL') {
    const { id } = e.data;
    if (timers[id]) { clearTimeout(timers[id]); delete timers[id]; }
  }

  if (type === 'CANCEL_ALL') {
    Object.keys(timers).forEach(id => clearTimeout(timers[id]));
    Object.keys(timers).forEach(id => delete timers[id]);
  }
});

// ── Notification click → open app ─────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { reminderId, title, note } = e.notification.data || {};

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const payload = JSON.stringify({ type: 'ALARM', id: reminderId, title, note });
      if (list.length > 0) {
        const win = list[0];
        win.focus();
        win.postMessage({ type: 'ALARM', id: reminderId, title, note });
      } else {
        clients.openWindow('/?alarm=' + encodeURIComponent(payload));
      }
    })
  );
});

// ── Push (future use) ──────────────────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  const d = e.data.json();
  e.waitUntil(
    self.registration.showNotification('🔔 ' + (d.title || 'Podsjetnik'), {
      body: d.note || '',
      icon: '/icon-192.svg',
      requireInteraction: true,
      data: d
    })
  );
});
