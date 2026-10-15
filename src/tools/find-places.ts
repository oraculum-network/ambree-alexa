// find_places: places from the verified dataset, by area, kind, rain and free text.

import { z } from "zod";
import { KINDS, type Kind, type Place, SETTINGS } from "../data/places.ts";
import { normalize } from "../data/match.ts";
import { haversineKm, round1 } from "../geo.ts";
import { type ToolDeps, type ToolOutcome, fail, resolveArea } from "./context.ts";
import { fitSpeech, joinNames } from "./speech.ts";

export const NEARBY_KM = 25;

export const findPlacesInput = z.object({
  area: z.string().min(1).max(80).optional().describe("Area id, name or alias, e.g. 'Grand Baie', 'mahebourg'. Fuzzy and accent-insensitive."),
  kind: z.enum(KINDS).optional().describe("Only places of this kind."),
  rain_ok: z.boolean().optional().describe("true: only indoor or covered places that work in the rain. false: only places that don't."),
  query: z.string().min(1).max(80).optional().describe("Free text matched against names, descriptions and tags, e.g. 'stamps' or 'sunset'."),
  limit: z.int().min(1).max(8).default(5).describe("How many places to return (1 to 8)."),
});
export type FindPlacesInput = z.infer<typeof findPlacesInput>;

export const placeSummary = z.object({
  id: z.string(),
  name: z.string(),
  area_id: z.string(),
  area_name: z.string(),
  kind: z.enum(KINDS),
  setting: z.enum(SETTINGS),
  rain_ok: z.boolean(),
  blurb: z.string(),
  distance_km: z.number().nullable(),
});

export const findPlacesOutput = z.object({
  area: z.object({ id: z.string(), name: z.string() }).nullable(),
  count: z.int(),
  places: z.array(placeSummary),
  speech: z.string(),
});
export type FindPlacesOutput = z.infer<typeof findPlacesOutput>;

const KIND_PLURAL: Record<Kind, string> = {
  beach: "beaches", nature: "nature spots", viewpoint: "viewpoints", hike: "hikes", waterfall: "waterfalls",
  garden: "gardens", wildlife: "wildlife parks", museum: "museums", history: "historic sites", market: "markets",
  shopping: "places to shop", food: "places to eat", rum: "rum distilleries", tea: "tea estates", culture: "cultural sites",
  temple: "temples", adventure: "adventure spots", boat: "boat trips", wellness: "wellness spots", family: "family outings",
};

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "in", "near", "to", "for", "with", "at", "on", "some", "any", "place", "places"]);

function matchesQuery(p: Place, areaName: string, query: string): boolean {
  const hay = ` ${normalize([p.name, p.blurb, p.kind, areaName, ...p.tags].join(" "))} `;
  const words = normalize(query).split(" ").filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (!words.length) return true;
  // Every word must appear, allowing a simple plural ("museums" ~ "museum").
  return words.every((w) => hay.includes(w) || (w.endsWith("s") && hay.includes(w.slice(0, -1))));
}

export function findPlaces(input: FindPlacesInput, deps: ToolDeps): ToolOutcome<FindPlacesOutput> {
  const { places } = deps;
  const limit = input.limit ?? 5;
  let area = null;
  if (input.area) {
    const r = resolveArea(places, input.area);
    if ("error" in r) return fail(r.error);
    area = r.area;
  }

  const filtered = places.places.filter(
    (p) =>
      (input.kind === undefined || p.kind === input.kind) &&
      (input.rain_ok === undefined || p.rain_ok === input.rain_ok) &&
      (input.query === undefined || matchesQuery(p, places.areaName(p.area), input.query)),
  );

  let ranked: Array<{ place: Place; km: number | null }>;
  if (area) {
    const a = area;
    const withKm = filtered.map((place) => ({ place, km: haversineKm(a.lat, a.lon, place.lat, place.lon) }));
    const inArea = withKm.filter((x) => x.place.area === a.id).sort((x, y) => x.km - y.km);
    const nearby = withKm.filter((x) => x.place.area !== a.id && x.km <= NEARBY_KM).sort((x, y) => x.km - y.km);
    ranked = [...inArea, ...nearby];
  } else {
    ranked = filtered.map((place) => ({ place, km: null }));
  }
  const chosen = ranked.slice(0, limit);

  const out = chosen.map(({ place, km }) => ({
    id: place.id,
    name: place.name,
    area_id: place.area,
    area_name: places.areaName(place.area),
    kind: place.kind,
    setting: place.setting,
    rain_ok: place.rain_ok,
    blurb: place.blurb,
    distance_km: km === null ? null : round1(km),
  }));

  const where = area ? ` near ${area.name}` : "";
  let speech: string;
  if (!out.length) {
    const what = `${input.rain_ok ? "covered " : ""}${input.kind ? KIND_PLURAL[input.kind] : "places"}`;
    speech = fitSpeech(`I couldn't find any ${what}${where} in my verified list. Try another area or fewer filters.`);
  } else {
    const names = out.slice(0, 3).map((p) => p.name);
    const lead = area ? `Near ${area.name}, try ${joinNames(names)}.` : `Try ${joinNames(names)}.`;
    const first = chosen[0]!.place.speech;
    speech = fitSpeech(`${lead} ${first}`, lead, `Try ${names[0]}.`);
  }

  return {
    ok: true,
    value: { area: area ? { id: area.id, name: area.name } : null, count: out.length, places: out, speech },
  };
}
