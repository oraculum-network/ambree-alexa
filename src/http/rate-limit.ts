// Token buckets per client key. The map is bounded: past `maxKeys`, the least
// recently used key is evicted first.

export interface RateLimiterOptions {
  perMinute: number;
  burst: number;
  maxKeys?: number;
  now?: () => number;
}

export type RateDecision = { ok: true } | { ok: false; retryAfterSec: number };

export interface RateLimiter {
  take(key: string): RateDecision;
  size(): number;
}

export const MAX_BUCKETS = 10_000;

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? MAX_BUCKETS;
  const perMs = opts.perMinute / 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();

  return {
    take(key) {
      const t = now();
      const prev = buckets.get(key);
      const tokens = prev ? Math.min(opts.burst, prev.tokens + (t - prev.at) * perMs) : opts.burst;
      buckets.delete(key); // re-insert to mark as most recently used
      if (tokens >= 1) {
        buckets.set(key, { tokens: tokens - 1, at: t });
        while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value as string);
        return { ok: true };
      }
      buckets.set(key, { tokens, at: t });
      while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value as string);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / perMs / 1000)) };
    },
    size: () => buckets.size,
  };
}

/** The per-route limits (requests a minute, burst), scaled by RATE_LIMIT_SCALE. */
export const LIMITS = {
  mcp: { perMinute: 120, burst: 30 },
  agent: { perMinute: 12, burst: 4 },
  unlock: { perMinute: 5, burst: 5 },
} as const;
