// replan_day: swap, keep, stay safe, wind, heat, windows and travel times.

import { describe, expect, it } from "vitest";
import { travelMinutes } from "../src/geo.ts";
import { sentences } from "../src/tools/speech.ts";
import { type ReplanDayOutput, replanDay, replanDayInput, replanDayOutput, resolveWindow } from "../src/tools/replan-day.ts";
import { FIXED_NOW } from "./helpers/app.ts";
import { rainBetween } from "./helpers/forecast.ts";
import { UNAVAILABLE, cyclone, datasetPlaces, fakeDeps, weatherOf } from "./helpers/deps.ts";

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

  it("moves a window that is already over to tomorrow when nothing is reported, and says so", async () => {
    const w = resolveWindow("morning", FIXED_NOW);
    expect(w).toMatchObject({ date: "2026-10-16", fromHour: 7, toHour: 12, label: "tomorrow morning", tomorrow: true, reportApplies: false });
    const out = await run({ area: "grand-baie", window: "morning" });
    expect(out.window).toEqual({ label: "tomorrow morning", date: "2026-10-16", from: "07:00", to: "12:00" });
    expect(out.speech).toMatch(/^For tomorrow morning, the forecast for Grand Baie looks dry, so keep your plan\./);
  });

  it("with a report and the morning over, re-plans the rest of today and says so", async () => {
    expect(resolveWindow("morning", FIXED_NOW, true)).toMatchObject({ name: "rest_of_day", rolledFrom: "morning", label: "the rest of today", fromHour: 13, toHour: 21, tomorrow: false, reportApplies: true });
    const out = await run({ area: "grand-baie", window: "morning", reported_weather: "rain" });
    expect(out.decision).toBe("swap");
    expect(out.window).toEqual({ label: "the rest of today", date: "2026-10-15", from: "13:00", to: "21:00" });
    expect(out.speech).toMatch(/^The morning's over, so for the rest of today: since it's raining in Grand Baie, head somewhere covered\. Try /);
  });
});

