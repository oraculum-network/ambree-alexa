// The offline brain: a keyword router, no LLM. It picks one tool and its arguments;
// the agent then calls that tool through the same MCP client and speaks its result.

import type { Kind, PlacesIndex } from "../data/places.ts";
import { normalize } from "../data/match.ts";

export const DEFAULT_AREA = "grand-baie";

export interface OfflineRoute {
  tool: "find_places" | "place_details" | "weather_now" | "replan_day";
  args: Record<string, unknown>;
}

export const OFFLINE_HINT =
  "I can re-plan your day around the weather, check the forecast, or find places to go in Mauritius. Try saying: it's raining in Grand Baie, re-plan my afternoon.";

const has = (t: string, re: RegExp) => re.test(t);

const RAIN = /\b(rain|raining|rainy|wet|shower|showers|storm|stormy|pouring|drizzle)\b/;
const REPLAN = /\b(re plan|replan|plan my|what should i do|what can i do|what to do|instead|change of plan|change my plan)\b/;
const PLAN_WORD = /\b(plan|plans|afternoon|morning|evening|day|today|tonight|beach|trip|outing)\b/;
const WEATHER = /\b(weather|forecast|temperature|hot|warm|cold|wind|windy|sunny|cyclone|humid)\b/;
const DETAILS = /\b(tell me about|what is|what s|whats|more about|info on|information about|details)\b/;
const FIND = /\b(find|where|show|recommend|suggest|any|somewhere|place|places|visit|go to|near|nearby)\b/;

const KIND_WORDS: Array<[RegExp, Kind]> = [
  [/\b(museum|museums|gallery)\b/, "museum"],
  [/\b(market|markets|bazaar)\b/, "market"],
  [/\b(beach|beaches|swim)\b/, "beach"],
  [/\b(rum|distillery|rhumerie)\b/, "rum"],
  [/\b(tea)\b/, "tea"],
  [/\b(garden|gardens|botanical)\b/, "garden"],
  [/\b(hike|hikes|hiking|trail|trek)\b/, "hike"],
  [/\b(waterfall|waterfalls|falls|cascade)\b/, "waterfall"],
  [/\b(temple|temples)\b/, "temple"],
  [/\b(viewpoint|view|views|lookout)\b/, "viewpoint"],
  [/\b(eat|food|lunch|dinner|restaurant|street food)\b/, "food"],
  [/\b(shop|shops|shopping|mall)\b/, "shopping"],
  [/\b(wildlife|animals|tortoises|birds)\b/, "wildlife"],
  [/\b(boat|catamaran|cruise)\b/, "boat"],
  [/\b(history|historic|heritage)\b/, "history"],
];
const COVERED = /\b(covered|indoor|indoors|inside|under cover|rainy day|dry place)\b/;

function windowOf(t: string): string | undefined {
  if (/\b(this morning|morning)\b/.test(t)) return "morning";
  if (/\b(this afternoon|afternoon)\b/.test(t)) return "afternoon";
  if (/\b(this evening|evening|tonight)\b/.test(t)) return "evening";
  if (/\b(today|rest of the day|rest of today)\b/.test(t)) return "rest_of_day";
  return undefined;
}

export function routeOffline(text: string, places: PlacesIndex): OfflineRoute | null {
  const t = normalize(text);
  if (!t) return null;
  const area = places.areaInText(text);
  const place = places.placeInText(text);
  const areaId = area?.id ?? (place ? place.area : DEFAULT_AREA);
  const rain = has(t, RAIN);

  // 1. Re-plan: explicit, or rain plus a plan word ("it's raining, what about my afternoon").
  if (has(t, REPLAN) || (rain && has(t, PLAN_WORD) && !t.endsWith(" rain") && !/\bwill it rain\b/.test(t))) {
    const args: Record<string, unknown> = { area: areaId };
    const window = windowOf(t);
    if (window) args.window = window;
    if (rain) args.reported_weather = "rain";
    else if (/\b(windy|too much wind|strong wind)\b/.test(t)) args.reported_weather = "wind";
    else if (/\b(too hot|so hot|heat|boiling)\b/.test(t)) args.reported_weather = "heat";
    if (place) args.plan = place.name;
    else if (/\bbeach\b/.test(t)) args.plan = "beach";
    else if (/\b(boat|catamaran)\b/.test(t)) args.plan = "boat trip";
    return { tool: "replan_day", args };
  }

  // 2. Details about a named place.
  if (place && (has(t, DETAILS) || normalize(place.name) === t)) {
    return { tool: "place_details", args: { place: place.name } };
  }

  // 3. Weather, including "rain?" as a question.
  if (has(t, WEATHER) || /\b(will it rain|is it raining|going to rain|rain today|rain tomorrow)\b/.test(t) || (rain && text.trim().endsWith("?"))) {
    return { tool: "weather_now", args: { area: area?.id ?? DEFAULT_AREA } };
  }

  // 4. Find places.
  const kind = KIND_WORDS.find(([re]) => re.test(t))?.[1];
  const covered = has(t, COVERED) || rain;
  if (has(t, FIND) || kind || covered) {
    const args: Record<string, unknown> = { area: areaId };
    if (kind) args.kind = kind;
    if (covered) args.rain_ok = true;
    return { tool: "find_places", args };
  }

  // A bare place name ("Le Morne Brabant?") reads as a request for details.
  if (place) return { tool: "place_details", args: { place: place.name } };
  return null;
}
