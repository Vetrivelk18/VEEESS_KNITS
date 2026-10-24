// Checks your computer is set up to test the shop and admin panel locally.
//   npm run check:local          full report
//   (also runs automatically before `npm run dev`; exits 1 on blocking problems)
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readDevVars } from './devvars.mjs';

const quiet = process.argv.includes('--quiet');
const errors = [];
const warns = [];
const oks = [];
const v = readDevVars();

if (!v) {
  errors.push('.dev.vars is missing → run: npm run setup:local');
} else {
  v.ENVIRONMENT === 'development' ? oks.push('ENVIRONMENT=development') : errors.push(`ENVIRONMENT is "${v.ENVIRONMENT ?? ''}" in .dev.vars → set ENVIRONMENT=development`);
  v.LOCAL_ADMIN_BYPASS === '1' ? oks.push('Local admin sign-in is on (LOCAL_ADMIN_BYPASS=1)') : errors.push('LOCAL_ADMIN_BYPASS is not 1 → add LOCAL_ADMIN_BYPASS=1 to .dev.vars (needed to open /admin locally)');
  const admins = (v.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  admins.length ? oks.push(`Admins: ${admins.join(', ')}`) : errors.push('ADMIN_EMAILS is empty in .dev.vars');
  if (v.DEV_ADMIN_EMAIL && !admins.includes(v.DEV_ADMIN_EMAIL.toLowerCase())) warns.push(`DEV_ADMIN_EMAIL (${v.DEV_ADMIN_EMAIL}) is not in ADMIN_EMAILS — it will not be pre-selected`);
  (v.ORDER_LINK_SECRET ?? '').length >= 32 ? oks.push('ORDER_LINK_SECRET set') : errors.push('ORDER_LINK_SECRET missing/short → run: npm run setup:local');
  v.RAZORPAY_MOCK === '1' ? oks.push('Payments are simulated (RAZORPAY_MOCK=1)') : (/REPLACE/.test(v.RAZORPAY_KEY_SECRET ?? 'REPLACE') ? errors.push('RAZORPAY_MOCK is off but Razorpay test keys are not set') : oks.push('Using Razorpay test keys'));
  v.VAPID_PUBLIC_KEY && v.VAPID_PRIVATE_JWK ? oks.push('Push alert keys present') : warns.push('No VAPID keys → push alerts off (run: npm run setup:local)');
}
try {
  const out = execFileSync('npx', ['wrangler', 'd1', 'migrations', 'list', 'veeess_db', '--local'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  /No migrations to apply/i.test(out) ? oks.push('Local database is up to date') : errors.push('Local database needs migrations → run: npm run db:migrate:local');
} catch {
  warns.push('Could not check the local database (run: npm run db:migrate:local)');
}

if (!quiet || errors.length) {
  console.log('\nLocal setup check');
  for (const o of oks) console.log(`  ✔ ${o}`);
  for (const w of warns) console.log(`  ! ${w}`);
  for (const e of errors) console.log(`  ✖ ${e}`);
  console.log(errors.length ? '\nFix the ✖ items, then run npm run dev again.\n' : '\nReady: npm run dev → http://localhost:8787/admin/\n');
}
process.exit(errors.length ? 1 : 0);
