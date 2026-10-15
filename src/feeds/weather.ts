// Hourly forecasts from MET Norway Locationforecast 2.0 (/complete).
//
// Why MET Norway: free for commercial use under CC BY 4.0 (credit "Data from MET
// Norway"), global coverage, no API key. Its terms, which this client follows:
//   - identify with a descriptive User-Agent (app name and site);
//   - cache, never re-request before the Expires header, and send If-Modified-Since
//     on refresh (a 304 keeps the cached copy);
//   - truncate coordinates (we use 2 decimals: one fixed point per area);
//   - tell users when the data was retrieved (retrieved_at in every result).
// A 203 means this product version is deprecated: logged once.
//
// Robustness: a 4 s timeout, a 1 MB cap, strict shape checks, stale-if-error for up
// to 12 hours and a 5-minute back-off after a failure, so a slow or broken feed never
// breaks a tool: callers get { status: "unavailable" } and say so honestly.
// The cache is in memory only.

import type { Logger } from "../log.ts";
import { FeedFetchError, type FetchLike, fetchCapped } from "./fetch.ts";

export const WEATHER_ATTRIBUTION = "Data from MET Norway (CC BY 4.0)";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // when Expires is missing or already past
const MAX_TTL_MS = 6 * 60 * 60 * 1000;
export const WEATHER_STALE_MAX_MS = 12 * 60 * 60 * 1000;
export const WEATHER_BACKOFF_MS = 5 * 60 * 1000;
const MAX_CACHE_KEYS = 200;

export interface HourStep {
  /** Start of the hour (UTC ms). */
  time: number;
  tempC: number | null;
  precipMm: number | null;
  /** Percent, when MET provides it for the region. */
  precipProb: number | null;
  windMs: number | null;
  symbol: string | null;
}

export type WeatherFailure = "disabled" | "timeout" | "network" | "http" | "malformed" | "empty";

export interface WeatherReport {
  status: "ok" | "stale" | "unavailable";
  reason?: WeatherFailure;
  steps: HourStep[];
  /** When we fetched (or revalidated) it, UTC ms. */
  fetchedAt: number | null;
  /** The forecast model's own update time (ISO), when given. */
  updatedAt: string | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown, min: number, max: number): number | null =>
  typeof x === "number" && Number.isFinite(x) && x >= min && x <= max ? x : null;

/** Hourly steps from a Locationforecast response; null when the shape is wrong. */
export function parseLocationforecast(json: unknown): { steps: HourStep[]; updatedAt: string | null } | null {
  if (!isObj(json) || !isObj(json.properties) || !Array.isArray(json.properties.timeseries)) return null;
  const series = json.properties.timeseries as unknown[];
  if (series.length > 1000) return null;
  const steps: HourStep[] = [];
  for (const s of series) {
    if (!isObj(s) || typeof s.time !== "string" || !isObj(s.data)) continue;
    const t = Date.parse(s.time);
    if (!Number.isFinite(t)) continue;
    const n1 = s.data.next_1_hours;
    if (!isObj(n1)) continue; // hourly steps only; the 6-hourly tail is out of our range
    const instant = isObj(s.data.instant) && isObj(s.data.instant.details) ? s.data.instant.details : {};
    const d1 = isObj(n1.details) ? n1.details : {};
    const code = isObj(n1.summary) && typeof n1.summary.symbol_code === "string" ? n1.summary.symbol_code.slice(0, 60) : null;
    steps.push({
      time: t,
      tempC: num(instant.air_temperature, -60, 60),
      precipMm: num(d1.precipitation_amount, 0, 500),
      precipProb: num(d1.probability_of_precipitation, 0, 100),
      windMs: num(instant.wind_speed, 0, 100),
      symbol: code && /^[a-z_]+$/.test(code) ? code : null,
    });
  }
  steps.sort((a, b) => a.time - b.time);
  const meta = isObj(json.properties.meta) ? json.properties.meta : {};
  const updatedAt = typeof meta.updated_at === "string" && Number.isFinite(Date.parse(meta.updated_at)) ? meta.updated_at : null;
  return { steps, updatedAt };
}

interface Entry {
  steps: HourStep[];
  fetchedAt: number;
  expiresAt: number;
  lastModified: string | null;
  updatedAt: string | null;
}

