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
import { isDangerous, isWorthWatching } from "../feeds/cyclones.ts";
import type { HourStep } from "../feeds/weather.ts";
import { haversineKm, travelMinutes } from "../geo.ts";
import { addDays, hourOfMu, muInstant, muParts } from "../time.ts";
import { ATTRIBUTION, type ToolDeps, type ToolOutcome, fail, forecastPoint, resolveArea, viaPrefix } from "./context.ts";
import { alertArticle, isHeavy, isRainy, isWindy, rainySpells, spokenCycloneName, summarise, watchSentence } from "./forecast.ts";
import { capitalise, clockWord, fitSpeech, spokenPlaceName, spokenTime } from "./speech.ts";

export const SWAP_RADIUS_KM = 35;
/** Evenings: shopping centres count only within this drive, and so do the places that fill up. */
export const EVENING_DRIVE_MIN = 30;
/** Evenings: no drive longer than this while a covered place within EVENING_DRIVE_MIN exists. */
export const EVENING_MAX_DRIVE_MIN = 45;
/** From this hour (the window's start) heat advice is about the evening, not the middle of the day. */
export const LATE_HEAT_HOUR = 15;
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
  /** The window actually planned (a rolled-over window becomes rest_of_day). */
  name: WindowName;
  label: string;
  date: string;
  fromHour: number;
  toHour: number;
  fromMs: number;
  toMs: number;
  tomorrow: boolean;
  /** Set when the asked-for window was over and we planned the rest of today instead. */
  rolledFrom?: WindowName;
  /** A weather report is about now: it applies only to a window that is today. */
  reportApplies: boolean;
}

/**
 * The window in Mauritius time. A window that includes now, or starts later today, is
 * today's. One that is already over moves to the rest of today (now until 21:00) when the
 * traveller has reported the weather and it's before 21:00, since the report is about now;
 * otherwise it moves to tomorrow, where only the forecast counts.
 */
export function resolveWindow(name: WindowName, now: number, hasReport = false): ResolvedWindow {
  const w = WINDOWS[name];
  const { date, hour } = muParts(now);
  const today = (n: WindowName, fromHour: number, toHour: number, label: string, rolledFrom?: WindowName): ResolvedWindow => ({
    name: n,
    label,
    date,
    fromHour,
    toHour,
    fromMs: muInstant(date, fromHour),
    toMs: muInstant(date, toHour),
    tomorrow: false,
    reportApplies: true,
    ...(rolledFrom ? { rolledFrom } : {}),
  });
  if (hour < w.to) return today(name, Math.max(w.from, hour), w.to, name === "rest_of_day" ? "the rest of today" : `this ${w.label}`);
  const dayEnd = WINDOWS.rest_of_day.to;
  if (hasReport && hour < dayEnd) {
    return today("rest_of_day", hour, dayEnd, hour >= WINDOWS.evening.from ? "this evening" : "the rest of today", name);
  }
  const d = addDays(date, 1);
  const label = name === "rest_of_day" ? "tomorrow" : `tomorrow ${w.label}`;
  return { name, label, date: d, fromHour: w.from, toHour: w.to, fromMs: muInstant(d, w.from), toMs: muInstant(d, w.to), tomorrow: true, reportApplies: false };
}

