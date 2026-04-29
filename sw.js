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

// ── Persistent schedule store (Cache API as key-value) ─────────────────────
async function saveSchedule(id, data) {
  const c = await caches.open(SCHEDULE_CACHE);
  await c.put(new Request('schedule/' + id),
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
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
    if (res) { try { results.push(await res.json()); } catch(e) {} }
  }
  return results;
}
async function clearAllSchedules() {
  await caches.delete(SCHEDULE_CACHE);
}

// ── Show a persistent "pending" notification (silent, appears immediately) ─
async function showPendingNotification(id, title, note, time) {
  try {
    await self.registration.showNotification('📌 ' + title, {
      body: 'Alarm u ' + time + (note ? ' · ' + note : ''),
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'reminder-' + id,
      requireInteraction: true,
      silent: true,
      data: { reminderId: id, title, note, time, state: 'pending' }
    });
  } catch(_) {}
}

// ── Show the active alarm notification (sound + vibration) ────────────────
async function showAlarmNotification(id, title, note) {
  try {
    await self.registration.showNotification('🔔 ' + title, {
      body: (note ? note + '\n' : '') + 'Unesi PIN za gašenje alarma.',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'reminder-' + id,
      requireInteraction: true,
      silent: false,
      vibrate: [300, 150, 300, 150, 600],
      actions: [{ action: 'open', title: 'Unesi PIN' }],
      data: { reminderId: id, title, note, state: 'alarm' }
    });
  } catch(_) {}
}

// ── Timers ─────────────────────────────────────────────────────────────────
const timers = {};

function setAlarmTimer(id, title, note, time, fireAt) {
  if (timers[id]) clearTimeout(timers[id]);
  const delay = fireAt - Date.now();
  if (delay < 0) return;
  timers[id] = setTimeout(async () => {
    delete timers[id];
    await deleteSchedule(id);
    // Replace pending notification with alarm notification
    await showAlarmNotification(id, title, note);
    // Notify any open app windows
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of list) w.postMessage({ type: 'ALARM', id, title, note });
  }, delay);
}

// ── Restore schedules after SW restart ─────────────────────────────────────
async function restoreSchedules() {
  const schedules = await getAllSchedules();
  const now = Date.now();
  for (const s of schedules) {
    if (s.fireAt > now) {
      // Re-show the pending notification (in case it was dismissed while SW was dead)
      await showPendingNotification(s.id, s.title, s.note, s.time);
      setAlarmTimer(s.id, s.title, s.note, s.time, s.fireAt);
    } else if (now - s.fireAt < 10 * 60 * 1000) {
      // Missed alarm within 10 min — fire it now
      await deleteSchedule(s.id);
      await showAlarmNotification(s.id, s.title, s.note);
      const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of list) w.postMessage({ type: 'ALARM', id: s.id, title: s.title, note: s.note });
    } else {
      await deleteSchedule(s.id);
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
self.addEventListener('message', async e => {
  const { type } = e.data;

  if (type === 'SCHEDULE') {
    const { id, title, note, time, fireAt } = e.data;
    await saveSchedule(id, { id, title, note, time, fireAt });
    // Show notification immediately so it's visible in the notification bar
    await showPendingNotification(id, title, note, time);
    setAlarmTimer(id, title, note, time, fireAt);
  }

  if (type === 'DISMISS') {
    // Called after correct PIN entered — close the notification
    const { id } = e.data;
    const notifs = await self.registration.getNotifications({ tag: 'reminder-' + id });
    for (const n of notifs) n.close();
  }

  if (type === 'CANCEL') {
    const { id } = e.data;
    if (timers[id]) { clearTimeout(timers[id]); delete timers[id]; }
    await deleteSchedule(id);
    const notifs = await self.registration.getNotifications({ tag: 'reminder-' + id });
    for (const n of notifs) n.close();
  }

  if (type === 'CANCEL_ALL') {
    Object.keys(timers).forEach(id => clearTimeout(timers[id]));
    Object.keys(timers).forEach(id => delete timers[id]);
    await clearAllSchedules();
    const notifs = await self.registration.getNotifications();
    for (const n of notifs) n.close();
  }
});

// ── Notification click → open app ─────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  // Do NOT close the notification here — it stays until correct PIN is entered
  const { reminderId, title, note, state } = e.notification.data || {};

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
      if (list.length > 0) {
        const win = list[0];
        try { await win.focus(); } catch(_) {}
        // Always post ALARM for alarm-state notifications regardless of focus result
        if (state === 'alarm') {
          win.postMessage({ type: 'ALARM', id: reminderId, title, note });
        }
      } else {
        // App is closed — open it; URL param triggers alarm UI on load
        const url = state === 'alarm'
          ? './?alarm=' + encodeURIComponent(JSON.stringify({ type: 'ALARM', id: reminderId, title, note }))
          : './';
        await clients.openWindow(url);
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
