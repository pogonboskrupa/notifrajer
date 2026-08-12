const CACHE = 'pin-reminder-v15';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.svg', './icon-512.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
const SCHEDULE_CACHE = 'pin-reminder-schedules';
// Empty = feature disabled. Must match the constant of the same name in
// index.html — see worker/README.md for deployment.
const PUSH_SERVER_URL = '';

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
    ).then(() => clients.claim()).then(() => ensureAwake())
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
    if (!req.url.includes('/schedule/')) continue;
    const res = await c.match(req);
    if (res) { try { results.push(await res.json()); } catch (e) {} }
  }
  return results;
}
async function clearAllSchedules() {
  await caches.delete(SCHEDULE_CACHE);
}

// A "this id just went off" marker that survives the SW being killed — the
// in-memory `timers` map does not, so an unbacked memory flag would let a
// late-arriving push re-ring an alarm the device already handled.
async function markFired(id) {
  const c = await caches.open(SCHEDULE_CACHE);
  await c.put(new Request('fired/' + id), new Response(String(Date.now())));
}
async function firedRecently(id, withinMs) {
  const c = await caches.open(SCHEDULE_CACHE);
  const res = await c.match(new Request('fired/' + id));
  if (!res) return false;
  const t = Number(await res.text());
  return Number.isFinite(t) && Date.now() - t < withinMs;
}

// ── Repeat logic ───────────────────────────────────────────────────────────
// Kept byte-for-byte identical to computeNextFire()/repeatDays() in
// index.html. The two run independently (SW timer vs. page fallback) and must
// land on the same instant, or a repeating alarm drifts a day apart between
// them and fires twice.
function repeatDays(repeat, days) {
  if (repeat === 'weekdays') return [1, 2, 3, 4, 5];
  if (repeat === 'custom') return (days && days.length) ? days : [0, 1, 2, 3, 4, 5, 6];
  return null; // once | daily → any day of the week is fine
}
function computeNextFire(time, repeat, days, from) {
  const base = new Date(from || Date.now());
  const p = String(time).split(':');
  const fire = new Date(base);
  fire.setHours(+p[0], +p[1], 0, 0);
  if (fire.getTime() <= base.getTime()) fire.setDate(fire.getDate() + 1);
  const allowed = repeatDays(repeat, days);
  if (allowed) {
    let guard = 0;
    while (allowed.indexOf(fire.getDay()) === -1 && guard++ < 14) fire.setDate(fire.getDate() + 1);
  }
  return fire.getTime();
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
// A push for an alarm this device already rang within this window is a
// duplicate of the server's safety-net sweep, not a second alarm.
const PUSH_DEDUP_MS = 5 * 60 * 1000;

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
  } catch (_) {}
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
  } catch (_) {}
}

// ── Show the active alarm notification (sound + vibration) ────────────────
// late=true means this fired from the missed-alarm catch-up path (the SW was
// killed in the background and only woke up once the app was reopened) —
// says so explicitly, since the vibration/sound won't have happened on time.
async function showAlarmNotification(id, title, note, late, snoozeMin) {
  const snooze = snoozeMin || 10;
  try {
    await self.registration.showNotification('🔔 ' + title, {
      body: (late ? '⏰ Zakasnio alarm — ' : '') + (note ? note + '\n' : '') + 'Unesi PIN za gašenje alarma.',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'reminder-' + id,
      requireInteraction: true,
      silent: false,
      vibrate: [300, 150, 300, 150, 600],
      actions: [
        { action: 'open', title: 'Unesi PIN' },
        { action: 'snooze', title: 'Odgodi ' + snooze + ' min' }
      ],
      data: { reminderId: id, title, note, state: 'alarm', late: !!late, snooze }
    });
  } catch (_) {}
}

// ── Timers ─────────────────────────────────────────────────────────────────
const timers = {};
// Tags allowed to close without being re-shown (see notificationclose below)
const okToClose = new Set();

// setTimeout delays are a signed 32-bit int (~24.8 days); anything larger
// overflows and fires immediately, so long waits are chained in chunks.
const MAX_DELAY = 2147483647;

async function fireAlarm(s) {
  delete timers[s.id];
  await markFired(s.id);

  // A repeating reminder must re-arm itself here, not wait for the page to do
  // it on next open — otherwise a phone left untouched for days rings once and
  // then goes quiet, which is the exact failure this app exists to prevent.
  const next = (s.repeat && s.repeat !== 'once')
    ? computeNextFire(s.time, s.repeat, s.days, Date.now())
    : null;
  if (next) {
    const nextEntry = Object.assign({}, s, { fireAt: next });
    await saveSchedule(s.id, nextEntry);
    scheduleTimer(nextEntry);
  } else {
    await deleteSchedule(s.id);
  }

  await showAlarmNotification(s.id, s.title, s.note, s.late, s.snooze);
  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of list) w.postMessage({ type: 'ALARM', id: s.id, title: s.title, note: s.note, late: !!s.late });
  notifyServerFired(s.id); // best-effort — stop the push server from also firing this one
}

