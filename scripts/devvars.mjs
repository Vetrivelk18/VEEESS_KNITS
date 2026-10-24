// Tiny .dev.vars reader/writer shared by the local setup scripts.
import { readFileSync, existsSync } from 'node:fs';
export const DEV_VARS = new URL('../.dev.vars', import.meta.url);
export const EXAMPLE = new URL('../.dev.vars.example', import.meta.url);
export function parseVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
export function readDevVars() {
  return existsSync(DEV_VARS) ? parseVars(readFileSync(DEV_VARS, 'utf8')) : null;
}
export function setVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}