/** How a report about right now reads aloud: "It's raining now". */
const REPORT_NOW: Record<NonNullable<ReplanDayInput["reported_weather"]>, string> = { rain: "raining", wind: "windy", heat: "hot", dry: "dry" };

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
  const { area, via } = r;
  const now = deps.now();
  const win = resolveWindow(input.window ?? "rest_of_day", now, input.reported_weather !== undefined);
  const point = forecastPoint(area);
  const [wx, tc] = await Promise.all([deps.weather.get(point.lat, point.lon, now), deps.cyclones.get(now)]);

  const steps = wx.status === "unavailable" ? [] : wx.steps.filter((s) => s.time >= win.fromMs && s.time < win.toMs);
  const haveForecast = steps.length > 0;
  // The traveller's report is about now: trust it only for a window that is today.
  const reported = win.reportApplies ? input.reported_weather : undefined;
  const reportSetAside = input.reported_weather !== undefined && !win.reportApplies;
  const basis = reported && haveForecast ? "both" : reported ? "reported" : haveForecast ? "forecast" : "unavailable";
  const windowOut = {
    label: win.label,
    date: win.date,
    from: `${String(win.fromHour).padStart(2, "0")}:00`,
    to: `${String(win.toHour).padStart(2, "0")}:00`,
  };
  const weather = { basis, summary: haveForecast ? windowSummary(steps) : "Forecast unavailable for this window." } as const;
  const danger = tc.systems.find(isDangerous);
  const watch = danger ? undefined : tc.systems.find(isWorthWatching);
  const notes =
    (reportSetAside ? " Your report is about now, so it doesn't decide tomorrow." : "") +
    (via ? ` Area taken from ${via.name}.` : "") +
    (watch ? ` GDACS ${watch.alertLevel} alert for ${watch.name}, ${watch.distanceKm} km from Mauritius: follow the official bulletins.` : "");
  const result = (decision: ReplanDayOutput["decision"], reason: string, options: Option[], speech: string): ToolOutcome<ReplanDayOutput> => ({
    ok: true,
    value: { decision, reason: reason + notes, window: windowOut, weather, options, speech, attribution: { ...ATTRIBUTION } },
  });
  // A moved window is said up front: "The afternoon's over, so for this evening: …",
  // "It's raining now, but for tomorrow afternoon, …" or "For tomorrow afternoon, …".
  const lower = (s: string) => (s.startsWith("I ") ? s : s.charAt(0).toLowerCase() + s.slice(1));
  const moved = (s: string): string => {
    if (win.rolledFrom) return `The ${WINDOWS[win.rolledFrom].label}'s over, so for ${win.label}: ${lower(s)}`;
    if (win.tomorrow && input.reported_weather) return `It's ${REPORT_NOW[input.reported_weather]} now, but for ${win.label}, ${lower(s)}`;
    if (win.tomorrow) return `For ${win.label}, ${lower(s)}`;
    return s;
  };
  const forTomorrow = (s: string): string => viaPrefix(via, moved(s));
  /**
   * Two sentences: the decision, then `second`. With an orange or red system further out,
   * the second sentence is the bulletins advice instead (the first option folds into the first).
   */
  const say = (first: string, second: string, opts: Option[] = [], leadWritten = false): string => {
    const s1 = leadWritten ? viaPrefix(via, first) : forTomorrow(first);
    if (!watch) return fitSpeech(`${s1} ${second}`, s1);
    const withOption = opts[0] ? `${s1.replace(/\.$/, "")}, like ${spokenPlaceName(opts[0].name)}, about ${opts[0].travel_min} minutes away.` : s1;
    return fitSpeech(`${withOption} ${watchSentence(watch)}`, `${s1} ${watchSentence(watch)}`, `${s1} ${watchSentence(watch, true)}`, watchSentence(watch));
  };

  // 1. Cyclone: stay safe, and say nothing beyond the official-bulletin advice.
  if (danger) {
    const level = alertArticle(danger.alertLevel);
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
  const optionSentence = (opts: Option[]) => describeOptions(opts.map((o) => ({ name: spokenPlaceName(o.name), minutes: o.travel_min })));
  const speak = (first: string, opts: Option[]) =>
    watch
      ? say(first, "", opts)
      : fitSpeech(`${forTomorrow(first)} ${optionSentence(opts)}`, `${forTomorrow(first)} ${optionSentence(opts.slice(0, 2))}`, `${forTomorrow(first)} ${optionSentence(opts.slice(0, 1))}`);

  /**
   * Covered places to swap to (for rain and heat), ranked nearest first.
   *
   * Evenings (the window starts at 17:00 or later): the dataset has no opening hours, and
   * museums and estates mostly close by late afternoon, while shopping centres stay open. So
   * shopping centres within a 30-minute drive come first, and the remaining slots go to the
   * nearest other covered places within 30 minutes. With no shopping centre that close, the
   * usual varied pick applies and the reason asks to check opening, but drives are capped at
   * 45 minutes (or at the nearest covered place, if even that is further), so no 50-70-minute
   * drive is offered while a nearer covered place exists.
   */
  const coveredPicks = (): { picks: Array<{ place: Place; km: number }>; evening: "malls" | "check" | null } => {
    const covered = familyFirst(nearby.filter((c) => c.place.rain_ok));
    if (win.fromHour < WINDOWS.evening.from) return { picks: pickVaried(covered, MAX_SWAP_OPTIONS), evening: null };
    const close = covered.filter((c) => travelMinutes(c.km) <= EVENING_DRIVE_MIN);
    const malls = close.filter((c) => c.place.kind === "shopping");
    if (malls.length) {
      const others = close.filter((c) => c.place.kind !== "shopping");
      return { picks: [...malls, ...others].slice(0, MAX_SWAP_OPTIONS), evening: "malls" };
    }
    const nearest = Math.min(...covered.map((c) => travelMinutes(c.km)));
    const cap = Math.max(EVENING_MAX_DRIVE_MIN, nearest);
    const pool = covered.filter((c) => travelMinutes(c.km) <= cap);
    return { picks: pickVaried(pool, MAX_SWAP_OPTIONS), evening: pool.length ? "check" : null };
  };
  const EVENING_REASON = {
    malls: " Evening, so shopping centres first: most museums close by late afternoon.",
    check: " Evening: my list has no opening hours, so check it's still open.",
  } as const;
  /** The option sentence with "check it's still open" when that fits; otherwise without. */
  const speakEvening = (first: string, opts: Option[], check: boolean): string => {
    if (!check || watch || !opts.length) return speak(first, opts);
    const withCheck = (n: number) => optionSentence(opts.slice(0, n)).replace(/\.$/, Math.min(n, opts.length) > 1 ? ", and check they're still open." : ", and check it's still open.");
    const s1 = forTomorrow(first);
    return fitSpeech(`${s1} ${withCheck(3)}`, `${s1} ${withCheck(2)}`, `${s1} ${withCheck(1)}`, speak(first, opts));
  };

  // 3. Wet: swap for covered places nearby, of different kinds.
  if (wet) {
    const { picks, evening } = coveredPicks();
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
    const reasonText = evening ? reason + EVENING_REASON[evening] : reason;
    const speech = options.length
      ? speakEvening(first, options, evening === "check")
      : say(first, `I don't have a covered place within ${SWAP_RADIUS_KM} kilometres in my verified list, so a quiet break indoors may be best.`);
    return result("swap", reasonText, options, speech);
  }

  // 4. Heat: shade or indoors; for the middle of the day, or until it cools off when it's late.
  if (heat) {
    const late = win.fromHour >= LATE_HEAT_HOUR;
    const { picks, evening } = coveredPicks();
    const options = toOptions(picks, (p, m) => `${settingWord(p)} and out of the ${late ? "" : "midday "}sun, about ${m} minutes away.`);
    // "this evening" is already in the lead after a rollover to this evening.
    const until = win.label === "this evening" ? "later" : "this evening";
    const first = late
      ? `It's hot in ${area.name}, so keep to the shade until it cools off ${until}.`
      : `It's hot in ${area.name}, so spend the middle of the day somewhere shaded and keep the beach for later.`;
    const speech = options.length ? speakEvening(first, options, evening === "check") : say(first, "");
    return result("swap", "You reported heat." + (evening ? EVENING_REASON[evening] : ""), options, speech);
  }

  // 5. Windy and the plan is on the water: move it ashore.
  const landIdeas = (n: number) => toOptions(pickVaried(familyFirst(nearby), n), (p, m) => `${settingWord(p)} and on land, about ${m} minutes away.`);
  if (windy && (activity === "boat" || activity === "beach")) {
    const options = landIdeas(MAX_SWAP_OPTIONS);
    const first = `It's too windy over ${area.name} for the water, so ${activity === "boat" ? "skip the boat trip" : "skip swimming"} and stay on land.`;
    const speech = options.length ? speak(first, options) : say(first, "");
    return result("swap", reported === "wind" ? "You reported strong wind." : "Wind of 10 m/s or more is forecast.", options, speech);
  }

  // 6. A report about now, and no forecast for tomorrow's window: nothing to go on yet.
  if (reportSetAside && !haveForecast) {
    return result(
      "keep",
      "No forecast for this window yet.",
      [],
      say(`It's ${REPORT_NOW[input.reported_weather!]} now, and I can't reach the forecast for ${win.label} yet, so keep that plan for now.`, "Ask me again closer to the time.", [], true),
    );
  }

  // 7. Dry (or unknown): keep the plan, with up to 2 outdoor ideas nearby.
  const ideas = toOptions(
    pickVaried(familyFirst(nearby.filter((c) => c.place.setting === "outdoor" || c.place.setting === "mixed")), MAX_KEEP_IDEAS),
    (p, m) => `${settingWord(p)}, about ${m} minutes away.`,
  );
  // After a rollover the asked-for window is over, so "your plan" would mean a plan that's gone.
  const plans = win.rolledFrom ? (win.label === "this evening" ? "your evening plans" : "your plans") : "your plan";
  let first: string;
  let reason: string;
  if (haveForecast) {
    first = windy
      ? `It's dry but windy over ${area.name}, so keep ${plans} and stay off the water.`
      : `The forecast for ${area.name} looks dry${win.tomorrow || win.rolledFrom ? "" : ` for ${win.label}`}, so keep ${plans}.`;
    reason = windy ? "Dry forecast, but wind of 10 m/s or more." : rainyHours === 1 ? "Only 1 rainy hour and no heavy rain forecast." : "Dry forecast.";
  } else if (reported) {
    first = `I can't reach the forecast, but if it's ${reported === "wind" ? "only windy" : "dry"} in ${area.name}, keep ${plans}${windy ? " and stay off the water" : ""}.`;
    reason = reported === "wind" ? "You reported wind; no forecast available." : "You reported dry weather; no forecast available.";
  } else {
    first = `I can't reach the forecast right now, so keep your plan and tell me if it starts to rain.`;
    reason = "No forecast available and no weather reported.";
  }
  const idea = (i: number) => spokenPlaceName(ideas[i]!.name);
  const extra = ideas.length === 0 ? "" : ideas.length === 1 ? `If you want more, ${idea(0)} is about ${ideas[0]!.travel_min} minutes away.` : `Nearby, you could also try ${idea(0)} or ${idea(1)}.`;
  return result("keep", reason, ideas, say(first, extra));
}
