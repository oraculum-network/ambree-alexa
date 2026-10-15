// place_details: the full verified record for one place.

import { z } from "zod";
import { KINDS, SETTINGS, TAGS } from "../data/places.ts";
import { type ToolDeps, type ToolOutcome, fail, quoted } from "./context.ts";
import { fitSpeech, joinNames, spokenDuration } from "./speech.ts";

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
    const names = places.suggestPlaces(input.place, 3).map((p) => p.name);
    return fail(`I don't have a place called '${quoted(input.place)}' in my verified list. Did you mean ${joinNames(names, "or")}?`);
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
