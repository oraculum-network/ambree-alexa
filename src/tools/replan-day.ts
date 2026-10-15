// replan_day: keep the plan, swap it for nearby covered places, or stay safe.
//
// Wet when the traveller reports rain (they are there, so trust them), when at least
// 2 forecast hours in the window are rainy, or when any hour has 1 mm or more.
// Windy (reported, or any hour at 10 m/s or more) rules out boats, snorkelling and
// swimming. An orange or red GDACS cyclone near Mauritius means stay_safe, and the
// answer then says only to stay put and follow the official bulletins.

import { z } from "zod";
import { KINDS, type Place, SETTINGS } from "../data/places.ts";
import { normalize } from "../data/match.ts";
import { isDangerous } from "../feeds/cyclones.ts";
import type { HourStep } from "../feeds/weather.ts";
import { haversineKm, travelMinutes } from "../geo.ts";
import { addDays, hourOfMu, muInstant, muParts } from "../time.ts";
import { ATTRIBUTION, type ToolDeps, type ToolOutcome, fail, forecastPoint, resolveArea } from "./context.ts";
import { isHeavy, isRainy, isWindy, rainySpells, spokenCycloneName, summarise } from "./forecast.ts";
import { capitalise, clockWord, fitSpeech, spokenTime } from "./speech.ts";

export const SWAP_RADIUS_KM = 35;
export const MAX_SWAP_OPTIONS = 3;
export const MAX_KEEP_IDEAS = 2;

export const WINDOWS = {
  morning: { from: 7, to: 12, label: "morning" },
  afternoon: { from: 12, to: 17, label: "afternoon" },
  evening: { from: 17, to: 21, label: "evening" },
  rest_of_day: { from: 7, to: 21, label: "rest of the day" },
} as const;
export type WindowName = keyof typeof WINDOWS;

export const replanDayInput = z.object({
  area: z.string().min(1).max(80).describe("Where the traveller is: area id, name or alias, e.g. 'Grand Baie'."),
  window: z.enum(["morning", "afternoon", "evening", "rest_of_day"]).default("rest_of_day").describe("Which part of the day to re-plan (Mauritius time)."),
  reported_weather: z.enum(["rain", "dry", "wind", "heat"]).optional().describe("What the traveller says the weather is doing right now. Trusted over the forecast for rain."),
  plan: z.string().min(1).max(120).optional().describe("Their current plan, e.g. 'beach at La Cuvette'."),
  party: z.enum(["family", "couple", "solo", "group"]).optional().describe("Who is travelling."),
});
export type ReplanDayInput = z.infer<typeof replanDayInput>;

export const replanOption = z.object({
  id: z.string(),
  name: z.string(),
  area_name: z.string(),
  kind: z.enum(KINDS),
  setting: z.enum(SETTINGS),
  rain_ok: z.boolean(),
  travel_min: z.int().describe("Approximate driving minutes from the area centre."),
  why: z.string(),
});

export const replanDayOutput = z.object({
  decision: z.enum(["swap", "keep", "stay_safe"]),
  reason: z.string(),
  window: z.object({ label: z.string(), date: z.string(), from: z.string(), to: z.string() }),
  weather: z.object({ basis: z.enum(["reported", "forecast", "both", "unavailable"]), summary: z.string() }),
  options: z.array(replanOption),
  speech: z.string(),
  attribution: z.object({ weather: z.string(), cyclones: z.string() }),
});
export type ReplanDayOutput = z.infer<typeof replanDayOutput>;
type Option = z.infer<typeof replanOption>;

export interface ResolvedWindow {
  name: WindowName;
  label: string;
  date: string;
  fromHour: number;
  toHour: number;
  fromMs: number;
  toMs: number;
  tomorrow: boolean;
}

/** The window in Mauritius time; if it is already over today, tomorrow's. */
export function resolveWindow(name: WindowName, now: number): ResolvedWindow {
  const w = WINDOWS[name];
  const { date, hour } = muParts(now);
  if (hour >= w.to) {
    const d = addDays(date, 1);
    const label = name === "rest_of_day" ? "tomorrow" : `tomorrow ${w.label}`;
    return { name, label, date: d, fromHour: w.from, toHour: w.to, fromMs: muInstant(d, w.from), toMs: muInstant(d, w.to), tomorrow: true };
  }
  const fromHour = Math.max(w.from, hour);
  const label = name === "rest_of_day" ? "the rest of today" : `this ${w.label}`;
  return { name, label, date, fromHour, toHour: w.to, fromMs: muInstant(date, fromHour), toMs: muInstant(date, w.to), tomorrow: false };
}

