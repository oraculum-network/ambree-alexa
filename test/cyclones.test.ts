// GDACS: parsing, the distance and alert-level filters, and the client cache.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NEAR_KM, createCycloneClient, isDangerous, nearMauritius, parseGdacs } from "../src/feeds/cyclones.ts";
import { spokenCycloneName } from "../src/tools/forecast.ts";
import { type MockServer, json, startMockServer } from "./helpers/mock-server.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/gdacs-tc.json", import.meta.url), "utf8"));
const NOW = Date.UTC(2026, 9, 15, 9);

describe("parseGdacs", () => {
  it("keeps current tropical cyclones with a recent advisory", () => {
    const systems = parseGdacs(fixture, NOW)!;
    // DELTA is not current, ECHO's last advisory is 5 days old, and the EQ is not a cyclone.
    expect(systems.map((s) => s.name)).toEqual(["Tropical Cyclone ALPHA-26", "Tropical Cyclone BRAVO", "Typhoon CHARLIE-26"]);
    const alpha = systems[0]!;
    expect(alpha).toMatchObject({ id: 1001234, alertLevel: "Orange", lat: -17.8, lon: 55.9, countries: ["MUS", "REU"] });
    expect(alpha.reportUrl).toBe("https://www.gdacs.org/report.aspx?eventid=1001234&eventtype=TC");
    expect(alpha.updated).toBe("2026-10-15T06:00:00.000Z");
  });

  it("returns null for a malformed list", () => {
    expect(parseGdacs({}, NOW)).toBeNull();
    expect(parseGdacs({ features: "x" }, NOW)).toBeNull();
  });
});

describe("near Mauritius", () => {
  it("filters by distance (or Mauritius listed as affected) and sorts nearest first", () => {
    const near = nearMauritius(parseGdacs(fixture, NOW)!);
    expect(near.map((s) => s.name)).toEqual(["Tropical Cyclone ALPHA-26", "Tropical Cyclone BRAVO"]);
    expect(near[0]!.distanceKm).toBeGreaterThan(250);
    expect(near[0]!.distanceKm).toBeLessThan(350);
    expect(near[0]!.affectsMauritius).toBe(true);
    expect(near[1]!.distanceKm).toBeLessThanOrEqual(NEAR_KM);
  });

  it("treats only Orange and Red as dangerous", () => {
    const near = nearMauritius(parseGdacs(fixture, NOW)!);
    expect(near.filter(isDangerous).map((s) => s.alertLevel)).toEqual(["Orange"]);
  });

  it("reads a GDACS name aloud without its year suffix", () => {
    expect(spokenCycloneName("Tropical Cyclone ALPHA-26")).toBe("Tropical Cyclone Alpha");
  });
});

describe("cyclone client", () => {
  let gdacs: MockServer;
  let status = 200;
  beforeAll(async () => {
    gdacs = await startMockServer((_req, res) => {
      if (status === 204) {
        res.writeHead(204);
        res.end();
      } else if (status === 200) json(res, 200, fixture);
      else json(res, status, { error: true });
    });
  });
  afterAll(() => gdacs.close());

  it("queries tropical cyclones for the last 10 days, caches 30 minutes and serves stale on error", async () => {
    const c = createCycloneClient({ url: gdacs.url + "/gdacsapi/api/events/geteventlist/SEARCH", userAgent: "ua-test", enabled: true, log: () => {} });
    const first = await c.get(NOW);
    expect(first.status).toBe("ok");
    expect(first.systems).toHaveLength(2);
    const url = new URL(gdacs.requests[0]!.url, gdacs.url);
    expect(url.searchParams.get("eventlist")).toBe("TC");
    expect(url.searchParams.get("alertlevel")).toBe("green;orange;red");
    expect(url.searchParams.get("fromDate")).toBe("2026-10-05");
    expect(gdacs.requests[0]!.headers["user-agent"]).toBe("ua-test");
    await c.get(NOW + 20 * 60_000);
    expect(gdacs.requests).toHaveLength(1);
    status = 500;
    const stale = await c.get(NOW + 40 * 60_000);
    expect(stale.status).toBe("stale");
    expect(stale.systems).toHaveLength(2);
    status = 200;
  });

  it("treats a 204 as no cyclones", async () => {
    status = 204;
    const c = createCycloneClient({ url: gdacs.url, userAgent: "ua-test", enabled: true, log: () => {} });
    expect(await c.get(NOW)).toMatchObject({ status: "ok", systems: [] });
    status = 200;
  });
});
