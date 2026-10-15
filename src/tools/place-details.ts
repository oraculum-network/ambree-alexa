// place_details: the full verified record for one place.

import { z } from "zod";
import { KINDS, SETTINGS, TAGS } from "../data/places.ts";
import { type ToolDeps, type ToolOutcome, fail, quoted } from "./context.ts";
import { fitSpeech, spokenDuration } from "./speech.ts";

/** Match score (0..1) a place needs to be suggested: roughly 60 % letter similarity. */
export const SUGGEST_FLOOR = 0.3;

export const placeDetailsInput = z.object({
  place: z.string().min(1).max(80).describe("Place id or name, e.g. 'Blue Penny Museum'. Fuzzy and accent-insensitive."),
});
export type PlaceDetailsInput = z.infer<typeof placeDetailsInput>;

export const placeRecord = z.object({
  id: z.string(),
  name: z.string(),
  area: z.string(),
  area_name: z.string(),
  kind: z.enum(KINDS),
  setting: z.enum(SETTINGS),
  rain_ok: z.boolean(),
  duration_min: z.int(),
  lat: z.number(),
  lon: z.number(),
  coords_approx: z.boolean(),
  tags: z.array(z.enum(TAGS)),
  blurb: z.string(),
  speech: z.string(),
  notes: z.string().nullable(),
  source: z.string(),
  verified_at: z.string(),
});

export const placeDetailsOutput = z.object({
  place: placeRecord,
  speech: z.string(),
});
export type PlaceDetailsOutput = z.infer<typeof placeDetailsOutput>;

export function placeDetails(input: PlaceDetailsInput, deps: ToolDeps): ToolOutcome<PlaceDetailsOutput> {
  const { places } = deps;
  const place = places.place(input.place) ?? places.findPlace(input.place);
  if (!place) {
    // Only names that are close; read with "or" between them, never commas, because some
    // names contain a comma ("Natural History Museum, Port Louis").
    const names = places.suggestPlacesAbove(input.place, 3, SUGGEST_FLOOR).map((p) => p.name);
    const missing = `I don't have a place called '${quoted(input.place)}' in my verified list.`;
    if (!names.length) return fail(`${missing} Try find_places with an area or a kind to see what's there.`);
    return fail(`${missing} Did you mean ${names.join(" or ")}?`);
  }
  const allow = `Allow ${spokenDuration(place.duration_min)}${place.rain_ok ? ", and it works in the rain" : ""}.`;
  return {
    ok: true,
    value: {
      place: { ...place, area_name: places.areaName(place.area) },
      speech: fitSpeech(`${place.speech} ${allow}`, place.speech),
    },
  };
}
