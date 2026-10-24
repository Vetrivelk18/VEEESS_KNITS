import { ApiError } from './http';

/**
 * Fixed-window rate limiter stored in D1 (works on the free plan).
 * Cloudflare's WAF rate-limiting rule (1 free rule) should ALSO be set on
 * /api/checkout as a first line of defence — see README.
 */
export async function rateLimit(db: D1Database, key: string, limit: number, windowSeconds: number): Promise<void> {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, windowStart)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) {
    throw new ApiError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.');
  }
}

export async function purgeOldRateLimits(db: D1Database): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?1').bind(cutoff).run();
}
