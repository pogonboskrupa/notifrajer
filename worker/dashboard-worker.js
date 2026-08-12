// ── SINGLE-FILE VERSION for the Cloudflare Dashboard's browser code editor ──
// Same code as src/index.js + src/webpush.js, merged into one file (no
// imports) so it can be pasted directly into Workers & Pages → your worker →
// Edit Code in a phone/desktop browser, without needing wrangler or a
// terminal at all. See worker/README.md for the no-CLI deployment steps.
//
// If you ever move to the CLI workflow instead, use src/index.js +
// src/webpush.js (the split version) with `npx wrangler deploy` — don't
// maintain both forever, pick one path.

// ── Web Push (RFC 8291 message encryption + RFC 8292 VAPID) ────────────────
// Hand-rolled with the Web Crypto API — no `web-push` npm package, since it
// calls Node's `https.request` internally, which Workers doesn't implement.

function b64urlToBytes(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function encryptPayload(payloadBytes, p256dhB64url, authB64url) {
  const subscriberPublicKeyRaw = b64urlToBytes(p256dhB64url);
  const authSecret = b64urlToBytes(authB64url);

  const subscriberPublicKey = await crypto.subtle.importKey(
    'raw', subscriberPublicKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const ephemeralKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephemeralPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeralKeyPair.publicKey));

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: subscriberPublicKey }, ephemeralKeyPair.privateKey, 256)
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), subscriberPublicKeyRaw, ephemeralPublicRaw);
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const padded = concatBytes(new Uint8Array([0, 0]), payloadBytes);
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, rs, new Uint8Array([ephemeralPublicRaw.length]), ephemeralPublicRaw);
  return concatBytes(header, encrypted);
}

async function buildVapidJwt(privateKeyJwk, audience, subject) {
  const key = await crypto.subtle.importKey('jwk', privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: audience, exp: now + 12 * 3600, sub: subject };
  const enc = s => bytesToB64url(new TextEncoder().encode(JSON.stringify(s)));
  const unsigned = enc(header) + '.' + enc(claims);
  const sigBits = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + bytesToB64url(new Uint8Array(sigBits));
}

async function sendWebPush(sub, payloadObj, env) {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const encrypted = await encryptPayload(payloadBytes, sub.p256dh, sub.auth);

  const audience = new URL(sub.endpoint).origin;
  const vapidPrivJwk = JSON.parse(env.VAPID_PRIVATE_KEY_JWK);
  const jwt = await buildVapidJwt(vapidPrivJwk, audience, env.VAPID_SUBJECT);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    },
    body: encrypted
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}

// ── API + cron ───────────────────────────────────────────────────────────

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

// Mirrors computeNextFire()/repeatDays() in index.html and sw.js. All three
// reschedule independently, so they have to agree on the exact instant or a
// repeating alarm ends up a day apart between the phone and the server.
function repeatDays(repeat, days) {
  if (repeat === 'weekdays') return [1, 2, 3, 4, 5];
  if (repeat === 'custom') return (days && days.length) ? days : [0, 1, 2, 3, 4, 5, 6];
  return null;
}

// ── Local-time arithmetic in the user's zone ───────────────────────────────
// Workers run with TZ=UTC while the phone is wherever the user is, so every
// weekday and clock-time decision here goes through the IANA zone the client
// sent. Intl ships the full tz database including DST rules, which a flat
// "+24h" does not: on the spring-forward night 23:45 + 24h lands at 00:45 the
// *next* day, which silently shifts a weekday alarm onto the wrong day.
function tzParts(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const o = {};
  for (const part of dtf.formatToParts(new Date(ts))) o[part.type] = part.value;
  return { y: +o.year, mo: +o.month - 1, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}
function tzOffsetMs(ts, tz) {
  const p = tzParts(ts, tz);
  return Math.floor(ts / 1000) * 1000 - Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s);
}
// Two passes: the first guess uses the offset at the naive instant, the second
// re-reads it at that guess, which is what settles days where the offset moved.
function localToUtc(y, mo, d, h, mi, tz) {
  const naive = Date.UTC(y, mo, d, h, mi, 0);
  const guess = naive + tzOffsetMs(naive, tz);
  return naive + tzOffsetMs(guess, tz);
}

// Next occurrence of the reminder's local clock time strictly after prevFireAt,
// on a weekday the repeat rule allows. Rows written before the client started
// sending time/tz fall back to the old flat +24h step.
function nextFireAt(prevFireAt, repeat, days, time, tz) {
  if (!tz || !time) return prevFireAt + 24 * 60 * 60 * 1000;
  const hm = String(time).split(':');
  const h = +hm[0], mi = +hm[1];
  const p = tzParts(prevFireAt, tz);
  const allowed = repeatDays(repeat, days);
  for (let i = 1; i <= 15; i++) {
    const cand = new Date(Date.UTC(p.y, p.mo, p.d + i));
    if (allowed && allowed.indexOf(cand.getUTCDay()) === -1) continue;
    return localToUtc(cand.getUTCFullYear(), cand.getUTCMonth(), cand.getUTCDate(), h, mi, tz);
  }
  return prevFireAt + 24 * 60 * 60 * 1000;
}
function parseDays(raw) {
  if (!raw) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch (e) { return null; }
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
    `INSERT INTO reminders (id, device_id, title, note, fire_at, repeat, days, time, tz, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, note=excluded.note, fire_at=excluded.fire_at, repeat=excluded.repeat, days=excluded.days, time=excluded.time, tz=excluded.tz`
  ).bind(body.id, body.deviceId, body.title, body.note || '', body.fireAt, body.repeat || 'once',
         Array.isArray(body.days) ? JSON.stringify(body.days) : null,
         body.time || null, body.tz || null, Date.now()).run();
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
    if (!result.ok) continue;

    if (r.repeat === 'once') {
      await env.DB.prepare('DELETE FROM reminders WHERE id = ?').bind(r.id).run();
    } else {
      await env.DB.prepare('UPDATE reminders SET fire_at = ? WHERE id = ?').bind(nextFireAt(r.fire_at, r.repeat, parseDays(r.days), r.time, r.tz), r.id).run();
    }
  }
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fireDueReminders(env));
  }
};
