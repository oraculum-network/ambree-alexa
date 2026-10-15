// Active tropical cyclones near Mauritius, from GDACS (the Global Disaster Alert and
// Coordination System of the UN and the European Commission).
//
// Feed: the GDACS events API, tropical cyclones only, all alert levels, last 10 days
// (GeoJSON: each feature is one system; its geometry is the latest position).
// GDACS data is automatic and "as is": it is not an official warning, so every
// cyclone answer sends travellers to the Mauritius Meteorological Services.
//
// Robustness: a 4 s timeout, a 1 MB cap, strict parsing, one shared 30-minute cache,
// stale-if-error for up to 6 hours and a 5-minute back-off after a failure. In memory only.

import { haversineKm } from "../geo.ts";
import type { Logger } from "../log.ts";
import { FeedFetchError, type FetchLike, fetchCapped } from "./fetch.ts";

export const CYCLONE_ATTRIBUTION = "GDACS";

/** Systems within this distance of Mauritius, or listing it as affected, count as near. */
export const NEAR_KM = 1200;
export const MAURITIUS = { lat: -20.2, lon: 57.5, iso3: "MUS" } as const;

const TTL_MS = 30 * 60 * 1000;
export const CYCLONE_STALE_MAX_MS = 6 * 60 * 60 * 1000;
export const CYCLONE_BACKOFF_MS = 5 * 60 * 1000;
const ACTIVE_WITHIN_MS = 48 * 60 * 60 * 1000;

export type AlertLevel = "Green" | "Orange" | "Red";

export interface CycloneSystem {
  id: number;
  name: string;
  alertLevel: AlertLevel;
  severity: string | null;
  lat: number;
  lon: number;
  /** ISO3 codes GDACS lists as affected. */
  countries: string[];
  /** The system's latest advisory time (ISO). */
  updated: string;
  /** Built from the numeric event id, never taken from the feed. */
  reportUrl: string;
}

export interface NearbyCyclone extends CycloneSystem {
  distanceKm: number;
  affectsMauritius: boolean;
}

export type CycloneFailure = "disabled" | "timeout" | "network" | "http" | "malformed";

export interface CycloneReport {
  status: "ok" | "stale" | "unavailable";
  reason?: CycloneFailure;
  systems: NearbyCyclone[];
  fetchedAt: number | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** GDACS times are UTC without a zone ("2026-09-24T09:00:00"). */
function gdacsTime(s: unknown): number | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?/.test(s)) return null;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "Z");
  return Number.isFinite(t) ? t : null;
}

/**
 * Active tropical cyclones from a GDACS event list; null when malformed. A system is
 * active when GDACS marks it current and its latest advisory is under 48 hours old.
 */
export function parseGdacs(json: unknown, now: number): CycloneSystem[] | null {
  if (!isObj(json) || !Array.isArray(json.features)) return null;
  if (json.features.length > 2000) return null;
  const out: CycloneSystem[] = [];
  for (const f of json.features as unknown[]) {
    if (!isObj(f) || !isObj(f.properties) || !isObj(f.geometry)) continue;
    const p = f.properties;
    if (p.eventtype !== "TC") continue;
    if (!(p.iscurrent === true || p.iscurrent === "true")) continue;
    const to = gdacsTime(p.todate);
    if (to == null || now - to > ACTIVE_WITHIN_MS) continue;
    const id = typeof p.eventid === "number" ? p.eventid : parseInt(String(p.eventid ?? ""), 10);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const c = f.geometry.type === "Point" && Array.isArray(f.geometry.coordinates) ? (f.geometry.coordinates as unknown[]) : null;
    const lon = c && typeof c[0] === "number" ? c[0] : NaN;
    const lat = c && typeof c[1] === "number" ? c[1] : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const alertLevel: AlertLevel = p.alertlevel === "Red" || p.alertlevel === "Orange" ? p.alertlevel : "Green";
    const rawName =
      typeof p.name === "string" && p.name.trim()
        ? p.name
        : typeof p.eventname === "string" && p.eventname.trim()
          ? `Tropical Cyclone ${p.eventname}`
          : "Tropical cyclone";
    const severity = isObj(p.severitydata) && typeof p.severitydata.severitytext === "string" ? p.severitydata.severitytext.slice(0, 120) : null;
    const countries = Array.isArray(p.affectedcountries)
      ? (p.affectedcountries as unknown[])
          .map((x) => (isObj(x) && typeof x.iso3 === "string" ? x.iso3.toUpperCase().slice(0, 3) : null))
          .filter((x): x is string => !!x && /^[A-Z]{3}$/.test(x))
      : [];
    out.push({
      id,
      name: rawName.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80),
      alertLevel,
      severity,
      lat,
      lon,
      countries,
      updated: new Date(to).toISOString(),
      reportUrl: `https://www.gdacs.org/report.aspx?eventid=${id}&eventtype=TC`,
    });
  }
  return out;
}

