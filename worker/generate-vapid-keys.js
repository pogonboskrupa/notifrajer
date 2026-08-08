// Run locally with plain Node: `node generate-vapid-keys.js`
// No dependencies — uses Node's built-in crypto module.
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const pubJwk = publicKey.export({ format: 'jwk' });
const privJwk = privateKey.export({ format: 'jwk' });

const x = Buffer.from(pubJwk.x, 'base64');
const y = Buffer.from(pubJwk.y, 'base64');
const rawPublicKey = Buffer.concat([Buffer.from([0x04]), x, y]);

const fullPrivateJwk = { crv: 'P-256', kty: 'EC', x: pubJwk.x, y: pubJwk.y, d: privJwk.d };

console.log('VAPID_PUBLIC_KEY (paste into wrangler.toml [vars] AND index.html VAPID_PUBLIC_KEY):');
console.log(b64url(rawPublicKey));
console.log('');
console.log('VAPID_PRIVATE_KEY_JWK (paste when running: wrangler secret put VAPID_PRIVATE_KEY_JWK):');
console.log(JSON.stringify(fullPrivateJwk));
console.log('');
console.log('Keep the private key secret — never commit it, never put it in wrangler.toml.');
