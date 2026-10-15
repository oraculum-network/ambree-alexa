// find_places and place_details: fuzzy matching, the area radius, limits and errors.

import { describe, expect, it } from "vitest";
import { normalize } from "../src/data/match.ts";
import { findPlaces, findPlacesInput, type FindPlacesOutput } from "../src/tools/find-places.ts";
import { placeDetails, placeDetailsInput } from "../src/tools/place-details.ts";
import { sentences } from "../src/tools/speech.ts";
import { replanDay, replanDayInput } from "../src/tools/replan-day.ts";
import { weatherNow, weatherNowInput } from "../src/tools/weather-now.ts";
import { cyclone, datasetPlaces, fakeDeps, fixturePlaces, weatherOf } from "./helpers/deps.ts";

const find = (args: Record<string, unknown>) => findPlaces(findPlacesInput.parse(args), fakeDeps());
const ok = (r: ReturnType<typeof find>): FindPlacesOutput => {
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

describe("matching", () => {
  it("normalizes accents, case and punctuation", () => {
    expect(normalize("Mahébourg")).toBe("mahebourg");
    expect(normalize("  L'Aventure du SUCRE! ")).toBe("l aventure du sucre");
  });

  it("finds areas by id, name, alias, accents and small typos", () => {
    for (const q of ["mahebourg", "Mahébourg", "MAHEBOURG", "Blue Bay", "Mahebourgh", "mahébourg and blue bay"]) {
      expect(fixturePlaces.findArea(q)?.id, q).toBe("mahebourg");
    }
    expect(fixturePlaces.findArea("grand bay")?.id).toBe("grand-baie");
    expect(fixturePlaces.findArea("flic-en-flac")?.id).toBe("flic-en-flac");
    expect(fixturePlaces.findArea("Antarctica")).toBeNull();
  });

  it("finds places by name with typos and articles", () => {
    expect(fixturePlaces.findPlace("the Blue Penny Museum")?.id).toBe("pl-blue-penny");
    expect(fixturePlaces.findPlace("blue peny museum")?.id).toBe("pl-blue-penny");
    expect(fixturePlaces.findPlace("pl-market")?.id).toBe("pl-market");
  });
});

describe("matching against the researched dataset (R6)", () => {
  it("doesn't send other places' names to a wrong area", () => {
    for (const q of ["Grand Bassin", "Grand Bois", "Bay", "Mont", "Port", "Grnd Bai"]) {
      expect(datasetPlaces.findArea(q)?.id, q).toBeUndefined();
    }
  });

  it("still accepts accents, aliases and the reviewer's list of small typos", () => {
    const cases: Array<[string, string]> = [
      ["MAHÉBOURG", "mahebourg"],
      ["Mahe\u0301bourg", "mahebourg"],
      ["Blue Bay", "mahebourg"],
      ["port luis", "port-louis"],
      ["Flic n Flac", "flic-en-flac"],
      ["Chamrel", "chamarel"],
      ["Souilac", "souillac"],
      ["Trou d\u2019Eau Douce", "belle-mare"],
      ["Grand Bai", "grand-baie"],
      ["Pamplemouses", "pamplemousses"],
      ["Le Morne Brabant", "le-morne"],
    ];
    for (const [q, id] of cases) expect(datasetPlaces.findArea(q)?.id, q).toBe(id);
  });

  it("uses a place's area when the area text names a place, and says which place", async () => {
    const deps = fakeDeps({ places: datasetPlaces });
    const found = findPlaces(findPlacesInput.parse({ area: "Grand Bassin", limit: 3 }), deps);
    if (!found.ok) throw new Error(found.message);
    expect(found.value.area).toEqual({ id: "curepipe", name: "Curepipe and the central plateau", via_place: "Grand Bassin (Ganga Talao)" });
    expect(found.value.speech).toMatch(/^Going by Grand Bassin \(Ganga Talao\), near Curepipe and the central plateau, try /);

    const wx = await weatherNow(weatherNowInput.parse({ area: "Grand Bassin" }), deps);
    if (!wx.ok) throw new Error(wx.message);
    expect(wx.value.area).toMatchObject({ id: "curepipe", via_place: "Grand Bassin (Ganga Talao)" });
    expect(wx.value.speech).toMatch(/^Going by Grand Bassin \(Ganga Talao\), in Curepipe and the central plateau /);

    const plan = await replanDay(replanDayInput.parse({ area: "Casela", window: "afternoon", reported_weather: "rain" }), deps);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.value.reason).toMatch(/Area taken from Casela Nature Parks\./);
    expect(plan.value.speech).toMatch(/^Going by Casela Nature Parks, since it's raining in Flic en Flac, head somewhere covered\./);

    // An area that is also a place's name keeps the area (a tie goes to the area).
    const morne = findPlaces(findPlacesInput.parse({ area: "Le Morne Brabant" }), deps);
    expect(morne.ok && morne.value.area).toEqual({ id: "le-morne", name: "Le Morne" });
  });
});

describe("find_places", () => {
  it("lists places in the area first, then others within 25 km, by distance", () => {
    const out = ok(find({ area: "Grand Baie", limit: 8 }));
    expect(out.area).toEqual({ id: "grand-baie", name: "Grand Baie" });
    const areas = out.places.map((p) => p.area_id);
    expect(areas.slice(0, 6).every((a) => a === "grand-baie")).toBe(true);
    expect(areas.slice(6).every((a) => a === "port-louis")).toBe(true);
    const gb = out.places.slice(0, 6).map((p) => p.distance_km!);
    expect(gb).toEqual([...gb].sort((a, b) => a - b));
    expect(out.places[0]).toMatchObject({ id: "gb-beach", distance_km: 0.4, area_name: "Grand Baie" });
  });

  it("excludes places beyond 25 km of the area centre", () => {
    const out = ok(find({ area: "Mahebourg", limit: 8 }));
    expect(out.places.map((p) => p.id)).toEqual(["mb-museum", "mb-lagoon"]);
  });

  it("filters by kind, rain_ok and query", () => {
    expect(ok(find({ area: "Port Louis", kind: "market", rain_ok: true })).places.map((p) => p.id)).toEqual(["pl-market"]);
    expect(ok(find({ area: "Grand Baie", rain_ok: true, limit: 8 })).places.every((p) => p.rain_ok)).toBe(true);
    expect(ok(find({ query: "snorkel" })).places.map((p) => p.id).sort()).toEqual(["gb-snorkel", "mb-lagoon"]);
    expect(ok(find({ query: "museums" })).count).toBe(4);
  });

  it("respects limit (default 5, 1 to 8)", () => {
    expect(ok(find({ area: "grand-baie" })).count).toBe(5);
    expect(ok(find({ area: "grand-baie", limit: 2 })).count).toBe(2);
    expect(findPlacesInput.safeParse({ limit: 9 }).success).toBe(false);
    expect(findPlacesInput.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("without an area, distance_km is null", () => {
    const out = ok(find({ kind: "beach" }));
    expect(out.area).toBeNull();
    expect(out.places.every((p) => p.distance_km === null)).toBe(true);
  });

  it("speaks the top picks in at most 2 sentences", () => {
    const out = ok(find({ area: "Port Louis", kind: "market", rain_ok: true }));
    expect(out.speech).toBe("Near Port Louis, try Port Louis Central Market. Port Louis Central Market is a test place.");
    const none = ok(find({ area: "Flic en Flac", kind: "rum" }));
    expect(none.count).toBe(0);
    expect(none.speech).toBe("I couldn't find any rum distilleries near Flic en Flac in my verified list. Try another area or fewer filters.");
    expect(sentences(none.speech)).toHaveLength(2);
  });

  it("an unknown area is an error naming up to 5 areas", () => {
    const r = find({ area: "Atlantis" });
    expect(r.ok).toBe(false);
    const msg = !r.ok ? r.message : "";
    expect(msg).toMatch(/^I don't know the area 'Atlantis'\. Try: /);
    const named = fixturePlaces.areas.filter((a) => msg.includes(a.name));
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThanOrEqual(5);
  });
});

describe("place_details", () => {
  it("returns the full record with area_name and speech", () => {
    const r = placeDetails(placeDetailsInput.parse({ place: "Blue Penny Museum" }), fakeDeps());
    if (!r.ok) throw new Error(r.message);
    expect(r.value.place).toMatchObject({ id: "pl-blue-penny", area: "port-louis", area_name: "Port Louis", source: "https://ambree.ai/", verified_at: "2026-10-01", notes: null, coords_approx: false });
    expect(r.value.place.lat).toBeCloseTo(-20.161);
    expect(r.value.speech).toBe("Blue Penny Museum is a test place. Allow about an hour, and it works in the rain.");
  });

  it("an unknown place suggests only close names, read with 'or' between them (R15)", () => {
    const near = placeDetails(placeDetailsInput.parse({ place: "Natural Histry Museum" }), fakeDeps());
    expect(near).toEqual({
      ok: false,
      message: "I don't have a place called 'Natural Histry Museum' in my verified list. Did you mean Naval History Museum or Sugar Story Museum?",
    });
    const one = placeDetails(placeDetailsInput.parse({ place: "Shel Musem" }), fakeDeps());
    expect(!one.ok && one.message).toMatch(/Did you mean Shell Museum\?$/);
  });

  it("an unknown place with nothing close says to try find_places (R15)", () => {
    for (const q of ["zqxjzqxjzqxj", "Penny Black Museum of Stamps"]) {
      const r = placeDetails(placeDetailsInput.parse({ place: q }), fakeDeps({ places: datasetPlaces }));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message, q).toBe(`I don't have a place called '${q}' in my verified list. Try find_places with an area or a kind to see what's there.`);
    }
  });
});

describe("weather_now speech (R14, R17)", () => {
  it("calls continuous rain 'rain for the next N hours', not 'on and off'", async () => {
    const wx = await weatherNow(weatherNowInput.parse({ area: "Grand Baie", hours: 6 }), fakeDeps({ weather: weatherOf(() => ({ precip: 2, temp: 26 })) }));
    if (!wx.ok) throw new Error(wx.message);
    expect(wx.value.speech).toMatch(/^In Grand Baie it's 26 degrees, with rain for the next 6 hours\./);
    expect(wx.value.speech).not.toMatch(/on and off/);
  });

  it("mentions an orange or red system out to 1,200 km as bulletin advice", async () => {
    const far = await weatherNow(weatherNowInput.parse({ area: "Grand Baie" }), fakeDeps({ cyclones: [cyclone("Orange", 1000, false)] }));
    if (!far.ok) throw new Error(far.message);
    expect(far.value.speech).toMatch(/Tropical Cyclone Alpha has an orange alert (about )?1000 kilometres/);
    expect(far.value.speech).toMatch(/official cyclone bulletins/);
    expect(sentences(far.value.speech).length).toBeLessThanOrEqual(2);
    const green = await weatherNow(weatherNowInput.parse({ area: "Grand Baie" }), fakeDeps({ cyclones: [cyclone("Green", 300, true)] }));
    expect(green.ok && green.value.speech).not.toMatch(/cyclone/i);
  });
});