/** Systems near Mauritius (within NEAR_KM, or GDACS lists it as affected), nearest first. */
export function nearMauritius(systems: CycloneSystem[]): NearbyCyclone[] {
  return systems
    .map((s) => ({
      ...s,
      distanceKm: Math.round(haversineKm(MAURITIUS.lat, MAURITIUS.lon, s.lat, s.lon)),
      affectsMauritius: s.countries.includes(MAURITIUS.iso3),
    }))
    .filter((s) => s.affectsMauritius || s.distanceKm <= NEAR_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Orange or Red near Mauritius: the only case where Ambree tells travellers to stay put. */
export function isDangerous(s: NearbyCyclone): boolean {
  return s.alertLevel === "Orange" || s.alertLevel === "Red";
}

export interface CycloneClientOptions {
  url: string;
  userAgent: string;
  enabled: boolean;
  log: Logger;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CycloneClient {
  get(now?: number): Promise<CycloneReport>;
  reset(): void;
}

export function createCycloneClient(opts: CycloneClientOptions): CycloneClient {
  let entry: { systems: CycloneSystem[]; fetchedAt: number } | null = null;
  let failure: { at: number; reason: CycloneFailure } | null = null;
  let inflight: Promise<void> | null = null;

  function feedUrl(now: number): string {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const qs = `eventlist=TC&alertlevel=green;orange;red&fromDate=${day(now - 10 * 86400_000)}&toDate=${day(now + 86400_000)}`;
    return `${opts.url}${opts.url.includes("?") ? "&" : "?"}${qs}`;
  }

  async function refresh(now: number): Promise<void> {
    const failWith = (reason: CycloneFailure) => {
      failure = { at: now, reason };
      opts.log({ level: "warn", feed: "gdacs", event: "unavailable", reason });
    };
    let res;
    try {
      res = await fetchCapped(feedUrl(now), { "User-Agent": opts.userAgent, Accept: "application/json" }, {
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
        fetch: opts.fetch,
      });
    } catch (e) {
      const kind = e instanceof FeedFetchError ? e.kind : "network";
      return failWith(kind === "too_big" ? "malformed" : kind);
    }
    // GDACS answers 204 or an empty body when nothing matches the search.
    if (res.status === 204 || (res.status === 200 && !res.text.trim())) {
      entry = { systems: [], fetchedAt: now };
      failure = null;
      return;
    }
    if (res.status !== 200) return failWith("http");
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      return failWith("malformed");
    }
    const systems = parseGdacs(json, now);
    if (!systems) return failWith("malformed");
    entry = { systems, fetchedAt: now };
    failure = null;
  }

  return {
    async get(now = Date.now()) {
      if (!opts.enabled) return { status: "unavailable", reason: "disabled", systems: [], fetchedAt: null };
      const fresh = entry && now - entry.fetchedAt < TTL_MS;
      const backingOff = failure && now - failure.at < CYCLONE_BACKOFF_MS;
      if (!fresh && !backingOff) {
        if (!inflight) {
          inflight = refresh(now)
            .catch(() => {
              failure = { at: now, reason: "network" };
            })
            .finally(() => {
              inflight = null;
            });
        }
        await inflight;
      }
      const e = entry;
      if (e && now - e.fetchedAt < TTL_MS) {
        return { status: "ok", systems: nearMauritius(e.systems), fetchedAt: e.fetchedAt };
      }
      if (e && now - e.fetchedAt < CYCLONE_STALE_MAX_MS) {
        // A stale list must not keep a finished system alive: re-check "active" against now.
        const still = e.systems.filter((s) => now - Date.parse(s.updated) <= ACTIVE_WITHIN_MS);
        return { status: "stale", systems: nearMauritius(still), fetchedAt: e.fetchedAt };
      }
      return { status: "unavailable", reason: failure?.reason ?? "network", systems: [], fetchedAt: null };
    },
    reset() {
      entry = null;
      failure = null;
      inflight = null;
    },
  };
}
