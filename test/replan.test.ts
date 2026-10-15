// replan_day: swap, keep, stay safe, wind, heat, windows and travel times.

import { describe, expect, it } from "vitest";
import { travelMinutes } from "../src/geo.ts";
import { sentences } from "../src/tools/speech.ts";
import { type ReplanDayOutput, replanDay, replanDayInput, resolveWindow } from "../src/tools/replan-day.ts";
import { FIXED_NOW } from "./helpers/app.ts";
import { rainBetween } from "./helpers/forecast.ts";
import { UNAVAILABLE, cyclone, fakeDeps, weatherOf } from "./helpers/deps.ts";

async function run(args: Record<string, unknown>, deps = fakeDeps()): Promise<ReplanDayOutput> {
  const out = await replanDay(replanDayInput.parse(args), deps);
  if (!out.ok) throw new Error(out.message);
  return out.value;
}

const ids = (o: ReplanDayOutput) => o.options.map((x) => x.id);

describe("windows (Mauritius time, UTC+4)", () => {
  it("starts an elapsed part of the window at the current hour", () => {
    const w = resolveWindow("afternoon", FIXED_NOW); // 13:30 in Mauritius
    expect(w).toMatchObject({ date: "2026-10-15", fromHour: 13, toHour: 17, label: "this afternoon", tomorrow: false });
  });

  it("moves a window that is already over to tomorrow and says so", async () => {
    const w = resolveWindow("morning", FIXED_NOW);
    expect(w).toMatchObject({ date: "2026-10-16", fromHour: 7, toHour: 12, label: "tomorrow morning", tomorrow: true });
    const out = await run({ area: "grand-baie", window: "morning", reported_weather: "rain" });
    expect(out.window).toEqual({ label: "tomorrow morning", date: "2026-10-16", from: "07:00", to: "12:00" });
    expect(out.speech).toMatch(/^For tomorrow morning, /);
  });

  it("rest_of_day runs from now to 21:00, and after 21:00 means tomorrow", () => {
    expect(resolveWindow("rest_of_day", FIXED_NOW)).toMatchObject({ fromHour: 13, toHour: 21, label: "the rest of today" });
    const late = Date.UTC(2026, 9, 15, 17, 30); // 21:30 in Mauritius
    expect(resolveWindow("rest_of_day", late)).toMatchObject({ date: "2026-10-16", fromHour: 7, toHour: 21, label: "tomorrow" });
    const early = Date.UTC(2026, 9, 15, 1); // 05:00 in Mauritius
    expect(resolveWindow("rest_of_day", early)).toMatchObject({ date: "2026-10-15", fromHour: 7 });
  });
});

describe("travel_min", () => {
  it("is haversine km x 1.35 at 35 km/h, rounded to 5 minutes, at least 5", () => {
    expect(travelMinutes(0.4)).toBe(5);
    expect(travelMinutes(7.8)).toBe(20); // 18.05 min
    expect(travelMinutes(18.3)).toBe(40); // 42.35 min
    expect(travelMinutes(10)).toBe(25); // 23.14 min
    expect(travelMinutes(35)).toBe(80); // 81 min
  });
});

