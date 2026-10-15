// weather_now: the live hourly forecast for an area, with cyclone alerts near Mauritius.

import { z } from "zod";
import { isDangerous, isWorthWatching } from "../feeds/cyclones.ts";
import { floorHour, hourOfMu, isoMu } from "../time.ts";
import { ATTRIBUTION, type ToolDeps, type ToolOutcome, fail, forecastPoint, resolveArea, viaPrefix } from "./context.ts";
import { areaOut } from "./find-places.ts";
import { alertArticle, cycloneOut, cyclonesOut, hourOut, hoursOut, isWindy, rainySpells, spokenCycloneName, summarise, summaryOut, watchSentence } from "./forecast.ts";
import { capitalise, degrees, fitSpeech, spokenTime } from "./speech.ts";

export const weatherNowInput = z.object({
  area: z.string().min(1).max(80).describe("Area id, name or alias, e.g. 'Flic en Flac'."),
  hours: z.int().min(3).max(12).default(12).describe("How many hours ahead (3 to 12)."),
});
export type WeatherNowInput = z.infer<typeof weatherNowInput>;

export const weatherNowOutput = z.object({
  area: areaOut,
  status: z.enum(["ok", "stale", "unavailable"]),
  retrieved_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  hours: z.array(hourOut),
  summary: summaryOut,
  cyclones: z.array(cycloneOut),
  attribution: z.object({ weather: z.string(), cyclones: z.string() }),
  speech: z.string(),
});
export type WeatherNowOutput = z.infer<typeof weatherNowOutput>;

export async function weatherNow(input: WeatherNowInput, deps: ToolDeps): Promise<ToolOutcome<WeatherNowOutput>> {
  const r = resolveArea(deps.places, input.area);
  if ("error" in r) return fail(r.error);
  const { area, via } = r;
  const now = deps.now();
  const point = forecastPoint(area);
  const [wx, tc] = await Promise.all([deps.weather.get(point.lat, point.lon, now), deps.cyclones.get(now)]);

  const fromHour = floorHour(now);
  const steps = wx.steps.filter((s) => s.time >= fromHour).slice(0, input.hours ?? 12);
  const status = wx.status !== "unavailable" && steps.length === 0 ? "unavailable" : wx.status;
  const summary = summarise(steps);
  const danger = tc.systems.find(isDangerous);
  const watch = danger ? undefined : tc.systems.find(isWorthWatching);

  let weatherSentence: string;
  let second = "";
  if (status === "unavailable") {
    weatherSentence = `I can't reach the forecast for ${area.name} right now.`;
    second = "Please try again in a few minutes.";
  } else {
    const first = steps[0]!;
    const temp = first.tempC === null ? "" : ` it's ${degrees(first.tempC)}`;
    const spells = rainySpells(steps);
    const windy = steps.some(isWindy);
    let rain: string;
    if (!spells.length) rain = windy ? "it should stay dry but windy" : "it should stay dry";
    else if (spells[0]!.start === 0) {
      const end = steps[spells[0]!.end + 1];
      rain = end ? `with rain until about ${spokenTime(hourOfMu(end.time))}` : `with rain for the next ${steps.length} hours`;
    } else rain = `with rain likely from about ${spokenTime(hourOfMu(steps[spells[0]!.start]!.time))}`;
    const span = `the next ${steps.length} hours`;
    weatherSentence = !spells.length
      ? `In ${area.name}${temp ? temp + " and" : ""} ${rain}.`
      : `In ${area.name}${temp ? temp + "," : ""} ${rain}.`;
    if (summary.temp_min_c !== null && summary.temp_max_c !== null && Math.round(summary.temp_min_c) !== Math.round(summary.temp_max_c)) {
      second = `Expect ${Math.round(summary.temp_min_c)} to ${degrees(summary.temp_max_c)} over ${span}.`;
    }
    if (status === "stale") second = "This forecast is a few hours old.";
  }
  weatherSentence = viaPrefix(via, weatherSentence);
  let speech = fitSpeech(`${weatherSentence} ${second}`, weatherSentence);
  if (danger) {
    const alert = `${capitalise(spokenCycloneName(danger.name))} has ${alertArticle(danger.alertLevel)} alert near Mauritius, so follow the official cyclone bulletins from the Mauritius Meteorological Services.`;
    speech = fitSpeech(`${alert} ${weatherSentence}`, alert);
  } else if (watch) {
    speech = fitSpeech(`${weatherSentence} ${watchSentence(watch)}`, `${weatherSentence} ${watchSentence(watch, true)}`, watchSentence(watch));
  }

  return {
    ok: true,
    value: {
      area: { id: area.id, name: area.name, ...(via ? { via_place: via.name } : {}) },
      status,
      retrieved_at: wx.fetchedAt === null ? null : isoMu(wx.fetchedAt),
      updated_at: wx.updatedAt,
      hours: status === "unavailable" ? [] : hoursOut(steps),
      summary,
      cyclones: cyclonesOut(tc.systems),
      attribution: { ...ATTRIBUTION },
      speech,
    },
  };
}
