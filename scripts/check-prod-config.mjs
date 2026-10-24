// Deploy safety check: refuses to deploy if production config contains any
// local-testing setting. Runs before every deploy (npm run deploy and CI).
import { readFileSync } from 'node:fs';
const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
// Strip // and /* */ comments (outside of strings) to parse JSONC.
let out = '', inStr = false, i = 0;
while (i < raw.length) {
  const ch = raw[i], nx = raw[i + 1];
  if (inStr) { out += ch; if (ch === '\\') { out += nx; i += 2; continue; } if (ch === '"') inStr = false; i++; continue; }
  if (ch === '"') { inStr = true; out += ch; i++; continue; }
  if (ch === '/' && nx === '/') { while (i < raw.length && raw[i] !== '\n') i++; continue; }
  if (ch === '/' && nx === '*') { i += 2; while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++; i += 2; continue; }
  out += ch; i++;
}
const cfg = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
const vars = cfg.vars ?? {};
const problems = [];
if (vars.ENVIRONMENT !== 'production') problems.push(`vars.ENVIRONMENT must be "production" (is "${vars.ENVIRONMENT}")`);
for (const k of ['LOCAL_ADMIN_BYPASS', 'DEV_ADMIN_EMAIL', 'RAZORPAY_MOCK']) if (k in vars) problems.push(`${k} must not be in production vars`);
for (const env of Object.keys(cfg.env ?? {})) {
  const ev = cfg.env[env].vars ?? {};
  for (const k of ['LOCAL_ADMIN_BYPASS', 'DEV_ADMIN_EMAIL', 'RAZORPAY_MOCK']) if (k in ev) problems.push(`env.${env}.vars.${k} must not be deployed`);
}
if (problems.length) {
  console.error('✖ Refusing to deploy — local-only settings found in wrangler.jsonc:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
console.log('✔ Production config has no local-testing settings');
