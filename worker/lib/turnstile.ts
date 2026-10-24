import { ApiError } from './http';
import type { Env } from './env';

/** Server-side Cloudflare Turnstile check. The browser widget alone is not enough. */
export async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<void> {
  if (!token || token.length > 2048) throw new ApiError(400, 'captcha_required', 'Please complete the security check.');
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  form.append('remoteip', ip);
  let ok = false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = (await res.json()) as { success?: boolean };
    ok = data.success === true;
  } catch (err) {
    // Fail closed: if we cannot verify, we do not accept the order.
    console.error('Turnstile verify failed', err instanceof Error ? err.message : err);
    throw new ApiError(503, 'captcha_unavailable', 'Security check is unavailable. Please try again shortly.');
  }
  if (!ok) throw new ApiError(400, 'captcha_failed', 'Security check failed. Please try again.');
}
