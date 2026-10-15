// The verified places dataset: loaded and validated once at startup (zod), then
// served from memory with fuzzy, accent-insensitive lookup.

import { readFileSync } from "node:fs";
import { z } from "zod";
import { haversineKm } from "../geo.ts";
import { type Candidate, bestMatch, bestScored, findInText, normalize, rank } from "./match.ts";

export const KINDS = [
  "beach", "nature", "viewpoint", "hike", "waterfall", "garden", "wildlife", "museum", "history", "market",
  "shopping", "food", "rum", "tea", "culture", "temple", "adventure", "boat", "wellness", "family",
] as const;
export const SETTINGS = ["indoor", "covered", "outdoor", "mixed"] as const;
export const TAGS = [
  "family", "free", "kids", "history", "food", "shopping", "rum", "tea", "nature", "swim", "snorkel", "hike",
  "view", "unesco", "market", "museum", "garden", "wildlife", "sunset", "boat", "culture",
] as const;
export const COASTS = ["north", "north-west", "west", "south-west", "south", "south-east", "east", "central"] as const;

export type Kind = (typeof KINDS)[number];
export type Setting = (typeof SETTINGS)[number];
export type Tag = (typeof TAGS)[number];

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "ids are lowercase words joined by hyphens").max(60);
const lat = z.number().min(-90).max(90);
const lon = z.number().min(-180).max(180);
const isoDate = z.iso.date();

export const AreaSchema = z.strictObject({
  id,
  name: z.string().min(1).max(80),
  coast: z.enum(COASTS),
  lat,
  lon,
  aliases: z.array(z.string().min(1).max(80)).max(20),
});

export const PlaceSchema = z.strictObject({
  id,
  name: z.string().min(1).max(80),
  area: id,
  kind: z.enum(KINDS),
  setting: z.enum(SETTINGS),
  rain_ok: z.boolean(),
  duration_min: z.int().min(5).max(24 * 60),
  lat,
  lon,
  coords_approx: z.boolean(),
  tags: z.array(z.enum(TAGS)).max(12),
  blurb: z.string().min(1).max(200),
  speech: z.string().min(1).max(140),
  notes: z.string().max(300).nullable(),
  source: z.url({ protocol: /^https$/ }),
  verified_at: isoDate,
});

export const DatasetSchema = z.object({
  version: z.literal(1),
  region: z.literal("mauritius"),
  researched_at: isoDate,
  seed: z.boolean().optional(),
  areas: z.array(AreaSchema).min(1).max(100),
  places: z.array(PlaceSchema).min(1).max(5000),
});

export type Area = z.infer<typeof AreaSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type Dataset = z.infer<typeof DatasetSchema>;

export class DatasetError extends Error {
  override name = "DatasetError";
}

/** Parse and check a dataset: the schema, unique ids, and every place's area exists. */
export function parseDataset(json: unknown): Dataset {
  const parsed = DatasetSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new DatasetError(`places dataset is invalid:\n${issues.join("\n")}`);
  }
  const data = parsed.data;
  const areaIds = new Set<string>();
  for (const a of data.areas) {
    if (areaIds.has(a.id)) throw new DatasetError(`places dataset: duplicate area id "${a.id}"`);
    areaIds.add(a.id);
  }
  const placeIds = new Set<string>();
  for (const p of data.places) {
    if (placeIds.has(p.id)) throw new DatasetError(`places dataset: duplicate place id "${p.id}"`);
    placeIds.add(p.id);
    if (!areaIds.has(p.area)) throw new DatasetError(`places dataset: place "${p.id}" has unknown area "${p.area}"`);
  }
  return data;
}