const WATER_TAGS = new Set(["boat", "snorkel", "swim"]);
const WATER_KINDS = new Set(["boat"]);
const isWaterPlace = (p: Place) => WATER_KINDS.has(p.kind) || p.tags.some((t) => WATER_TAGS.has(t));

type Activity = "beach" | "boat" | "hike" | "outdoor" | "other";

function planActivity(plan: string | undefined, planPlace: Place | null): Activity {
  const t = normalize(plan ?? "");
  if (/\b(boat|catamaran|cruise|sail|sailing|dolphin|dolphins|snorkel|snorkelling|snorkeling|diving|dive|kayak|island)\b/.test(t)) return "boat";
  if (/\b(beach|swim|swimming|lagoon|plage)\b/.test(t)) return "beach";
  if (/\b(hike|hiking|walk|trek|trail|climb)\b/.test(t)) return "hike";
  if (planPlace) {
    if (planPlace.kind === "boat") return "boat";
    if (planPlace.kind === "beach") return "beach";
    if (planPlace.kind === "hike") return "hike";
    if (!planPlace.rain_ok) return "outdoor";
  }
  return plan ? "other" : "outdoor";
}

const SKIP: Record<Activity, string> = {
  beach: "skip the beach",
  boat: "skip the boat trip",
  hike: "skip the hike",
  outdoor: "head somewhere covered",
  other: "move your plans somewhere covered",
};