describe("a weather report is about now (R2)", () => {
  const EVENING = Date.UTC(2026, 9, 15, 14, 35); // 18:35 in Mauritius
  const LATE = Date.UTC(2026, 9, 15, 17, 30); // 21:30 in Mauritius
  const dryAll = (now: number) => weatherOf(() => ({}), now);

  it("18:35 with reported rain and the afternoon window: a swap for this evening", async () => {
    const out = await run(
      { area: "grand-baie", window: "afternoon", reported_weather: "rain", plan: "beach" },
      fakeDeps({ now: EVENING, weather: dryAll(EVENING) }),
    );
    expect(out.decision).toBe("swap");
    expect(out.window).toEqual({ label: "this evening", date: "2026-10-15", from: "18:00", to: "21:00" });
    expect(out.weather.basis).toBe("both");
    // The fixture has no shopping centres, so the evening rule asks to check opening.
    expect(out.reason).toBe("You reported rain. Evening: my list has no opening hours, so check it's still open.");
    expect(out.options.every((o) => o.rain_ok)).toBe(true);
    expect(out.speech).toMatch(/^The afternoon's over, so for this evening: since it's raining in Grand Baie, skip the beach\. Try /);
    expect(sentences(out.speech)).toHaveLength(2);
  });

  it("18:35 with the researched dataset: shopping centres first, since museums close by late afternoon", async () => {
    const out = await run(
      { area: "grand-baie", window: "afternoon", reported_weather: "rain", plan: "beach" },
      fakeDeps({ places: datasetPlaces, now: EVENING, weather: dryAll(EVENING) }),
    );
    expect(out.decision).toBe("swap");
    // N2: shopping centres within a 30-minute drive come first, then the nearest other covered
    // places within 30 minutes fill the remaining slots.
    expect(out.options.map((o) => o.name)).toEqual(["Grand Baie La Croisette", "Mont Choisy Le Mall", "Château de Labourdonnais"]);
    expect(out.options.slice(0, 2).every((o) => o.kind === "shopping")).toBe(true);
    expect(out.options.every((o) => o.rain_ok && o.travel_min <= 30)).toBe(true);
    expect(out.reason).toBe("You reported rain. Evening, so shopping centres first: most museums close by late afternoon.");
    expect(sentences(out.speech)).toHaveLength(2);
    // The same request in the afternoon keeps the varied mix (a museum among the options).
    const AFTERNOON = Date.UTC(2026, 9, 15, 9, 0); // 13:00 in Mauritius
    const day = await run(
      { area: "grand-baie", window: "afternoon", reported_weather: "rain", plan: "beach" },
      fakeDeps({ places: datasetPlaces, now: AFTERNOON, weather: dryAll(AFTERNOON) }),
    );
    expect(new Set(day.options.map((o) => o.kind)).size).toBeGreaterThan(1);
  });

  it("evenings: no 50-70-minute drives where a nearer covered option exists (the reviewer's table, 17:00)", async () => {
    const FIVE_PM = Date.UTC(2026, 9, 15, 13, 0); // 17:00 in Mauritius
    const expected: Record<string, string[]> = {
      souillac: ["Domaine de Saint Aubin", "Bois Chéri Tea Estate", "Rhumerie de Chamarel"],
      "le-morne": ["Rhumerie de Chamarel", "Martello Tower Museum", "Cascavelle Mall"],
      mahebourg: ["Bo'Valon Mall", "Mahébourg Market", "Biscuiterie Rault"],
      "belle-mare": ["Château de Labourdonnais"],
    };
    for (const [area, names] of Object.entries(expected)) {
      const out = await run({ area, window: "evening", reported_weather: "rain" }, fakeDeps({ places: datasetPlaces, now: FIVE_PM, weather: dryAll(FIVE_PM) }));
      expect(out.options.map((o) => o.name), area).toEqual(names);
      expect(out.options.every((o) => o.travel_min < 50), area).toBe(true);
    }
    // Where no shopping centre is within 30 minutes, the reason (and, when it fits, the speech) asks to check opening.
    const souillac = await run({ area: "souillac", window: "evening", reported_weather: "rain" }, fakeDeps({ places: datasetPlaces, now: FIVE_PM, weather: dryAll(FIVE_PM) }));
    expect(souillac.reason).toBe("You reported rain. Evening: my list has no opening hours, so check it's still open.");
    expect(souillac.speech).toMatch(/, and check they're still open\.$/);
    // One option reads in the singular.
    const belleMare = await run({ area: "belle-mare", window: "evening", reported_weather: "rain" }, fakeDeps({ places: datasetPlaces, now: FIVE_PM, weather: dryAll(FIVE_PM) }));
    expect(belleMare.options).toHaveLength(1);
    expect(belleMare.speech).toMatch(/, and check it's still open\.$/);
  });

  it("evenings never offer a drive over 45 minutes while a covered place within 30 minutes exists (all areas, rain and heat)", async () => {
    for (const hour of [17, 18, 19, 20]) {
      const now = Date.UTC(2026, 9, 15, hour - 4, 10);
      for (const area of datasetPlaces.areas) {
        const coveredWithin30 = datasetPlaces.near(area.lat, area.lon, 35).some((c) => c.place.rain_ok && travelMinutes(c.km) <= 30);
        for (const reported_weather of ["rain", "heat"] as const) {
          const out = await run({ area: area.id, window: "evening", reported_weather }, fakeDeps({ places: datasetPlaces, now, weather: dryAll(now) }));
          const longest = Math.max(...out.options.map((o) => o.travel_min));
          if (coveredWithin30) expect(longest, `${area.id} ${hour}:10 ${reported_weather}`).toBeLessThanOrEqual(45);
          const malls = out.options.filter((o) => o.kind === "shopping");
          for (const m of malls) expect(m.travel_min, `${area.id} mall`).toBeLessThanOrEqual(45);
        }
      }
    }
  });

  it("heat late in the day: the shade until it cools off, and the evening places from 17:00 (N1)", async () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 9, 15, h - 4, m);
    const ask = (now: number, window: "rest_of_day" | "afternoon") =>
      run({ area: "grand-baie", window, reported_weather: "heat" }, fakeDeps({ places: datasetPlaces, now, weather: dryAll(now) }));
    expect((await ask(at(14), "rest_of_day")).speech).toMatch(/^It's hot in Grand Baie, so spend the middle of the day somewhere shaded and keep the beach for later\./);
    const three = await ask(at(15, 30), "rest_of_day");
    expect(three.speech).toMatch(/^It's hot in Grand Baie, so keep to the shade until it cools off this evening\. Try /);
    expect(three.reason).toBe("You reported heat.");
    const six = await ask(at(18), "rest_of_day");
    expect(six.speech).toMatch(/^It's hot in Grand Baie, so keep to the shade until it cools off this evening\./);
    expect(six.reason).toBe("You reported heat. Evening, so shopping centres first: most museums close by late afternoon.");
    expect(six.options.every((o) => o.travel_min <= 30)).toBe(true);
    const rolled = await ask(at(20, 59), "afternoon");
    expect(rolled.speech).toMatch(/^The afternoon's over, so for this evening: it's hot in Grand Baie, so keep to the shade until it cools off later\. Try /);
    expect(rolled.speech).not.toMatch(/middle of the day/);
  });

  it("after a rollover, keep means the evening plans, not a plan whose window is over (N7)", async () => {
    const evening = await run({ area: "grand-baie", window: "afternoon", reported_weather: "dry" }, fakeDeps({ now: EVENING, weather: dryAll(EVENING) }));
    expect(evening.decision).toBe("keep");
    expect(evening.speech).toMatch(/^The afternoon's over, so for this evening: the forecast for Grand Baie looks dry, so keep your evening plans\./);
    const restOfDay = await run({ area: "grand-baie", window: "morning", reported_weather: "dry" });
    expect(restOfDay.speech).toMatch(/^The morning's over, so for the rest of today: the forecast for Grand Baie looks dry, so keep your plans\./);
    // Not rolled over: still "your plan".
    expect((await run({ area: "grand-baie", window: "afternoon" })).speech).toMatch(/so keep your plan\./);
  });

  it("21:30 with reported rain and a dry tomorrow: keep for tomorrow, going by the forecast", async () => {
    const out = await run(
      { area: "grand-baie", window: "afternoon", reported_weather: "rain", plan: "beach" },
      fakeDeps({ now: LATE, weather: dryAll(LATE) }),
    );
    expect(out.decision).toBe("keep");
    expect(out.window).toEqual({ label: "tomorrow afternoon", date: "2026-10-16", from: "12:00", to: "17:00" });
    expect(out.weather.basis).toBe("forecast");
    expect(out.reason).toBe("Dry forecast. Your report is about now, so it doesn't decide tomorrow.");
    expect(out.speech).toMatch(/^It's raining now, but for tomorrow afternoon, the forecast for Grand Baie looks dry, so keep your plan\./);
  });

  it("21:30 with reported rain and a wet tomorrow: the swap comes from the forecast", async () => {
    const out = await run(
      { area: "grand-baie", window: "afternoon", reported_weather: "rain" },
      fakeDeps({ now: LATE, weather: weatherOf(rainBetween(13, 15), LATE) }),
    );
    expect(out.decision).toBe("swap");
    expect(out.weather.basis).toBe("forecast");
    expect(out.speech).toMatch(/^It's raining now, but for tomorrow afternoon, rain is forecast over Grand Baie from about one/);
  });

  it("21:30 with a report and no forecast: keeps tomorrow's plan and says why", async () => {
    const out = await run({ area: "grand-baie", window: "afternoon", reported_weather: "rain" }, fakeDeps({ now: LATE, weather: UNAVAILABLE }));
    expect(out.decision).toBe("keep");
    expect(out.weather.basis).toBe("unavailable");
    expect(out.speech).toBe("It's raining now, and I can't reach the forecast for tomorrow afternoon yet, so keep that plan for now. Ask me again closer to the time.");
  });

  it("reported wind gets the same treatment", async () => {
    const evening = await run(
      { area: "grand-baie", window: "afternoon", reported_weather: "wind", plan: "catamaran trip" },
      fakeDeps({ now: EVENING, weather: dryAll(EVENING) }),
    );
    expect(evening.decision).toBe("swap");
    expect(evening.window.label).toBe("this evening");
    expect(evening.speech).toMatch(/^The afternoon's over, so for this evening: it's too windy over Grand Baie for the water/);
    expect(ids(evening)).not.toContain("gb-snorkel");

    const late = await run(
      { area: "grand-baie", window: "afternoon", reported_weather: "wind", plan: "catamaran trip" },
      fakeDeps({ now: LATE, weather: dryAll(LATE) }),
    );
    expect(late.decision).toBe("keep");
    expect(late.window.label).toBe("tomorrow afternoon");
    expect(late.speech).toMatch(/^It's windy now, but for tomorrow afternoon, the forecast for Grand Baie looks dry, so keep your plan\./);
  });

  it("trusts a report for a window that starts later today", async () => {
    const out = await run({ area: "grand-baie", window: "evening", reported_weather: "rain" });
    expect(out.window).toMatchObject({ label: "this evening", from: "17:00" });
    expect(out.decision).toBe("swap");
    expect(out.weather.basis).toBe("both");
  });

  it("rest_of_day runs from now to 21:00, and after 21:00 means tomorrow", () => {
    expect(resolveWindow("rest_of_day", FIXED_NOW)).toMatchObject({ fromHour: 13, toHour: 21, label: "the rest of today" });
    const late = Date.UTC(2026, 9, 15, 17, 30); // 21:30 in Mauritius
    expect(resolveWindow("rest_of_day", late)).toMatchObject({ date: "2026-10-16", fromHour: 7, toHour: 21, label: "tomorrow" });
    // From 21:00 a report about now can't roll anything over: tomorrow, from the forecast only.
    expect(resolveWindow("afternoon", late, true)).toMatchObject({ date: "2026-10-16", label: "tomorrow afternoon", reportApplies: false });
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

  it("stay safe needs Mauritius affected or 800 km; out to 1,200 km it's advice only (R17)", async () => {
    // Orange 700 km away, Mauritius not listed: stay safe.
    expect((await run({ area: "grand-baie" }, fakeDeps({ cyclones: [cyclone("Orange", 700, false)] }))).decision).toBe("stay_safe");
    // Orange 1,100 km away but GDACS lists Mauritius as affected: stay safe.
    expect((await run({ area: "grand-baie" }, fakeDeps({ cyclones: [cyclone("Orange", 1100, true)] }))).decision).toBe("stay_safe");
    // Red 1,000 km away, not affecting Mauritius: plan as usual, and mention the bulletins.
    const far = await run({ area: "grand-baie", window: "afternoon" }, fakeDeps({ cyclones: [cyclone("Red", 1000, false)] }));
    expect(far.decision).toBe("keep");
    expect(far.reason).toMatch(/GDACS Red alert for Tropical Cyclone ALPHA-26, 1000 km from Mauritius: follow the official bulletins\./);
    expect(far.speech).toMatch(/^The forecast for Grand Baie looks dry for this afternoon, so keep your plan\. Tropical Cyclone Alpha has a red alert about 1000 kilometres from Mauritius, so keep an eye on the official cyclone bulletins from the Mauritius Meteorological Services\.$/);
    // A swap folds its first option into the first sentence to keep 2 sentences.
    const farWet = await run({ area: "grand-baie", window: "afternoon", reported_weather: "rain" }, fakeDeps({ cyclones: [cyclone("Orange", 1150, false)] }));
    expect(farWet.decision).toBe("swap");
    expect(sentences(farWet.speech)).toHaveLength(2);
    expect(farWet.speech).toMatch(/official cyclone bulletins/);
    expect(farWet.speech.length).toBeLessThanOrEqual(280);
  });

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
    const out = await replanDay(replanDayInput.parse({ area: "Grand Bai" }), fakeDeps());
    expect(out.ok).toBe(true); // one edit: close enough to match Grand Baie
    expect((await replanDay(replanDayInput.parse({ area: "Grnd Bai" }), fakeDeps())).ok).toBe(false); // two edits on ten letters
    const bad = await replanDay(replanDayInput.parse({ area: "Reykjavik" }), fakeDeps());
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.message).toMatch(/^I don't know the area 'Reykjavik'\. Try: /);
  });
});

describe("speech limits across the researched dataset", () => {
  it("every area, window, report, time and cyclone state keeps speech to 2 sentences and 280 characters", async () => {
    const times = [Date.UTC(2026, 9, 15, 3), FIXED_NOW, Date.UTC(2026, 9, 15, 14, 35), Date.UTC(2026, 9, 15, 17, 30)];
    const reports = [undefined, "rain", "dry", "wind", "heat"] as const;
    const windows = ["morning", "afternoon", "evening", "rest_of_day"] as const;
    const storms = [[], [cyclone("Orange", 1100, false)], [cyclone("Red", 300, true)]];
    let checked = 0;
    for (const now of times) {
      const wx = [weatherOf(rainBetween(13, 16), now), UNAVAILABLE];
      for (const area of datasetPlaces.areas)
        for (const window of windows)
          for (const reported_weather of reports)
            for (const cyclones of storms)
              for (const weather of wx) {
                const out = await replanDay(
                  replanDayInput.parse({ area: area.name, window, reported_weather, plan: "beach" }),
                  fakeDeps({ places: datasetPlaces, now, weather, cyclones }),
                );
                if (!out.ok) throw new Error(out.message);
                replanDayOutput.parse(out.value);
                expect(out.value.speech.length, out.value.speech).toBeLessThanOrEqual(280);
                expect(sentences(out.value.speech).length, out.value.speech).toBeLessThanOrEqual(2);
                checked++;
              }
    }
    expect(checked).toBe(4 * 13 * 4 * 5 * 3 * 2);
  });
});
