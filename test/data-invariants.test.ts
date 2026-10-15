// Invariants on the shipped dataset (data/places.json). They must hold for whatever
// dataset is there: the seed today, the researched one later.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DatasetSchema, parseDataset } from "../src/data/places.ts";
import { haversineKm } from "../src/geo.ts";
import { SEED_PLACES } from "./helpers/app.ts";

const raw = JSON.parse(readFileSync(SEED_PLACES, "utf8"));

describe("data/places.json", () => {
  it("validates against the schema (and the loader's cross-checks)", () => {
    const parsed = DatasetSchema.safeParse(raw);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 5))).toBe(true);
    expect(() => parseDataset(raw)).not.toThrow();
  });

  const data = parseDataset(raw);

  it("has unique area and place ids", () => {
    expect(new Set(data.areas.map((a) => a.id)).size).toBe(data.areas.length);
    expect(new Set(data.places.map((p) => p.id)).size).toBe(data.places.length);
  });

  it("cites an https source for every place", () => {
    for (const p of data.places) expect(new URL(p.source).protocol, p.id).toBe("https:");
  });

  it("has an ISO date in every verified_at", () => {
    for (const p of data.places) {
      expect(p.verified_at, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(p.verified_at + "T00:00:00Z").toISOString().slice(0, 10), p.id).toBe(p.verified_at);
    }
  });

  it("gives every area at least 1 rain_ok place within 35 km of its centre", () => {
    for (const a of data.areas) {
      const covered = data.places.filter((p) => p.rain_ok && haversineKm(a.lat, a.lon, p.lat, p.lon) <= 35);
      expect(covered.length, a.id).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps speech within 140 characters and blurbs within 200", () => {
    for (const p of data.places) {
      expect(p.speech.length, p.id).toBeLessThanOrEqual(140);
      expect(p.blurb.length, p.id).toBeLessThanOrEqual(200);
    }
  });
});
