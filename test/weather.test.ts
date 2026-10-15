// The MET Norway client: parsing, Expires caching, 304, stale-if-error, back-off, 203, UA.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WEATHER_BACKOFF_MS, WEATHER_STALE_MAX_MS, createWeatherClient, parseLocationforecast } from "../src/feeds/weather.ts";
import type { LogRecord } from "../src/log.ts";
import { type MockServer, startMockServer } from "./helpers/mock-server.ts";

const fixture = readFileSync(new URL("./fixtures/met-complete.json", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 9, 15, 9, 10);
const MIN = 60_000;
const UA = "ambree-alexa/test (+https://alexa.ambree.ai)";

describe("parseLocationforecast", () => {
  it("keeps hourly steps, range-checks values and reads updated_at", () => {
    const parsed = parseLocationforecast(JSON.parse(fixture))!;
    expect(parsed.updatedAt).toBe("2026-10-15T08:41:12Z");
    expect(parsed.steps).toHaveLength(6);
    expect(parsed.steps[0]).toEqual({ time: Date.UTC(2026, 9, 15, 9), tempC: 25.4, precipMm: 0, precipProb: 8, windMs: 5.2, symbol: "partlycloudy_day" });
    expect(parsed.steps[2]).toMatchObject({ precipMm: 2.4, precipProb: 90, windMs: 11.3, symbol: "heavyrainshowers_day" });
    expect(parsed.steps[4]!.precipProb).toBeNull();
    // Out-of-range or wrong-typed values become null rather than poisoning the summary.
    expect(parsed.steps[5]).toMatchObject({ tempC: null, windMs: null, precipMm: null, symbol: null });
  });

  it("rejects malformed shapes", () => {
    expect(parseLocationforecast(null)).toBeNull();
    expect(parseLocationforecast({ properties: {} })).toBeNull();
    expect(parseLocationforecast({ properties: { timeseries: "x" } })).toBeNull();
  });
});

describe("weather client", () => {
  let met: MockServer;
  let logs: LogRecord[];
  let script: { status: number; headers?: Record<string, string>; body?: string };

  beforeAll(async () => {
    met = await startMockServer((_req, res) => {
      res.writeHead(script.status, { "Content-Type": "application/json", ...script.headers });
      res.end(script.status === 304 ? undefined : script.body ?? fixture);
    });
  });
  afterAll(() => met.close());
  beforeEach(() => {
    met.requests.length = 0;
    logs = [];
    script = {
      status: 200,
      headers: { Expires: new Date(NOW + 30 * MIN).toUTCString(), "Last-Modified": "Thu, 15 Oct 2026 08:45:00 GMT" },
    };
  });

  const client = () =>
    createWeatherClient({ url: `${met.url}/weatherapi/locationforecast/2.0/complete`, userAgent: UA, enabled: true, log: (r) => logs.push(r) });

  it("sends the User-Agent and 2-decimal coordinates", async () => {
    const r = await client().get(-20.0134, 57.5801, NOW);
    expect(r.status).toBe("ok");
    expect(met.requests).toHaveLength(1);
    const req = met.requests[0]!;
    expect(req.headers["user-agent"]).toBe(UA);
    expect(req.url).toBe("/weatherapi/locationforecast/2.0/complete?lat=-20.01&lon=57.58");
    expect(req.headers["if-modified-since"]).toBeUndefined();
  });

  it("caches until Expires, then revalidates with If-Modified-Since and handles 304", async () => {
    const c = client();
    const first = await c.get(-20.01, 57.58, NOW);
    expect(first.fetchedAt).toBe(NOW);
    await c.get(-20.01, 57.58, NOW + 29 * MIN);
    expect(met.requests).toHaveLength(1);

    script = { status: 304, headers: { Expires: new Date(NOW + 90 * MIN).toUTCString() } };
    const revalidated = await c.get(-20.01, 57.58, NOW + 31 * MIN);
    expect(met.requests).toHaveLength(2);
    expect(met.requests[1]!.headers["if-modified-since"]).toBe("Thu, 15 Oct 2026 08:45:00 GMT");
    expect(revalidated.status).toBe("ok");
    expect(revalidated.steps).toEqual(first.steps);
    expect(revalidated.fetchedAt).toBe(NOW + 31 * MIN);
    // The 304's Expires moved the horizon.
    await c.get(-20.01, 57.58, NOW + 80 * MIN);
    expect(met.requests).toHaveLength(2);
  });

  it("serves a stale copy when a refresh fails, for up to 12 hours", async () => {
    const c = client();
    const first = await c.get(-20.01, 57.58, NOW);
    script = { status: 500 };
    const stale = await c.get(-20.01, 57.58, NOW + 60 * MIN);
    expect(stale.status).toBe("stale");
    expect(stale.steps).toEqual(first.steps);
    expect(logs.some((l) => l.feed === "met" && l.event === "unavailable" && l.reason === "http")).toBe(true);
    const tooOld = await c.get(-20.01, 57.58, NOW + WEATHER_STALE_MAX_MS + 10 * MIN);
    expect(tooOld.status).toBe("unavailable");
  });

  it("backs off for 5 minutes after a failure", async () => {
    const c = client();
    script = { status: 503 };
    expect((await c.get(-20.01, 57.58, NOW)).status).toBe("unavailable");
    expect((await c.get(-20.01, 57.58, NOW + 2 * MIN)).status).toBe("unavailable");
    expect(met.requests).toHaveLength(1);
    script = { status: 200, headers: { Expires: new Date(NOW + 60 * MIN).toUTCString() } };
    expect((await c.get(-20.01, 57.58, NOW + WEATHER_BACKOFF_MS + 1)).status).toBe("ok");
    expect(met.requests).toHaveLength(2);
  });

  it("treats malformed JSON and a body over 1 MB as unavailable", async () => {
    script = { status: 200, body: "{nope" };
    expect((await client().get(-20.01, 57.58, NOW)).reason).toBe("malformed");
    script = { status: 200, body: JSON.stringify({ properties: { timeseries: [] }, pad: "x".repeat(1024 * 1024 + 10) }) };
    expect((await client().get(-20.01, 57.58, NOW)).reason).toBe("malformed");
  });

  it("logs a 203 (deprecated product) once", async () => {
    const c = client();
    script = { status: 203, headers: { Expires: new Date(NOW + MIN).toUTCString() } };
    expect((await c.get(-20.01, 57.58, NOW)).status).toBe("ok");
    expect((await c.get(-20.01, 57.58, NOW + 2 * MIN)).status).toBe("ok");
    expect(met.requests).toHaveLength(2);
    expect(logs.filter((l) => l.event === "deprecated")).toHaveLength(1);
  });

  it("times out (4 s by default, 50 ms here)", async () => {
    met.setHandler(() => new Promise(() => {}));
    const c = createWeatherClient({ url: met.url, userAgent: UA, enabled: true, log: () => {}, timeoutMs: 50 });
    expect((await c.get(-20.01, 57.58, NOW)).reason).toBe("timeout");
    met.setHandler((_req, res) => {
      res.writeHead(script.status, { "Content-Type": "application/json", ...script.headers });
      res.end(script.status === 304 ? undefined : script.body ?? fixture);
    });
  });

  it("is off when feeds are disabled", async () => {
    const c = createWeatherClient({ url: met.url, userAgent: UA, enabled: false, log: () => {} });
    expect(await c.get(-20.01, 57.58, NOW)).toMatchObject({ status: "unavailable", reason: "disabled" });
    expect(met.requests).toHaveLength(0);
  });
});