/** In ranked order (nearest first), preferring a different kind for each pick, then filling up. */
function pickVaried(cands: Array<{ place: Place; km: number }>, n: number): Array<{ place: Place; km: number }> {
  const picked: Array<{ place: Place; km: number }> = [];
  const kinds = new Set<string>();
  for (const c of cands) {
    if (picked.length >= n) break;
    if (!kinds.has(c.place.kind)) {
      picked.push(c);
      kinds.add(c.place.kind);
    }
  }
  for (const c of cands) {
    if (picked.length >= n) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.sort((a, b) => cands.indexOf(a) - cands.indexOf(b));
}

function settingWord(p: Place): string {
  if (p.setting === "indoor") return "Indoors";
  if (p.setting === "covered") return "Covered";
  if (p.setting === "mixed") return p.rain_ok ? "Mostly under cover" : "Partly outdoors";
  return "Outdoors";
}

function describeOptions(names: Array<{ name: string; minutes: number }>): string {
  const [a, b, c] = names;
  if (!a) return "";
  const first = `${a.name}, about ${a.minutes} minutes away`;
  if (!b) return `Try ${first}.`;
  if (!c) return `Try ${first}, then ${b.name}.`;
  return `Try ${first}, then ${b.name} or ${c.name}.`;
}

function windowSummary(steps: HourStep[]): string {
  if (!steps.length) return "No forecast for this window.";
  const s = summarise(steps);
  const rainy = steps.filter(isRainy).length;
  const parts = [rainy ? `${rainy} rainy ${rainy === 1 ? "hour" : "hours"}` : "no rainy hours"];
  if (s.max_precip_mm !== null && s.max_precip_mm > 0) parts.push(`up to ${s.max_precip_mm} mm in an hour`);
  const maxWind = Math.max(...steps.map((x) => x.windMs ?? 0));
  if (maxWind >= 8) parts.push(`wind up to ${Math.round(maxWind)} m/s`);
  if (s.temp_min_c !== null && s.temp_max_c !== null) parts.push(`${Math.round(s.temp_min_c)} to ${Math.round(s.temp_max_c)} °C`);
  return parts.join(", ") + ".";
}

export async function replanDay(input: ReplanDayInput, deps: ToolDeps): Promise<ToolOutcome<ReplanDayOutput>> {
  const r = resolveArea(deps.places, input.area);
  if ("error" in r) return fail(r.error);
  const { area } = r;
  const now = deps.now();
  const win = resolveWindow(input.window ?? "rest_of_day", now);
  const point = forecastPoint(area);
  const [wx, tc] = await Promise.all([deps.weather.get(point.lat, point.lon, now), deps.cyclones.get(now)]);

  const steps = wx.status === "unavailable" ? [] : wx.steps.filter((s) => s.time >= win.fromMs && s.time < win.toMs);
  const haveForecast = steps.length > 0;
  const reported = input.reported_weather;
  const basis = reported && haveForecast ? "both" : reported ? "reported" : haveForecast ? "forecast" : "unavailable";
  const windowOut = {
    label: win.label,
    date: win.date,
    from: `${String(win.fromHour).padStart(2, "0")}:00`,
    to: `${String(win.toHour).padStart(2, "0")}:00`,
  };
  const weather = { basis, summary: haveForecast ? windowSummary(steps) : "Forecast unavailable for this window." } as const;
  const result = (decision: ReplanDayOutput["decision"], reason: string, options: Option[], speech: string): ToolOutcome<ReplanDayOutput> => ({
    ok: true,
    value: { decision, reason, window: windowOut, weather, options, speech, attribution: { ...ATTRIBUTION } },
  });
  // A window already over today moves to tomorrow, and the answer says so up front.
  const lead = win.tomorrow ? `For ${win.label}, ` : "";
  const forTomorrow = (s: string) => (lead ? lead + (s.startsWith("I ") ? s : s.charAt(0).toLowerCase() + s.slice(1)) : s);

  // 1. Cyclone: stay safe, and say nothing beyond the official-bulletin advice.
  const danger = tc.systems.find(isDangerous);
  if (danger) {
    const level = danger.alertLevel === "Red" ? "a red" : "an orange";
    const name = capitalise(spokenCycloneName(danger.name));
    return result(
      "stay_safe",
      `GDACS ${danger.alertLevel} alert for ${danger.name}, ${danger.distanceKm} km from Mauritius.`,
      [],
      fitSpeech(
        `${name} has ${level} alert near Mauritius, so stay put for now. Follow the official cyclone bulletins from the Mauritius Meteorological Services.`,
        "A cyclone alert is out for Mauritius, so stay put for now. Follow the official cyclone bulletins from the Mauritius Meteorological Services.",
      ),
    );
  }

  // 2. Read the weather.
  const rainyHours = steps.filter(isRainy).length;
  const forecastWet = rainyHours >= 2 || steps.some(isHeavy);
  const wet = reported === "rain" || forecastWet;
  const windy = reported === "wind" || steps.some(isWindy);
  const heat = reported === "heat";
  const planPlace = input.plan ? deps.places.placeInText(input.plan) : null;
  const activity = planActivity(input.plan, planPlace);

  const nearby = deps.places
    .near(area.lat, area.lon, SWAP_RADIUS_KM)
    .filter((c) => c.place.id !== planPlace?.id && !(windy && isWaterPlace(c.place)));
  // Families: places tagged family or kids count as 5 km closer.
  const familyBonus = (p: Place) => (input.party === "family" && (p.tags.includes("family") || p.tags.includes("kids")) ? 5 : 0);
  const familyFirst = (list: typeof nearby) => [...list].sort((a, b) => a.km - familyBonus(a.place) - (b.km - familyBonus(b.place)));
  const toOptions = (list: Array<{ place: Place; km: number }>, why: (p: Place, min: number) => string): Option[] =>
    list.map(({ place, km }) => {
      const minutes = travelMinutes(km);
      return {
        id: place.id,
        name: place.name,
        area_name: deps.places.areaName(place.area),
        kind: place.kind,
        setting: place.setting,
        rain_ok: place.rain_ok,
        travel_min: minutes,
        why: why(place, minutes),
      };
    });
  const optionSentence = (opts: Option[]) => describeOptions(opts.map((o) => ({ name: o.name, minutes: o.travel_min })));
  const speak = (first: string, opts: Option[]) =>
    fitSpeech(`${forTomorrow(first)} ${optionSentence(opts)}`, `${forTomorrow(first)} ${optionSentence(opts.slice(0, 2))}`, `${forTomorrow(first)} ${optionSentence(opts.slice(0, 1))}`);

  // 3. Wet: swap for covered places nearby, of different kinds.
  if (wet) {
    const picks = pickVaried(familyFirst(nearby.filter((c) => c.place.rain_ok)), MAX_SWAP_OPTIONS);
    const options = toOptions(picks, (p, m) => `${settingWord(p)}, about ${m} minutes away.`);
    const spells = rainySpells(steps);
    const at = (h: number) => (win.name === "rest_of_day" ? spokenTime(h) : clockWord(h));
    const skip = SKIP[activity];
    let first: string;
    if (!haveForecast) {
      first = `I can't reach the forecast, but since it's raining in ${area.name}, ${skip}.`;
    } else if (spells.length && spells[0]!.start === 0 && spells[0]!.end < steps.length - 1) {
      const until = at(hourOfMu(steps[spells[0]!.end + 1]!.time));
      first = win.tomorrow ? `Rain is forecast over ${area.name} until about ${until}, so ${skip}.` : `Rain's settled over ${area.name} until about ${until}, so ${skip}.`;
    } else if (spells.length && spells[0]!.start > 0) {
      first = `Rain is forecast over ${area.name} from about ${at(hourOfMu(steps[spells[0]!.start]!.time))}, so ${skip}.`;
    } else if (spells.length) {
      first = `Rain looks set over ${area.name} ${win.tomorrow ? "throughout" : `for ${win.label}`}, so ${skip}.`;
    } else {
      first = `Since it's raining in ${area.name}, ${skip}.`;
    }
    const reason =
      reported === "rain" && forecastWet
        ? `You reported rain, and the forecast has ${rainyHours} rainy ${rainyHours === 1 ? "hour" : "hours"} in the window.`
        : reported === "rain"
          ? "You reported rain."
          : `The forecast has ${rainyHours} rainy ${rainyHours === 1 ? "hour" : "hours"} in the window.`;
    const speech = options.length
      ? speak(first, options)
      : fitSpeech(`${forTomorrow(first)} I don't have a covered place within ${SWAP_RADIUS_KM} kilometres in my verified list, so a quiet break indoors may be best.`, forTomorrow(first));
    return result("swap", reason, options, speech);
  }

  // 4. Heat: shade or indoors for the middle of the day.
  if (heat) {
    const picks = pickVaried(familyFirst(nearby.filter((c) => c.place.rain_ok)), MAX_SWAP_OPTIONS);
    const options = toOptions(picks, (p, m) => `${settingWord(p)} and out of the midday sun, about ${m} minutes away.`);
    const first = `It's hot in ${area.name}, so spend the middle of the day somewhere shaded and keep the beach for later.`;
    const speech = options.length ? speak(first, options) : fitSpeech(forTomorrow(first));
    return result("swap", "You reported heat.", options, speech);
  }

  // 5. Windy and the plan is on the water: move it ashore.
  const landIdeas = (n: number) => toOptions(pickVaried(familyFirst(nearby), n), (p, m) => `${settingWord(p)} and on land, about ${m} minutes away.`);
  if (windy && (activity === "boat" || activity === "beach")) {
    const options = landIdeas(MAX_SWAP_OPTIONS);
    const first = `It's too windy over ${area.name} for the water, so ${activity === "boat" ? "skip the boat trip" : "skip swimming"} and stay on land.`;
    const speech = options.length ? speak(first, options) : fitSpeech(forTomorrow(first));
    return result("swap", reported === "wind" ? "You reported strong wind." : "Wind of 10 m/s or more is forecast.", options, speech);
  }

  // 6. Dry (or unknown): keep the plan, with up to 2 outdoor ideas nearby.
  const ideas = toOptions(
    pickVaried(familyFirst(nearby.filter((c) => c.place.setting === "outdoor" || c.place.setting === "mixed")), MAX_KEEP_IDEAS),
    (p, m) => `${settingWord(p)}, about ${m} minutes away.`,
  );
  let first: string;
  let reason: string;
  if (haveForecast) {
    first = windy ? `It's dry but windy over ${area.name}, so keep your plan and stay off the water.` : `The forecast for ${area.name} looks dry${win.tomorrow ? "" : ` for ${win.label}`}, so keep your plan.`;
    reason = windy ? "Dry forecast, but wind of 10 m/s or more." : rainyHours === 1 ? "Only 1 rainy hour and no heavy rain forecast." : "Dry forecast.";
  } else if (reported) {
    first = `I can't reach the forecast, but if it's ${reported === "wind" ? "only windy" : "dry"} in ${area.name}, keep your plan${windy ? " and stay off the water" : ""}.`;
    reason = reported === "wind" ? "You reported wind; no forecast available." : "You reported dry weather; no forecast available.";
  } else {
    first = `I can't reach the forecast right now, so keep your plan and tell me if it starts to rain.`;
    reason = "No forecast available and no weather reported.";
  }
  const extra = ideas.length === 0 ? "" : ideas.length === 1 ? `If you want more, ${ideas[0]!.name} is about ${ideas[0]!.travel_min} minutes away.` : `Nearby, you could also try ${ideas[0]!.name} or ${ideas[1]!.name}.`;
  const speech = fitSpeech(`${forTomorrow(first)} ${extra}`, forTomorrow(first));
  return result("keep", reason, ideas, speech);
}
