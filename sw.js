const CACHE = 'pin-reminder-v2';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.svg', './icon-512.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const SCHEDULE_CACHE = 'pin-reminder-schedules';

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
      Promise.all(keys.filter(k => k !== CACHE && k !== SCHEDULE_CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim()).then(() => restoreSchedules())
  );
});

// ── Persistent schedule store (uses Cache API as key-value store) ──────────
async function saveSchedule(id, data) {
  const c = await caches.open(SCHEDULE_CACHE);
  const body = JSON.stringify(data);
  await c.put(new Request('schedule/' + id), new Response(body, { headers: { 'Content-Type': 'application/json' } }));
}
async function deleteSchedule(id) {
  const c = await caches.open(SCHEDULE_CACHE);
  await c.delete(new Request('schedule/' + id));
}
async function getAllSchedules() {
  const c = await caches.open(SCHEDULE_CACHE);
  const keys = await c.keys();
  const results = [];
  for (const req of keys) {
    const res = await c.match(req);
    if (res) {
      try { results.push(await res.json()); } catch(e) {}
    }
  }
  return results;
}
async function clearAllSchedules() {
  await caches.delete(SCHEDULE_CACHE);
}

// ── Scheduled notification timers ─────────────────────────────────────────
const timers = {};

function setTimer(id, title, note, fireAt) {
  if (timers[id]) clearTimeout(timers[id]);
  const delay = fireAt - Date.now();
  if (delay < 0) return;
  timers[id] = setTimeout(async () => {
    delete timers[id];
    await deleteSchedule(id);
    self.registration.showNotification('🔔 ' + title, {
      body: note || 'Tvoj podsjetnik je aktivan.',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'reminder-' + id,
      requireInteraction: true,
      silent: false,
      vibrate: [200, 100, 200, 100, 200],
      actions: [{ action: 'open', title: 'Unesi PIN' }],
      data: { reminderId: id, title, note }
    });
  }, delay);
}

async function restoreSchedules() {
  const schedules = await getAllSchedules();
  const now = Date.now();
  for (const s of schedules) {
    if (s.fireAt > now) {
      setTimer(s.id, s.title, s.note, s.fireAt);
    } else {
      // Missed — fire immediately for reminders that are very recent (within 5 min)
      if (now - s.fireAt < 5 * 60 * 1000) {
        await deleteSchedule(s.id);
        self.registration.showNotification('🔔 ' + s.title, {
          body: s.note || 'Tvoj podsjetnik je aktivan.',
          icon: './icon-192.png',
          badge: './icon-192.png',
          tag: 'reminder-' + s.id,
          requireInteraction: true,
          silent: false,
          vibrate: [200, 100, 200, 100, 200],
          actions: [{ action: 'open', title: 'Unesi PIN' }],
          data: { reminderId: s.id, title: s.title, note: s.note }
        });
      } else {
        await deleteSchedule(s.id);
      }
    }
  }
}

// ── Fetch (offline-first) ──────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { cacheName: CACHE }).then(r => r || fetch(e.request).then(res => {
      if (res && res.status === 200) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }))
  );
});

// ── Messages from page ─────────────────────────────────────────────────────
self.addEventListener('message', e => {
  const { type } = e.data;

  if (type === 'SCHEDULE') {
    const { id, title, note, fireAt } = e.data;
    saveSchedule(id, { id, title, note, fireAt });
    setTimer(id, title, note, fireAt);
  }

  if (type === 'CANCEL') {
    const { id } = e.data;
    if (timers[id]) { clearTimeout(timers[id]); delete timers[id]; }
    deleteSchedule(id);
  }

  if (type === 'CANCEL_ALL') {
    Object.keys(timers).forEach(id => clearTimeout(timers[id]));
    Object.keys(timers).forEach(id => delete timers[id]);
    clearAllSchedules();
  }
});

// ── Notification click → open app ─────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { reminderId, title, note } = e.notification.data || {};
  const payload = JSON.stringify({ type: 'ALARM', id: reminderId, title, note });

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length > 0) {
        const win = list[0];
        win.focus();
        win.postMessage({ type: 'ALARM', id: reminderId, title, note });
      } else {
        clients.openWindow('./?alarm=' + encodeURIComponent(payload));
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
      icon: './icon-192.png',
      requireInteraction: true,
      data: d
    })
  );
});
