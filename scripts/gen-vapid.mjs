// Generates a VAPID key pair for admin Web Push alerts.
// Put VAPID_PUBLIC_KEY in wrangler.jsonc vars and VAPID_PRIVATE_JWK as a secret:
//   npx wrangler secret put VAPID_PRIVATE_JWK   (paste the JSON line)
import { generateKeyPairSync } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
const pub = publicKey.export({ format: 'jwk' });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url');
console.log('VAPID_PUBLIC_KEY=' + raw);
console.log('VAPID_PRIVATE_JWK=' + JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }));
