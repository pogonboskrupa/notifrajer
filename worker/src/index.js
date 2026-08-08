import { sendWebPush } from './webpush.js';

// No cookie/session auth — deviceId (a random UUID minted client-side) is the
// only identity concept this single-user app has. Wildcard CORS is fine here
// because there is no session to hijack; the worst case of a leaked deviceId
// is someone scheduling junk reminders against it, not any real data exposure.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
function bad(msg, status = 400) { return json({ error: msg }, status); }

async function readJson(request) {
  try { return await request.json(); } catch (e) { return null; }
}

// Mirrors scheduleRem()'s "radni dani" weekend-skip in index.html so the
// server's independent reschedule-on-fire agrees with the client's.
function nextFireAt(prevFireAt, repeat) {
  let d = new Date(prevFireAt + 24 * 60 * 60 * 1000);
  if (repeat === 'weekdays') {
    let guard = 0;
    while ((d.getDay() === 0 || d.getDay() === 6) && guard++ < 7) d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return d.getTime();
}

async function handleSubscribe(request, env) {
  const body = await readJson(request);
  if (!body || !body.deviceId || !body.endpoint || !body.keys) return bad('missing deviceId/endpoint/keys');
  await env.DB.prepare(
    `INSERT INTO subscriptions (device_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET endpoint=excluded.endpoint, p256dh=excluded.p256dh, auth=excluded.auth`
  ).bind(body.deviceId, body.endpoint, body.keys.p256dh, body.keys.auth, Date.now()).run();
  return json({ ok: true });
}

async function handleSchedule(request, env) {
  const body = await readJson(request);
  if (!body || !body.deviceId || !body.id || !body.title || !body.fireAt) return bad('missing fields');
  await env.DB.prepare(
    `INSERT INTO reminders (id, device_id, title, note, fire_at, repeat, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, note=excluded.note, fire_at=excluded.fire_at, repeat=excluded.repeat`
  ).bind(body.id, body.deviceId, body.title, body.note || '', body.fireAt, body.repeat || 'once', Date.now()).run();
  return json({ ok: true });
}

async function handleCancel(request, env) {
  const body = await readJson(request);
  if (!body || !body.id) return bad('missing id');
  await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(body.id).run();
  return json({ ok: true });
}

async function handleCancelAll(request, env) {
  const body = await readJson(request);
  if (!body || !body.deviceId) return bad('missing deviceId');
  await env.DB.prepare('DELETE FROM reminders WHERE device_id = ?').bind(body.deviceId).run();
  await env.DB.prepare('DELETE FROM subscriptions WHERE device_id = ?').bind(body.deviceId).run();
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return bad('POST only', 405);

    const url = new URL(request.url);
    switch (url.pathname) {
      case '/api/subscribe':   return handleSubscribe(request, env);
      case '/api/schedule':    return handleSchedule(request, env);
      case '/api/cancel':      return handleCancel(request, env);
      case '/api/cancel-all':  return handleCancelAll(request, env);
      default:                 return bad('not found', 404);
    }
  },

  // Cron trigger (see wrangler.toml, runs every minute) — the reliable path:
  // fires independently of whether the phone's local service worker survived
  // in the background, because it's Google/Apple's push infrastructure that
  // wakes the device, not a setTimeout living inside a killable SW.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fireDueReminders(env));
  }
};

async function fireDueReminders(env) {
  const now = Date.now();
  const due = await env.DB.prepare('SELECT * FROM reminders WHERE fire_at <= ?').bind(now).all();

  for (const r of due.results) {
    const sub = await env.DB.prepare('SELECT * FROM subscriptions WHERE device_id = ?').bind(r.device_id).first();
    if (!sub) { await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id).run(); continue; }

    const result = await sendWebPush(sub, { type: 'ALARM', id: r.id, title: r.title, note: r.note || '' }, env)
      .catch(() => ({ ok: false, gone: false }));

    if (result.gone) {
      await env.DB.prepare('DELETE FROM subscriptions WHERE device_id = ?').bind(r.device_id).run();
      await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id).run();
      continue;
    }

    // A delivery failure that isn't "gone" (network blip, 5xx from the push
    // service) leaves the row untouched at its old fire_at — since fire_at
    // <= now stays true, next minute's cron tick retries it automatically.
    if (!result.ok) continue;

    if (r.repeat === 'once') {
      await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id).run();
    } else {
      await env.DB.prepare('UPDATE reminders SET fire_at = ? WHERE id = ?').bind(nextFireAt(r.fire_at, r.repeat), r.id).run();
    }
  }
}
