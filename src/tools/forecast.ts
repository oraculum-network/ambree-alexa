// Shared forecast reading: what counts as a rainy, wet or windy hour, and the
// shapes both weather tools return.

import { z } from "zod";
import type { NearbyCyclone } from "../feeds/cyclones.ts";
import type { HourStep } from "../feeds/weather.ts";
import { round1 } from "../geo.ts";
import { isoMu } from "../time.ts";

/** A rainy hour: at least 0.5 mm, or a precipitation probability of 60 % or more. */
export const RAINY_MM = 0.5;
export const RAINY_PROB = 60;
/** Any single hour of 1 mm or more makes a window wet. */
export const HEAVY_MM = 1;
/** Wind of 10 m/s or more rules out boats, snorkelling and swimming. */
export const WINDY_MS = 10;

export const isRainy = (s: HourStep) => (s.precipMm ?? 0) >= RAINY_MM || (s.precipProb ?? 0) >= RAINY_PROB;
export const isHeavy = (s: HourStep) => (s.precipMm ?? 0) >= HEAVY_MM;
export const isWindy = (s: HourStep) => (s.windMs ?? 0) >= WINDY_MS;

export const hourOut = z.object({
  time: z.string().describe("Start of the hour, ISO 8601 in Mauritius time (+04:00)."),
  temp_c: z.number().nullable(),
  precip_mm: z.number().nullable(),
  precip_prob: z.number().nullable(),
  wind_ms: z.number().nullable(),
  symbol: z.string().nullable(),
});

export const cycloneOut = z.object({
  name: z.string(),
  alert_level: z.enum(["Green", "Orange", "Red"]),
  distance_km: z.number(),
  url: z.string(),
});

export const summaryOut = z.object({
  rain_expected: z.boolean(),
  rainy_hours: z.array(z.string()),
  max_precip_mm: z.number().nullable(),
  temp_min_c: z.number().nullable(),
  temp_max_c: z.number().nullable(),
});

export function hoursOut(steps: HourStep[]) {
  return steps.map((s) => ({
    time: isoMu(s.time),
    temp_c: s.tempC === null ? null : round1(s.tempC),
    precip_mm: s.precipMm === null ? null : round1(s.precipMm),
    precip_prob: s.precipProb === null ? null : Math.round(s.precipProb),
    wind_ms: s.windMs === null ? null : round1(s.windMs),
    symbol: s.symbol,
  }));
}

export function summarise(steps: HourStep[]): z.infer<typeof summaryOut> {
  const temps = steps.map((s) => s.tempC).filter((t): t is number => t !== null);
  const precips = steps.map((s) => s.precipMm).filter((p): p is number => p !== null);
  const rainy = steps.filter(isRainy);
  return {
    rain_expected: rainy.length > 0,
    rainy_hours: rainy.map((s) => isoMu(s.time)),
    max_precip_mm: precips.length ? round1(Math.max(...precips)) : null,
    temp_min_c: temps.length ? round1(Math.min(...temps)) : null,
    temp_max_c: temps.length ? round1(Math.max(...temps)) : null,
  };
}

export function cyclonesOut(systems: NearbyCyclone[]) {
  return systems.slice(0, 5).map((s) => ({ name: s.name, alert_level: s.alertLevel, distance_km: s.distanceKm, url: s.reportUrl }));
}

/** "Tropical Cyclone BELAL-24" reads aloud as "Tropical Cyclone Belal". */
export function spokenCycloneName(name: string): string {
  const cleaned = name.replace(/-\d+$/, "").trim();
  return cleaned.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a: string, b: string) => a + b.toLowerCase());
}

/** Contiguous rainy spells (by step index) inside the given steps. */
export function rainySpells(steps: HourStep[]): Array<{ start: number; end: number }> {
  const spells: Array<{ start: number; end: number }> = [];
  steps.forEach((s, i) => {
    if (!isRainy(s)) return;
    const last = spells[spells.length - 1];
    if (last && last.end === i - 1) last.end = i;
    else spells.push({ start: i, end: i });
  });
  return spells;
}
