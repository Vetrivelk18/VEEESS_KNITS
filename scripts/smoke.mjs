// Starts the Worker in the real Workers runtime (wrangler dev) and checks it
// boots and answers. Catches problems unit tests can't (e.g. start-up errors).
// Uses production settings (no .dev.vars) to prove the admin area stays locked.
import { spawn } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';

const PORT = 8799;
const devVars = new URL('../.dev.vars', import.meta.url);
const hidden = new URL('../.dev.vars.smoke-hidden', import.meta.url);
const hadDevVars = existsSync(devVars);
if (hadDevVars) renameSync(devVars, hidden);
const child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
const restore = () => { if (hadDevVars && existsSync(hidden)) renameSync(hidden, devVars); };
const done = (code, msg) => { console[code ? 'error' : 'log'](msg); child.kill(); restore(); process.exit(code); };
process.on('SIGINT', () => done(1, 'interrupted'));

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (/Workers runtime failed to start|Uncaught Error/.test(log)) done(1, `✖ Worker failed to start:\n${log.slice(-2000)}`);
  try {
    const h = await fetch(`${base}/api/health`);
    if (!h.ok) continue;
    const checks = [
      ['home page', (await fetch(`${base}/`)).status === 200],
      ['admin page locked without Access', (await fetch(`${base}/admin/`, { redirect: 'manual' })).status === 401],
      ['admin API locked without Access', (await fetch(`${base}/api/admin/me`)).status === 401],
      ['local sign-in absent in production mode', (await fetch(`${base}/__local/login`)).status === 404],
    ];
    const bad = checks.filter(([, ok]) => !ok);
    done(bad.length ? 1 : 0, checks.map(([n, ok]) => `${ok ? '✔' : '✖'} ${n}`).join('\n'));
  } catch {}
}
done(1, `✖ Worker did not answer within 60 s:\n${log.slice(-2000)}`);