// Tells the push server this device already handled the alarm locally and
// on time, so its cron sweep won't send a redundant push for it later.
// Fire-and-forget: if it fails (offline, server not deployed), the push
// path's own dedup check (fired marker + schedule entry) is the real safety
// net, this is just an optimization to avoid a double-fire.
function notifyServerFired(id) {
  if (!PUSH_SERVER_URL) return;
  fetch(PUSH_SERVER_URL + '/api/cancel', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  }).catch(() => {});
}

function scheduleTimer(s) {
  if (timers[s.id] != null) clearTimeout(timers[s.id]);
  const delay = s.fireAt - Date.now();
  if (delay < 0) return;
  if (delay > MAX_DELAY) {
    timers[s.id] = setTimeout(() => scheduleTimer(s), MAX_DELAY);
    return;
  }
  // Surface the pending pin once the alarm enters the 24h window
  if (delay > PENDING_WINDOW_MS) {
    timers[s.id] = setTimeout(() => {
      showPendingNotification(s.id, s.title, s.note, s.time);
      scheduleTimer(s);
    }, delay - PENDING_WINDOW_MS);
    return;
  }
  timers[s.id] = setTimeout(() => fireAlarm(s), delay);
}

// ── Catch-up sweep ─────────────────────────────────────────────────────────
// Re-arms every stored schedule and rings anything already overdue. Safe to
// run repeatedly: scheduleTimer() clears the previous timer for an id first,
// and anything it fires is removed from (or advanced in) the store.
async function syncSchedules() {
  const schedules = await getAllSchedules();
  const now = Date.now();
  for (const s of schedules) {
    if (s.fireAt > now) {
      // Re-show the pending notification (in case it was dismissed while SW was dead)
      await maybeShowPending(s.id, s.title, s.note, s.time, s.fireAt);
      scheduleTimer(s);
    } else if (now - s.fireAt < MISSED_ALARM_WINDOW_MS) {
      // The SW was almost certainly killed by the OS while backgrounded, so
      // the setTimeout in scheduleTimer never got to fire on time — this is
      // the only chance to catch up. Surface it late rather than silently
      // drop it; a delayed PIN alarm still beats no alarm at all.
      if (await firedRecently(s.id, PUSH_DEDUP_MS)) continue;
      await fireAlarm(Object.assign({}, s, { late: true }));
    } else {
      await deleteSchedule(s.id);
    }
  }
}

// A restarted service worker starts with an empty `timers` map, and `activate`
// does NOT fire again on that restart — only on a version change. So every
// entry point below funnels through this once-per-lifetime rehydrate, or a SW
// woken by a fetch/push/click would sit there with no timers armed at all and
// every pending alarm would silently never ring.
let awake = null;
function ensureAwake() {
  if (!awake) awake = syncSchedules().catch(() => {});
  return awake;
}

// ── Fetch (offline-first) ──────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  ensureAwake();

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
self.addEventListener('message', e => {
  if (!e.data || !e.data.type) return;
  e.waitUntil(handleMessage(e.data));
});

async function handleMessage(data) {
  await ensureAwake();
  const type = data.type;

  if (type === 'SCHEDULE') {
    const entry = {
      id: data.id, title: data.title, note: data.note, time: data.time,
      fireAt: data.fireAt, repeat: data.repeat || 'once', days: data.days || null,
      snooze: data.snooze || 10
    };
    await saveSchedule(entry.id, entry);
    // Show it in the notification bar once the alarm is near (within 24h)
    await maybeShowPending(entry.id, entry.title, entry.note, entry.time, entry.fireAt);
    scheduleTimer(entry);
    // confirmLabel is only set when the user just tapped Add — an immediate,
    // separate confirmation so it's obvious the notification pipeline works
    // right away, even for a calendar task scheduled months out.
    if (data.confirmLabel) await showAddedConfirmation(data.confirmLabel);
  }

  if (type === 'SNOOZE') {
    await snooze(data.id, data.minutes || 10);
  }

  if (type === 'DISMISS') {
    // Called after correct PIN entered — close the notification
    okToClose.add('reminder-' + data.id);
    const notifs = await self.registration.getNotifications({ tag: 'reminder-' + data.id });
    for (const n of notifs) n.close();
  }

  if (type === 'CANCEL') {
    if (timers[data.id] != null) { clearTimeout(timers[data.id]); delete timers[data.id]; }
    await deleteSchedule(data.id);
    okToClose.add('reminder-' + data.id);
    const notifs = await self.registration.getNotifications({ tag: 'reminder-' + data.id });
    for (const n of notifs) n.close();
  }

  if (type === 'CANCEL_ALL') {
    Object.keys(timers).forEach(id => { clearTimeout(timers[id]); delete timers[id]; });
    await clearAllSchedules();
    const notifs = await self.registration.getNotifications();
    for (const n of notifs) { okToClose.add(n.tag); n.close(); }
  }

  if (type === 'SYNC') {
    // Page came back to the foreground — re-check for anything the OS slept
    // through while the app was backgrounded.
    await syncSchedules();
  }

  if (type === 'TEST') {
    const at = Date.now() + (data.seconds || 10) * 1000;
    const entry = {
      id: 'test-' + Date.now(), title: 'Test notifikacije', note: 'Ako vidiš ovo, alarmi rade.',
      time: new Date(at).toTimeString().slice(0, 5), fireAt: at, repeat: 'once', days: null
    };
    await saveSchedule(entry.id, entry);
    scheduleTimer(entry);
    await showAddedConfirmation('Test alarm za ' + (data.seconds || 10) + ' sekundi — zatvori app da provjeriš pozadinu.');
  }
}