export function loadDataset(file: string): Dataset {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new DatasetError(`places dataset not found or unreadable: ${file}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DatasetError(`places dataset is not valid JSON: ${file}`);
  }
  return parseDataset(json);
}

export interface PlaceWithDistance {
  place: Place;
  km: number;
}

export interface PlacesIndex {
  dataset: Dataset;
  areas: Area[];
  places: Place[];
  area(id: string): Area | undefined;
  place(id: string): Place | undefined;
  areaName(id: string): string;
  /** Fuzzy area lookup by id, name or alias. */
  findArea(query: string): Area | null;
  /** The same lookups with their match scores (0..1), to compare an area match with a place match. */
  areaMatch(query: string): { item: Area; score: number } | null;
  placeMatch(query: string): { item: Place; score: number } | null;
  /** Up to n suggestions scoring at least `floor` (0..1). */
  suggestPlacesAbove(query: string, n: number, floor: number): Place[];
  suggestAreas(query: string, n: number): Area[];
  findPlace(query: string): Place | null;
  suggestPlaces(query: string, n: number): Place[];
  /** Area or place names mentioned in free text (longest match wins). */
  areaInText(text: string): Area | null;
  placeInText(text: string): Place | null;
  /** Places within `km` of a point, nearest first. */
  near(lat: number, lon: number, km: number): PlaceWithDistance[];
}

function areaLabels(a: Area): string[] {
  const labels = new Set<string>([normalize(a.id.replace(/-/g, " ")), normalize(a.name), ...a.aliases.map(normalize)]);
  // "Black River and Tamarin" is also "Black River" and "Tamarin".
  for (const part of a.name.split(/\s+and\s+/i)) labels.add(normalize(part));
  return [...labels].filter(Boolean);
}

function placeLabels(p: Place): string[] {
  const labels = new Set<string>([normalize(p.id.replace(/-/g, " ")), normalize(p.name)]);
  // "Grand Bassin (Ganga Talao)" is also "Grand Bassin" and "Ganga Talao".
  const paren = p.name.match(/^(.*?)\s*\((.+)\)\s*$/);
  if (paren) {
    labels.add(normalize(paren[1]!));
    labels.add(normalize(paren[2]!));
  }
  return [...labels].filter(Boolean);
}

export function createPlacesIndex(dataset: Dataset): PlacesIndex {
  const areaById = new Map(dataset.areas.map((a) => [a.id, a]));
  const placeById = new Map(dataset.places.map((p) => [p.id, p]));
  const areaCandidates: Candidate<Area>[] = dataset.areas.map((a) => ({ item: a, labels: areaLabels(a) }));
  const placeCandidates: Candidate<Place>[] = dataset.places.map((p) => ({ item: p, labels: placeLabels(p) }));

  return {
    dataset,
    areas: dataset.areas,
    places: dataset.places,
    area: (id) => areaById.get(id),
    place: (id) => placeById.get(id),
    areaName: (id) => areaById.get(id)?.name ?? id,
    findArea: (q) => bestMatch(q, areaCandidates),
    areaMatch: (q) => bestScored(q, areaCandidates),
    placeMatch: (q) => bestScored(q, placeCandidates),
    suggestPlacesAbove: (q, n, floor) =>
      rank(q, placeCandidates)
        .filter((r) => r.score >= floor)
        .slice(0, n)
        .map((r) => r.item),
    suggestAreas: (q, n) => rank(q, areaCandidates).slice(0, n).map((r) => r.item),
    findPlace: (q) => bestMatch(q, placeCandidates),
    suggestPlaces: (q, n) => rank(q, placeCandidates).slice(0, n).map((r) => r.item),
    areaInText: (t) => findInText(t, areaCandidates),
    placeInText: (t) => findInText(t, placeCandidates, 5),
    near(lat, lon, km) {
      return dataset.places
        .map((place) => ({ place, km: haversineKm(lat, lon, place.lat, place.lon) }))
        .filter((x) => x.km <= km)
        .sort((a, b) => a.km - b.km);
    },
  };
}

export function loadPlacesIndex(file: string): PlacesIndex {
  return createPlacesIndex(loadDataset(file));
}
