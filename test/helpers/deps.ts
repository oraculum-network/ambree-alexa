// Fake tool dependencies: the fixture dataset and scripted feeds, no network.

import { loadPlacesIndex } from "../../src/data/places.ts";
import type { CycloneReport, NearbyCyclone } from "../../src/feeds/cyclones.ts";
import { parseLocationforecast, type WeatherReport } from "../../src/feeds/weather.ts";
import type { ToolDeps } from "../../src/tools/context.ts";
import { FIXED_NOW, FIXTURE_PLACES } from "./app.ts";
import { type HourSpec, makeForecast } from "./forecast.ts";

const HOUR = 3600_000;
export const fixturePlaces = loadPlacesIndex(FIXTURE_PLACES);

export function weatherOf(spec: (muHour: number) => HourSpec, now = FIXED_NOW): WeatherReport {
  const start = Math.floor(now / HOUR) * HOUR - 2 * HOUR;
  const parsed = parseLocationforecast(makeForecast(start, 60, spec))!;
  return { status: "ok", steps: parsed.steps, fetchedAt: now, updatedAt: parsed.updatedAt };
}

export const UNAVAILABLE: WeatherReport = { status: "unavailable", reason: "network", steps: [], fetchedAt: null, updatedAt: null };

export function cyclone(alertLevel: NearbyCyclone["alertLevel"], distanceKm = 400): NearbyCyclone {
  return {
    id: 1,
    name: "Tropical Cyclone ALPHA-26",
    alertLevel,
    severity: null,
    lat: -18,
    lon: 56,
    countries: ["MUS"],
    updated: new Date(FIXED_NOW).toISOString(),
    reportUrl: "https://www.gdacs.org/report.aspx?eventid=1&eventtype=TC",
    distanceKm,
    affectsMauritius: true,
  };
}

export function fakeDeps(opts: { weather?: WeatherReport; cyclones?: NearbyCyclone[]; now?: number } = {}): ToolDeps & { calls: { weather: Array<[number, number]> } } {
  const calls = { weather: [] as Array<[number, number]> };
  const tc: CycloneReport = { status: "ok", systems: opts.cyclones ?? [], fetchedAt: FIXED_NOW };
  return {
    places: fixturePlaces,
    weather: {
      async get(lat, lon) {
        calls.weather.push([lat, lon]);
        return opts.weather ?? weatherOf(() => ({}));
      },
    },
    cyclones: { get: async () => tc },
    now: () => opts.now ?? FIXED_NOW,
    calls,
  };
}