// Pushes one alarm back by N minutes without touching its repeat schedule:
// the snoozed copy keeps repeat 'once' so ringing again in 10 minutes can't
// also shift tomorrow's occurrence.
async function snooze(id, minutes) {
  const schedules = await getAllSchedules();
  const existing = schedules.filter(s => s.id == id)[0];
  const notifs = await self.registration.getNotifications({ tag: 'reminder-' + id });
  const fromNotif = notifs[0] && notifs[0].data;
  const title = (existing && existing.title) || (fromNotif && fromNotif.title) || 'Podsjetnik';
  const note = (existing && existing.note) || (fromNotif && fromNotif.note) || '';

  okToClose.add('reminder-' + id);
  for (const n of notifs) n.close();

  const at = Date.now() + minutes * 60 * 1000;
  const entry = {
    id: id, title: title, note: note,
    time: new Date(at).toTimeString().slice(0, 5),
    fireAt: at, repeat: 'once', days: null,
    snooze: (existing && existing.snooze) || minutes
  };
  // Keep the real repeating schedule alive under a separate id so snoozing an
  // alarm never silently cancels tomorrow's.
  if (existing && existing.repeat && existing.repeat !== 'once') {
    entry.id = 'snz-' + id;
    await saveSchedule(id, existing);
    scheduleTimer(existing);
  }
  await saveSchedule(entry.id, entry);
  scheduleTimer(entry);

  const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of list) w.postMessage({ type: 'SNOOZED', id: id, minutes: minutes });
}

// ── Re-show the alarm notification if it's swiped away without the PIN ─────
// requireInteraction only stops the OS auto-timeout — Android still lets the
// user swipe it away. There is no true "can't dismiss" flag in the Web
// Notifications API, so this is the closest equivalent: if an alarm
// notification closes for any reason other than our own DISMISS/CANCEL/SNOOZE
// (tag recorded in okToClose first), put it right back.
self.addEventListener('notificationclose', e => {
  const n = e.notification;
  const { state } = n.data || {};
  if (state !== 'alarm') return;
  if (okToClose.has(n.tag)) { okToClose.delete(n.tag); return; }
  const { reminderId, title, note, late, snooze } = n.data;
  e.waitUntil(showAlarmNotification(reminderId, title, note, late, snooze));
});

// ── Notification click → open app ─────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {};
  const { reminderId, title, note, state } = d;

  if (e.action === 'snooze') {
    e.waitUntil(ensureAwake().then(() => snooze(reminderId, d.snooze || 10)));
    return;
  }

  // Do NOT close the notification here — it stays until correct PIN is entered
  e.waitUntil(
    ensureAwake().then(() => clients.matchAll({ type: 'window', includeUncontrolled: true })).then(async list => {
      if (list.length > 0) {
        const win = list[0];
        try { await win.focus(); } catch (_) {}
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

// ── Push — the reliable backup path when this device's own setTimeout got
// killed in the background (see worker/README.md) ──────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  let d;
  try { d = e.data.json(); } catch (_) { return; }
  if (d.type !== 'ALARM') return;
  e.waitUntil(ensureAwake().then(() => handlePushAlarm(d)));
});

async function handlePushAlarm(d) {
  // Dedup against local scheduling. Two independent checks, because either
  // one alone has a hole: the fired marker catches "our timer already rang
  // this minute" (a repeating alarm re-arms itself, so its schedule entry is
  // back and would look pending again), and the schedule lookup catches
  // "the user cancelled it, but the server hasn't heard yet".
  if (await firedRecently(d.id, PUSH_DEDUP_MS)) return;
  const schedules = await getAllSchedules();
  const entry = schedules.filter(s => s.id == d.id)[0];
  if (!entry) return;

  if (timers[d.id] != null) { clearTimeout(timers[d.id]); delete timers[d.id]; }
  await fireAlarm(Object.assign({}, entry, { title: d.title || entry.title, note: d.note || entry.note }));
}

// ── Periodic background sync ───────────────────────────────────────────────
// Chrome on Android grants installed PWAs an occasional background wake-up
// (interval is the browser's call, not ours). Not a replacement for push —
// just one more chance to notice a missed alarm without the user opening the
// app. Silently absent on browsers that don't implement it.
self.addEventListener('periodicsync', e => {
  if (e.tag === 'alarm-check') e.waitUntil(ensureAwake().then(() => syncSchedules()));
});

self.addEventListener('sync', e => {
  if (e.tag === 'alarm-check') e.waitUntil(ensureAwake().then(() => syncSchedules()));
});
