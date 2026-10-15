// What every tool needs, injected so the logic stays pure and testable.

import type { Area, PlacesIndex } from "../data/places.ts";
import type { CycloneReport } from "../feeds/cyclones.ts";
import type { WeatherReport } from "../feeds/weather.ts";
import { capSpeech, joinNames } from "./speech.ts";

export interface WeatherSource {
  get(lat: number, lon: number, now?: number): Promise<WeatherReport>;
}

export interface CycloneSource {
  get(now?: number): Promise<CycloneReport>;
}

export interface ToolDeps {
  places: PlacesIndex;
  weather: WeatherSource;
  cyclones: CycloneSource;
  now: () => number;
}

export type ToolOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

export const ATTRIBUTION = { weather: "Data from MET Norway (CC BY 4.0)", cyclones: "GDACS" } as const;

export function fail<T>(message: string): ToolOutcome<T> {
  return { ok: false, message: capSpeech(message) };
}

/** Quote user input safely inside a message: short, single line, no quotes. */
export function quoted(s: string): string {
  return s.replace(/[\s'"`]+/g, " ").trim().slice(0, 40);
}

export function resolveArea(places: PlacesIndex, query: string): { area: Area } | { error: string } {
  const area = places.findArea(query);
  if (area) return { area };
  const names = places.suggestAreas(query, 5).map((a) => a.name);
  return { error: `I don't know the area '${quoted(query)}'. Try: ${joinNames(names, "or")}.` };
}

/** The forecast point for an area: its centre, 2 decimals. */
export function forecastPoint(area: Area): { lat: number; lon: number } {
  return { lat: Math.round(area.lat * 100) / 100, lon: Math.round(area.lon * 100) / 100 };
}