export interface WeatherClientOptions {
  url: string;
  userAgent: string;
  enabled: boolean;
  log: Logger;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface WeatherClient {
  get(lat: number, lon: number, now?: number): Promise<WeatherReport>;
  /** Forget the cache, back-offs and the 203 flag (tests). */
  reset(): void;
}

export function createWeatherClient(opts: WeatherClientOptions): WeatherClient {
  const cache = new Map<string, Entry>();
  const fail = new Map<string, { at: number; reason: WeatherFailure }>();
  const inflight = new Map<string, Promise<WeatherReport>>();
  let warned203 = false;

  const ok = (e: Entry, stale: boolean): WeatherReport => ({
    status: stale ? "stale" : "ok",
    steps: e.steps,
    fetchedAt: e.fetchedAt,
    updatedAt: e.updatedAt,
  });
  const unavailable = (reason: WeatherFailure): WeatherReport => ({ status: "unavailable", reason, steps: [], fetchedAt: null, updatedAt: null });

  function store(key: string, e: Entry) {
    cache.delete(key);
    cache.set(key, e);
    while (cache.size > MAX_CACHE_KEYS) cache.delete(cache.keys().next().value as string);
  }

  async function refresh(key: string, lat: string, lon: string, now: number): Promise<WeatherReport> {
    const prev = cache.get(key);
    const fallback = (reason: WeatherFailure): WeatherReport => {
      fail.set(key, { at: now, reason });
      opts.log({ level: "warn", feed: "met", event: "unavailable", reason });
      if (prev && now - prev.fetchedAt < WEATHER_STALE_MAX_MS) return ok(prev, true);
      return unavailable(reason);
    };
    const headers: Record<string, string> = { "User-Agent": opts.userAgent, Accept: "application/json" };
    if (prev?.lastModified) headers["If-Modified-Since"] = prev.lastModified;
    const sep = opts.url.includes("?") ? "&" : "?";
    let res;
    try {
      res = await fetchCapped(`${opts.url}${sep}lat=${lat}&lon=${lon}`, headers, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes, fetch: opts.fetch });
    } catch (e) {
      const kind = e instanceof FeedFetchError ? e.kind : "network";
      return fallback(kind === "too_big" ? "malformed" : kind);
    }
    const expires = Date.parse(res.headers.get("expires") || "");
    const expiresAt = Number.isFinite(expires) && expires > now ? Math.min(expires, now + MAX_TTL_MS) : now + DEFAULT_TTL_MS;

    if (res.status === 304 && prev) {
      const next: Entry = { ...prev, fetchedAt: now, expiresAt, lastModified: res.headers.get("last-modified") ?? prev.lastModified };
      store(key, next);
      fail.delete(key);
      return ok(next, false);
    }
    if (res.status === 203 && !warned203) {
      warned203 = true;
      opts.log({ level: "warn", feed: "met", event: "deprecated", status: 203 });
    }
    if (res.status !== 200 && res.status !== 203) return fallback("http");
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      return fallback("malformed");
    }
    const parsed = parseLocationforecast(json);
    if (!parsed) return fallback("malformed");
    if (parsed.steps.length === 0) return fallback("empty");
    const entry: Entry = { steps: parsed.steps, fetchedAt: now, expiresAt, lastModified: res.headers.get("last-modified"), updatedAt: parsed.updatedAt };
    store(key, entry);
    fail.delete(key);
    return ok(entry, false);
  }

  return {
    async get(latIn, lonIn, now = Date.now()) {
      if (!opts.enabled) return unavailable("disabled");
      const lat = latIn.toFixed(2);
      const lon = lonIn.toFixed(2);
      const key = `${lat},${lon}`;
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now) return ok(hit, false);
      const failed = fail.get(key);
      if (failed && now - failed.at < WEATHER_BACKOFF_MS) {
        if (hit && now - hit.fetchedAt < WEATHER_STALE_MAX_MS) return ok(hit, true);
        return unavailable(failed.reason);
      }
      let p = inflight.get(key);
      if (!p) {
        p = refresh(key, lat, lon, now).catch(() => unavailable("network"));
        inflight.set(key, p);
        void p.finally(() => inflight.delete(key));
      }
      return p;
    },
    reset() {
      cache.clear();
      fail.clear();
      inflight.clear();
      warned203 = false;
    },
  };
}
