// Speech helpers and config parsing.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { capSpeech, clockWord, fitSpeech, plainText, spokenDuration, spokenTime } from "../src/tools/speech.ts";
import { isoMu, muParts } from "../src/time.ts";

describe("speech", () => {
  it("strips markdown, URLs and emoji", () => {
    expect(plainText("## Hi **there** — see [this](https://ambree.ai/x) 🌴 https://ambree.ai/y")).toBe("Hi there — see this");
    expect(plainText("- one\n- two")).toBe("one two");
  });

  it("caps at 2 sentences and 280 characters", () => {
    expect(capSpeech("One. Two! Three?")).toBe("One. Two!");
    const long = capSpeech("word ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(280);
    expect(long.endsWith(".")).toBe(true);
    expect(fitSpeech("x ".repeat(200), "Short one.")).toBe("Short one.");
  });

  it("says times and durations the way people do", () => {
    expect(clockWord(15)).toBe("three");
    expect(clockWord(12)).toBe("noon");
    expect(spokenTime(15)).toBe("three in the afternoon");
    expect(spokenTime(9)).toBe("nine in the morning");
    expect(spokenTime(20)).toBe("eight in the evening");
    expect(spokenDuration(20)).toBe("about 20 minutes");
    expect(spokenDuration(60)).toBe("about an hour");
    expect(spokenDuration(90)).toBe("about an hour and a half");
    expect(spokenDuration(240)).toBe("about 4 hours");
  });
});

describe("Mauritius time", () => {
  it("is UTC+4 all year", () => {
    expect(muParts(Date.UTC(2026, 0, 1, 20, 30))).toMatchObject({ date: "2026-01-02", hour: 0, minute: 30, weekday: "Friday" });
    expect(muParts(Date.UTC(2026, 6, 1, 8))).toMatchObject({ hour: 12 });
    expect(isoMu(Date.UTC(2026, 9, 15, 10))).toBe("2026-10-15T14:00:00+04:00");
  });
});

describe("config", () => {
  it("has sensible defaults and treats empty values as unset", () => {
    const c = loadConfig({ OPENROUTER_API_KEY: "", PORT: "" });
    expect(c).toMatchObject({
      port: 8080,
      openrouterKey: undefined,
      model: "amazon/nova-2-lite-v1",
      fallbackModels: ["deepseek/deepseek-v4-flash"],
      dailyUsd: 0.5,
      dailyTurns: 300,
      priceInPerM: 0.3,
      priceOutPerM: 2.5,
      feedsEnabled: true,
      trustProxyHops: 0,
    });
    expect(c.weatherUserAgent).toMatch(/^ambree-alexa\/\d+\.\d+\.\d+ \(\+https:\/\/alexa\.ambree\.ai\)$/);
    expect(c.metUrl).toBe("https://api.met.no/weatherapi/locationforecast/2.0/complete");
  });

  it("fails clearly on bad values", () => {
    expect(() => loadConfig({ PORT: "eighty" })).toThrow(/PORT/);
    expect(() => loadConfig({ PUBLIC_ORIGIN: "https://alexa.ambree.ai/app" })).toThrow(/origin/);
    expect(() => loadConfig({ FEEDS: "maybe" })).toThrow(/FEEDS/);
    expect(loadConfig({ AGENT_FALLBACK_MODELS: "none" }).fallbackModels).toEqual([]);
  });
});