describe("decisions", () => {
  it("reported rain swaps to nearby rain_ok places of mixed kinds, nearest first", async () => {
    const out = await run({ area: "Grand Baie", window: "afternoon", reported_weather: "rain", plan: "beach" });
    expect(out.decision).toBe("swap");
    expect(out.weather.basis).toBe("both");
    expect(out.options.every((o) => o.rain_ok)).toBe(true);
    // boat (0.9 km), museum (4.1 km), then the market (18.3 km) rather than a second museum (5.2 km).
    expect(ids(out)).toEqual(["gb-glass-boat", "gb-museum-a", "pl-market"]);
    expect(new Set(out.options.map((o) => o.kind)).size).toBe(3);
    expect(out.options.map((o) => o.travel_min)).toEqual([5, 10, 40]);
    expect(out.speech).toBe("Since it's raining in Grand Baie, skip the beach. Try Glass Bottom Cabin Cruise, about 5 minutes away, then Sugar Story Museum or Port Louis Central Market.");
    expect(sentences(out.speech)).toHaveLength(2);
  });

  it("stays within 35 km of the area centre", async () => {
    const out = await run({ area: "mahebourg", window: "afternoon", reported_weather: "rain" });
    // Port Louis is 34 km from Mahébourg's centre, Grand Baie 41 km.
    expect(ids(out)).toEqual(["mb-museum", "pl-market", "pl-blue-penny"]);
  });

  it("forecast rain (2 rainy hours) swaps, and the speech says when", async () => {
    const out = await run({ area: "grand-baie", window: "afternoon", plan: "beach" }, fakeDeps({ weather: weatherOf(rainBetween(13, 15)) }));
    expect(out.decision).toBe("swap");
    expect(out.weather.basis).toBe("forecast");
    expect(out.reason).toMatch(/2 rainy hours/);
    expect(out.speech).toMatch(/^Rain's settled over Grand Baie until about three, so skip the beach\. Try /);
  });

  it("a single hour of 1 mm or more is enough to swap", async () => {
    const out = await run({ area: "grand-baie", window: "afternoon" }, fakeDeps({ weather: weatherOf(rainBetween(15, 16, 1.2)) }));
    expect(out.decision).toBe("swap");
    expect(out.speech).toMatch(/from about three/);
  });

  it("one light shower is not enough: keep, with up to 2 outdoor ideas", async () => {
    const out = await run({ area: "grand-baie", window: "afternoon", plan: "museum visit" }, fakeDeps({ weather: weatherOf(rainBetween(15, 16, 0.6)) }));
    expect(out.decision).toBe("keep");
    expect(out.options.length).toBeLessThanOrEqual(2);
    expect(out.options.every((o) => o.setting === "outdoor" || o.setting === "mixed")).toBe(true);
  });

  it("dry gives keep", async () => {
    const out = await run({ area: "grand-baie", window: "afternoon", plan: "beach at Lagoon Test Beach" });
    expect(out.decision).toBe("keep");
    expect(out.reason).toBe("Dry forecast.");
    expect(out.speech).toMatch(/^The forecast for Grand Baie looks dry for this afternoon, so keep your plan\./);
    // The plan's own place is not offered back as an idea.
    expect(ids(out)).not.toContain("gb-beach");
  });

  it("wind excludes boat, snorkel and swim places (reported or forecast)", async () => {
    const reported = await run({ area: "grand-baie", window: "afternoon", reported_weather: "wind", plan: "museum" });
    expect(reported.decision).toBe("keep");
    for (const o of reported.options) expect(["gb-glass-boat", "gb-snorkel", "gb-beach"]).not.toContain(o.id);

    const forecast = await run({ area: "grand-baie", window: "afternoon", plan: "catamaran trip" }, fakeDeps({ weather: weatherOf(() => ({ wind: 12 })) }));
    expect(forecast.decision).toBe("swap");
    expect(forecast.speech).toMatch(/too windy/);
    expect(ids(forecast)).not.toContain("gb-snorkel");
    expect(ids(forecast)).not.toContain("gb-glass-boat");

    const wetAndWindy = await run({ area: "grand-baie", window: "afternoon", reported_weather: "rain" }, fakeDeps({ weather: weatherOf(() => ({ wind: 11 })) }));
    expect(ids(wetAndWindy)).toEqual(["gb-museum-a", "gb-museum-b", "pl-market"]);
  });

  it("heat prefers shaded or indoor places", async () => {
    const out = await run({ area: "grand-baie", window: "afternoon", reported_weather: "heat" });
    expect(out.decision).toBe("swap");
    expect(out.options.every((o) => o.rain_ok)).toBe(true);
    expect(out.speech).toMatch(/^It's hot in Grand Baie/);
  });

  it("families get places tagged family or kids first when distances are close", async () => {
    const out = await run({ area: "grand-baie", window: "afternoon", reported_weather: "rain", party: "family" });
    expect(ids(out)[0]).toBe("gb-museum-a");
  });

  for (const level of ["Orange", "Red"] as const) {
    it(`${level === "Red" ? "a red" : "an orange"} cyclone near Mauritius gives stay_safe and only the official advice`, async () => {
      const out = await run({ area: "grand-baie", reported_weather: "rain" }, fakeDeps({ cyclones: [cyclone(level)] }));
      expect(out.decision).toBe("stay_safe");
      expect(out.options).toEqual([]);
      expect(out.speech).toBe(
        `Tropical Cyclone Alpha has ${level === "Red" ? "a red" : "an orange"} alert near Mauritius, so stay put for now. Follow the official cyclone bulletins from the Mauritius Meteorological Services.`,
      );
    });
  }

  it("a green cyclone does not stop the day", async () => {
    const out = await run({ area: "grand-baie", window: "afternoon" }, fakeDeps({ cyclones: [cyclone("Green")] }));
    expect(out.decision).toBe("keep");
  });

  it("with the forecast unavailable it decides from the reported weather alone, and says so", async () => {
    const rain = await run({ area: "grand-baie", window: "afternoon", reported_weather: "rain", plan: "beach" }, fakeDeps({ weather: UNAVAILABLE }));
    expect(rain.decision).toBe("swap");
    expect(rain.weather).toEqual({ basis: "reported", summary: "Forecast unavailable for this window." });
    expect(rain.speech).toMatch(/^I can't reach the forecast, but since it's raining in Grand Baie, skip the beach\./);

    const dry = await run({ area: "grand-baie", window: "afternoon", reported_weather: "dry" }, fakeDeps({ weather: UNAVAILABLE }));
    expect(dry.decision).toBe("keep");
    expect(dry.speech).toMatch(/^I can't reach the forecast, but if it's dry/);

    const nothing = await run({ area: "grand-baie", window: "afternoon" }, fakeDeps({ weather: UNAVAILABLE }));
    expect(nothing.decision).toBe("keep");
    expect(nothing.weather.basis).toBe("unavailable");
  });

  it("asks the forecast for the area centre rounded to 2 decimals", async () => {
    const deps = fakeDeps();
    await run({ area: "grand-baie" }, deps);
    expect(deps.calls.weather).toEqual([[-20.01, 57.58]]);
  });

  it("an unknown area is an error with suggestions", async () => {
    const out = await replanDay(replanDayInput.parse({ area: "Grnd Bai" }), fakeDeps());
    expect(out.ok).toBe(true); // close enough to match Grand Baie
    const bad = await replanDay(replanDayInput.parse({ area: "Reykjavik" }), fakeDeps());
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.message).toMatch(/^I don't know the area 'Reykjavik'\. Try: /);
  });
});
