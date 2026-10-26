// One-time local setup: creates .dev.vars (local sign-in on, mock payments),
// generates secrets and keys, and prepares the local database.
//   npm run setup:local
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { DEV_VARS, EXAMPLE, parseVars, setVar } from './devvars.mjs';

if (!existsSync(DEV_VARS)) {
  copyFileSync(EXAMPLE, DEV_VARS);
  console.log('✔ Created .dev.vars from .dev.vars.example');
} else {
  console.log('• .dev.vars already exists — keeping your values, filling only blanks');
}
let text = readFileSync(DEV_VARS, 'utf8');
const vars = parseVars(text);
const ensure = (k, v) => { if (!vars[k]) { text = setVar(text, k, v); console.log(`✔ Set ${k}`); } };
ensure('ENVIRONMENT', 'development');
ensure('LOCAL_ADMIN_BYPASS', '1');
ensure('ADMIN_EMAILS', 'admin1@example.com,admin2@example.com,admin3@example.com');
ensure('ORDER_LINK_SECRET', randomBytes(32).toString('base64url'));
if (!vars.VAPID_PUBLIC_KEY || !vars.VAPID_PRIVATE_JWK) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const j = privateKey.export({ format: 'jwk' });
  const p = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(p.x, 'base64url'), Buffer.from(p.y, 'base64url')]).toString('base64url');
  text = setVar(text, 'VAPID_PUBLIC_KEY', raw);
  text = setVar(text, 'VAPID_PRIVATE_JWK', `'${JSON.stringify({ kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d })}'`);
  console.log('✔ Generated VAPID keys for push alerts');
}
writeFileSync(DEV_VARS, text);

console.log('• Applying database migrations to the local database…');
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'veeess_db', '--local'], { stdio: 'inherit' });
console.log('\nAll set. Next:\n  npm run dev\n  open http://localhost:8787/admin/  (local sign-in page)\n');
