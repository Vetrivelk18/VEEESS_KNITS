export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;

  ENVIRONMENT: 'production' | 'development' | string;
  SITE_URL: string;
  ADMIN_EMAILS: string;
  DEV_ADMIN_EMAIL?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;

  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET: string;
  RAZORPAY_MOCK?: string;

  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;

  ORDER_LINK_SECRET: string;

  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT: string;

  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  ALERT_EMAIL_TO: string;

  FREE_SHIPPING_MIN_PAISE: string;
  SHIPPING_FEE_PAISE: string;
  COD_MAX_OPEN_PER_PHONE: string;
  COD_MAX_ORDER_PAISE: string;
  ORDER_EXPIRY_MINUTES: string;
  MEDIA_BASE_URL: string;

  GITHUB_REPO?: string;
  GITHUB_DISPATCH_TOKEN?: string;
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export function isDev(env: Env): boolean {
  return env.ENVIRONMENT === 'development';
}

/** Dev-only features also require the request to come from localhost. */
export function isLocalDevRequest(env: Env, req: Request): boolean {
  if (!isDev(env)) return false;
  const host = new URL(req.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function adminEmails(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Fails closed: refuses to run payments with missing or placeholder secrets. */
export function assertSecrets(env: Env, names: (keyof Env)[]): void {
  for (const n of names) {
    const v = env[n];
    if (typeof v !== 'string' || v.length < 8 || /REPLACE/i.test(v)) {
      throw new Error(`Missing or placeholder secret: ${String(n)}`);
    }
  }
}
