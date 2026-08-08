// Hand-rolled Web Push (RFC 8291 message encryption + RFC 8292 VAPID) using
// only the standard Web Crypto API available natively in Workers — no
// nodejs_compat, no `web-push` npm package. That package internally calls
// Node's `https.request`, which Workers does not implement (fetch only), so
// it cannot run here regardless of crypto polyfills. This file is the whole
// protocol in ~100 lines, validated against a full encrypt/decrypt and
// JWT sign/verify round-trip before ever being pointed at a real push
// service (see the project's dev notes for that self-test script).

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

// Encrypts payloadBytes for a subscription's p256dh/auth keys (both base64url).
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

  const padded = concatBytes(new Uint8Array([0, 0]), payloadBytes); // no extra padding needed
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

// Sends one Web Push message. Returns { ok, status, gone } — gone=true means
// the subscription is dead (browser uninstalled it) and should be dropped.
export async function sendWebPush(sub, payloadObj, env) {
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
