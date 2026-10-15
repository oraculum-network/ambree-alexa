// What every tool needs, injected so the logic stays pure and testable.

import type { Area, Place, PlacesIndex } from "../data/places.ts";
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

/**
 * An area from loose text. When the text matches a place better than any area ("Grand
 * Bassin" is a place, not Grand Baie), the place's area is used, and `via` says which place.
 */
export function resolveArea(places: PlacesIndex, query: string): { area: Area; via?: Place } | { error: string } {
  const area = places.areaMatch(query);
  const place = places.placeMatch(query);
  if (place && (!area || place.score > area.score)) {
    const placeArea = places.area(place.item.area);
    if (placeArea) return { area: placeArea, via: place.item };
  }
  if (area) return { area: area.item };
  const names = places.suggestAreas(query, 5).map((a) => a.name);
  return { error: `I don't know the area '${quoted(query)}'. Try: ${joinNames(names, "or")}.` };
}

/** "Going by Grand Bassin (Ganga Talao), …" when the area came from a place name. */
export function viaPrefix(via: Place | undefined, sentence: string): string {
  if (!via) return sentence;
  const rest = sentence.startsWith("I ") ? sentence : sentence.charAt(0).toLowerCase() + sentence.slice(1);
  return `Going by ${via.name}, ${rest}`;
}

/** The forecast point for an area: its centre, 2 decimals. */
export function forecastPoint(area: Area): { lat: number; lon: number } {
  return { lat: Math.round(area.lat * 100) / 100, lon: Math.round(area.lon * 100) / 100 };
}
