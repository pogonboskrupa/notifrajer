const CACHE = 'pin-reminder-v13';
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

// Far-future items (calendar tasks months out) must not sit in the tray for
// months — the pending pin only appears once the alarm is within a day.
const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;
// How far past its fire time a missed alarm still gets caught up when the SW
// wakes back up (app opened, notification tapped, etc). The Android OS can
// kill a backgrounded SW indefinitely with nothing to wake it up in between,
// so 10 minutes was too tight — widened so "opened the app hours later"
// still surfaces the alarm instead of silently losing it.
const MISSED_ALARM_WINDOW_MS = 24 * 60 * 60 * 1000;

async function maybeShowPending(id, title, note, time, fireAt) {
  if (fireAt - Date.now() <= PENDING_WINDOW_MS) {
    await showPendingNotification(id, title, note, time);
  }
}

// ── Immediate "added" confirmation — proves the notification pipeline works
// the moment the user taps Add, regardless of how far off the alarm is ─────
async function showAddedConfirmation(label) {
  try {
    await self.registration.showNotification('✅ Dodano', {
      body: label,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'added-' + Date.now(),
      requireInteraction: false,
      silent: false
    });
  } catch(_) {}
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
// late=true means this fired from the missed-alarm catch-up path (the SW was
// killed in the background and only woke up once the app was reopened) —
// says so explicitly, since the vibration/sound won't have happened on time.
async function showAlarmNotification(id, title, note, late) {
  try {
    await self.registration.showNotification('🔔 ' + title, {
      body: (late ? '⏰ Zakasnio alarm — ' : '') + (note ? note + '\n' : '') + 'Unesi PIN za gašenje alarma.',
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
// Tags allowed to close without being re-shown (see notificationclose below)
const okToClose = new Set();

// setTimeout delays are a signed 32-bit int (~24.8 days); anything larger
// overflows and fires immediately, so long waits are chained in chunks.
const MAX_DELAY = 2147483647;

async function fireAlarm(id, title, note) {
  delete timers[id];
  await deleteSchedule(id);
  // Replace pending notification with alarm notification
  await showAlarmNotification(id, title, note);
  // Notify any open app windows
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of list) w.postMessage({ type: 'ALARM', id, title, note });
}

function setAlarmTimer(id, title, note, time, fireAt) {
  if (timers[id]) clearTimeout(timers[id]);
  const delay = fireAt - Date.now();
  if (delay < 0) return;
  if (delay > MAX_DELAY) {
    timers[id] = setTimeout(() => setAlarmTimer(id, title, note, time, fireAt), MAX_DELAY);
    return;
  }
  // Surface the pending pin once the alarm enters the 24h window
  if (delay > PENDING_WINDOW_MS) {
    timers[id] = setTimeout(() => {
      showPendingNotification(id, title, note, time);
      setAlarmTimer(id, title, note, time, fireAt);
    }, delay - PENDING_WINDOW_MS);
    return;
  }
  timers[id] = setTimeout(() => fireAlarm(id, title, note), delay);
}

// ── Restore schedules after SW restart ─────────────────────────────────────
async function restoreSchedules() {
  const schedules = await getAllSchedules();
  const now = Date.now();
  for (const s of schedules) {
    if (s.fireAt > now) {
      // Re-show the pending notification (in case it was dismissed while SW was dead)
      await maybeShowPending(s.id, s.title, s.note, s.time, s.fireAt);
      setAlarmTimer(s.id, s.title, s.note, s.time, s.fireAt);
    } else if (now - s.fireAt < MISSED_ALARM_WINDOW_MS) {
      // The SW was almost certainly killed by the OS while backgrounded, so
      // the setTimeout in setAlarmTimer never got to fire on time — this is
      // the only chance to catch up. Surface it late rather than silently
      // drop it; a delayed PIN alarm still beats no alarm at all.
      await deleteSchedule(s.id);
      await showAlarmNotification(s.id, s.title, s.note, true);
      const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const w of list) w.postMessage({ type: 'ALARM', id: s.id, title: s.title, note: s.note, late: true });
    } else {
      await deleteSchedule(s.id);
    }
  }
}

// ── Fetch (offline-first) ──────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  // Navigations (incl. ./?alarm=… from a notification click) carry a query
  // string that never matches a cached entry, so match the shell ignoring it.
  // Cache-first keeps the alarm screen instant on a tapped notification; the
  // shell is refreshed in the background for the next launch.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html', { cacheName: CACHE, ignoreSearch: true }).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put('./index.html', clone));
          }
          return res;
        });
        if (cached) { network.catch(() => {}); return cached; }
        return network.catch(() =>
          new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        );
      })
    );
    return;
  }

  // Only cache same-origin assets; third-party responses would bloat the cache.
  e.respondWith(
    caches.match(e.request, { cacheName: CACHE }).then(r => r || fetch(e.request).then(res => {
      if (res && res.status === 200 && new URL(e.request.url).origin === self.location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request, { cacheName: CACHE })))
  );
});

// ── Messages from page ─────────────────────────────────────────────────────
self.addEventListener('message', async e => {
  const { type } = e.data;

  if (type === 'SCHEDULE') {
    const { id, title, note, time, fireAt, confirmLabel } = e.data;
    await saveSchedule(id, { id, title, note, time, fireAt });
    // Show it in the notification bar once the alarm is near (within 24h)
    await maybeShowPending(id, title, note, time, fireAt);
    setAlarmTimer(id, title, note, time, fireAt);
    // confirmLabel is only set when the user just tapped Add — an immediate,
    // separate confirmation so it's obvious the notification pipeline works
    // right away, even for a calendar task scheduled months out.
    if (confirmLabel) await showAddedConfirmation(confirmLabel);
  }

  if (type === 'DISMISS') {
    // Called after correct PIN entered — close the notification
    const { id } = e.data;
    okToClose.add('reminder-' + id);
    const notifs = await self.registration.getNotifications({ tag: 'reminder-' + id });
    for (const n of notifs) n.close();
  }

  if (type === 'CANCEL') {
    const { id } = e.data;
    if (timers[id]) { clearTimeout(timers[id]); delete timers[id]; }
    await deleteSchedule(id);
    okToClose.add('reminder-' + id);
    const notifs = await self.registration.getNotifications({ tag: 'reminder-' + id });
    for (const n of notifs) n.close();
  }

  if (type === 'CANCEL_ALL') {
    Object.keys(timers).forEach(id => clearTimeout(timers[id]));
    Object.keys(timers).forEach(id => delete timers[id]);
    await clearAllSchedules();
    const notifs = await self.registration.getNotifications();
    for (const n of notifs) { okToClose.add(n.tag); n.close(); }
  }
});

// ── Re-show the alarm notification if it's swiped away without the PIN ─────
// requireInteraction only stops the OS auto-timeout — Android still lets the
// user swipe it away. There is no true "can't dismiss" flag in the Web
// Notifications API, so this is the closest equivalent: if an alarm
// notification closes for any reason other than our own DISMISS/CANCEL
// (tag recorded in okToClose first), put it right back.
self.addEventListener('notificationclose', e => {
  const n = e.notification;
  const { state } = n.data || {};
  if (state !== 'alarm') return;
  if (okToClose.has(n.tag)) { okToClose.delete(n.tag); return; }
  const { reminderId, title, note } = n.data;
  e.waitUntil(showAlarmNotification(reminderId, title, note));
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
