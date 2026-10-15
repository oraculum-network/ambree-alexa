// POST /api/agent with a mock OpenRouter: real MCP calls, caps, fallbacks, budget, logs.

import { afterEach, describe, expect, it } from "vitest";
import { OFFLINE_HINT, routeOffline } from "../src/agent/offline.ts";
import { MAX_CALLS_PER_TURN, MAX_TOOL_ROUNDS, NOTICES, systemPrompt, tidyReply } from "../src/agent/loop.ts";
import { loadPlacesIndex } from "../src/data/places.ts";
import { FIXED_NOW, FIXTURE_PLACES, SEED_PLACES, type TestApp, startTestApp } from "./helpers/app.ts";
import { rainBetween } from "./helpers/forecast.ts";
import { type MockServer, type RecordedRequest, json, startMockServer } from "./helpers/mock-server.ts";

export const CHIPS = [
  "It's raining in Grand Baie. Re-plan my afternoon.",
  "What's the weather in Flic en Flac?",
  "Find a covered market near Port Louis.",
  "Tell me about the Blue Penny Museum.",
];
const CHIP_TOOLS = ["replan_day", "weather_now", "find_places", "place_details"];
const KEY = "test-key-not-real";

let t: TestApp | undefined;
let llm: MockServer | undefined;
afterEach(async () => {
  await t?.close();
  await llm?.close();
  t = undefined;
  llm = undefined;
});

function ask(url: string, text: string, history?: unknown) {
  return fetch(`${url}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Requested-With": "ambree" },
    body: JSON.stringify({ text, history }),
  });
}

const toolCall = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (message: unknown, usage: unknown = { prompt_tokens: 1000, completion_tokens: 50 }) => ({
  id: "gen-test",
  model: "amazon/nova-2-lite-v1",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", ...(message as object) } }],
  usage,
});
const bodyOf = (r: RecordedRequest) => JSON.parse(r.body);

async function withLlm(handler: (req: RecordedRequest, n: number) => { status?: number; body: unknown }, env: Record<string, string> = {}) {
  let n = 0;
  llm = await startMockServer((req, res) => {
    const out = handler(req, n++);
    json(res, out.status ?? 200, out.body);
  });
  t = await startTestApp({
    env: { OPENROUTER_API_KEY: KEY, OPENROUTER_URL: `${llm.url}/api/v1/chat/completions`, ...env },
    feeds: { weather: rainBetween(13, 16) },
  });
  return t;
}

describe("LLM mode", () => {
  it("calls tools over MCP (seen at /mcp), returns a trace, and sends the OpenRouter contract", async () => {
    const app = await withLlm((_req, n) =>
      n === 0
        ? { body: completion({ content: null, tool_calls: [toolCall("c1", "replan_day", { area: "Grand Baie", window: "afternoon", reported_weather: "rain" })] }) }
        : { body: completion({ content: "Rain's settled over Grand Baie, so skip the beach. Try the Sugar Story Museum, about 10 minutes away." }) },
    );
    const res = await ask(app.url, "It's raining in Grand Baie. Re-plan my afternoon.");
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.mode).toBe("llm");
    expect(out.model).toBe("amazon/nova-2-lite-v1");
    expect(out.reply).toMatch(/^Rain's settled over Grand Baie/);
    expect(out.trace).toHaveLength(1);
    expect(out.trace[0]).toMatchObject({ tool: "replan_day", args: { area: "Grand Baie", window: "afternoon", reported_weather: "rain" }, ok: true });
    expect(typeof out.trace[0].ms).toBe("number");

    // The MCP endpoint itself received the tools/call.
    const mcpCalls = app.logs.filter((l) => l.route === "/mcp" && Array.isArray(l.tools) && l.tools.includes("replan_day"));
    expect(mcpCalls).toHaveLength(1);
    expect(app.logs.some((l) => l.route === "/api/agent" && l.mode === "llm")).toBe(true);

    const [first, second] = llm!.requests;
    expect(first!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(first!.headers["http-referer"]).toBe(app.url.replace("127.0.0.1", "localhost"));
    expect(first!.headers["x-title"]).toBe("Ambree for Alexa+");
    const body = bodyOf(first!);
    expect(body).toMatchObject({
      model: "amazon/nova-2-lite-v1",
      models: ["amazon/nova-2-lite-v1", "deepseek/deepseek-v4-flash"],
      tool_choice: "auto",
      max_tokens: 300,
      temperature: 0.3,
      usage: { include: true },
      provider: { data_collection: "deny" },
    });
    expect(body.tools.map((x: { function: { name: string } }) => x.function.name).sort()).toEqual(["find_places", "place_details", "replan_day", "weather_now"]);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.parameters.$schema).toBeUndefined();
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toMatch(/^You are Ambree, a Mauritius travel guide, speaking through a voice assistant\./);
    expect(body.messages[0].content).toMatch(/It is Thursday 15 October 2026, 13:30 in Mauritius\.$/);
    // The tool result went back to the model as a tool message.
    const toolMsg = bodyOf(second!).messages.find((m: { role: string }) => m.role === "tool");
    expect(JSON.parse(toolMsg.content).decision).toBe("swap");
  });

  it("holds the caps: 3 calls a round and 6 a turn, then a text-only call", async () => {
    // A greedy model: 5 tool calls every time, even when told not to call tools.
    const app = await withLlm((req, n) => ({
      body: completion({
        content: bodyOf(req).tool_choice === "none" ? "Here is what I found. Enjoy Grand Baie. And more." : null,
        tool_calls: [1, 2, 3, 4, 5].map((i) => toolCall(`r${n}c${i}`, "find_places", { area: "grand-baie", limit: 1 })),
      }),
    }));
    const out = await (await ask(app.url, "Show me everything")).json();
    expect(out.mode).toBe("llm");
    expect(out.trace.length).toBe(MAX_CALLS_PER_TURN);
    // Round 1: 3 calls (2 skipped), round 2: 3 calls (2 skipped), then the turn cap forces text.
    expect(llm!.requests.map((r) => bodyOf(r).tool_choice)).toEqual(["auto", "auto", "none"]);
    const skipped = bodyOf(llm!.requests[1]!).messages.filter((m: { content?: string }) => m.content?.startsWith("Not run"));
    expect(skipped).toHaveLength(2);
    expect(out.reply).toBe("Here is what I found. Enjoy Grand Baie.");
  });

  it(`caps tool rounds at ${MAX_TOOL_ROUNDS} even with one call a round`, async () => {
    const app = await withLlm((_req, n) => ({
      body: completion({ content: n >= 4 ? "Done." : null, tool_calls: [toolCall(`c${n}`, "weather_now", { area: "grand-baie", hours: 3 })] }),
    }));
    const out = await (await ask(app.url, "Weather again and again")).json();
    expect(out.trace).toHaveLength(4);
    expect(llm!.requests).toHaveLength(5);
    expect(bodyOf(llm!.requests[4]!).tool_choice).toBe("none");
    expect(out.reply).toBe("Done.");
  });

  it("trims the reply: no markdown, at most 2 sentences and 300 characters", async () => {
    const app = await withLlm(() => ({ body: completion({ content: "**Sure!** Visit [the market](https://ambree.ai/x). It's covered 🌧️. Third sentence here." }) }));
    const out = await (await ask(app.url, "Hello there")).json();
    expect(out.reply).toBe("Sure! Visit the market.");
    expect(tidyReply("A. B. C.")).toBe("A. B.");
    expect(tidyReply("x ".repeat(400)).length).toBeLessThanOrEqual(300);
  });

  for (const [status, notice] of [
    [402, NOTICES.credit],
    [500, NOTICES.down],
    [503, NOTICES.down],
  ] as const) {
    it(`falls back to offline with a notice on OpenRouter ${status}`, async () => {
      const app = await withLlm(() => ({ status, body: { error: { message: "nope" } } }));
      const out = await (await ask(app.url, CHIPS[0]!)).json();
      expect(out.mode).toBe("offline");
      expect(out.notice).toBe(notice);
      expect(out.trace.map((x: { tool: string }) => x.tool)).toEqual(["replan_day"]);
      expect(out.reply).toMatch(/Grand Baie/);
    });
  }

  it("falls back to offline when OpenRouter can't be reached", async () => {
    t = await startTestApp({ env: { OPENROUTER_API_KEY: KEY, OPENROUTER_URL: "http://127.0.0.1:9/api/v1/chat/completions" } });
    const out = await (await ask(t.url, CHIPS[3]!)).json();
    expect(out).toMatchObject({ mode: "offline", notice: NOTICES.down });
  });

  it("switches to offline at the daily turn cap", async () => {
    const app = await withLlm(() => ({ body: completion({ content: "Fine." }) }), { AGENT_DAILY_TURNS: "1" });
    expect((await (await ask(app.url, "one")).json()).mode).toBe("llm");
    const second = await (await ask(app.url, CHIPS[1]!)).json();
    expect(second).toMatchObject({ mode: "offline", notice: "Today's AI budget is used up, so I'm answering in offline mode." });
    expect(llm!.requests).toHaveLength(1);
  });

  it("switches to offline at the daily USD cap (usage.cost, else a token estimate)", async () => {
    const app = await withLlm(() => ({ body: completion({ content: "Fine." }, { prompt_tokens: 10, completion_tokens: 10, cost: 0.02 }) }), { AGENT_DAILY_USD: "0.03" });
    expect((await (await ask(app.url, "one")).json()).mode).toBe("llm");
    expect((await (await ask(app.url, "two")).json()).mode).toBe("llm");
    expect(app.app.budget.snapshot().usd).toBeCloseTo(0.04);
    expect((await (await ask(app.url, "three")).json()).notice).toBe(NOTICES.budget);
    await app.close();
    await llm!.close();

    // No usage.cost: 1M input tokens at 0.30 USD per million.
    const app2 = await withLlm(() => ({ body: completion({ content: "Fine." }, { prompt_tokens: 1_000_000, completion_tokens: 0 }) }), { AGENT_DAILY_USD: "0.25" });
    expect((await (await ask(app2.url, "one")).json()).mode).toBe("llm");
    expect(app2.app.budget.snapshot().usd).toBeCloseTo(0.3);
    expect((await (await ask(app2.url, "two")).json()).mode).toBe("offline");
  });

  it("sends the history and never logs the user's text, the reply or the key", async () => {
    const secretText = "my secret honeymoon plan zebra-42";
    const app = await withLlm(() => ({ body: completion({ content: "A reply mentioning quokka-77." }) }));
    const out = await (await ask(app.url, secretText, [{ role: "user", text: "earlier question" }, { role: "assistant", text: "earlier answer" }])).json();
    expect(out.reply).toMatch(/quokka-77/);
    const msgs = bodyOf(llm!.requests[0]!).messages.map((m: { role: string; content: string }) => [m.role, m.content]);
    expect(msgs.slice(1)).toEqual([["user", "earlier question"], ["assistant", "earlier answer"], ["user", secretText]]);
    const logText = JSON.stringify(app.logs);
    expect(app.logs.length).toBeGreaterThan(0);
    expect(logText).not.toContain("zebra-42");
    expect(logText).not.toContain("honeymoon");
    expect(logText).not.toContain("quokka-77");
    expect(logText).not.toContain(KEY);
    expect(logText).not.toContain("127.0.0.1");
  });
});

describe("offline mode", () => {
  it("is used when no key is configured, without a notice", async () => {
    t = await startTestApp({ feeds: { weather: rainBetween(13, 16) } });
    const out = await (await ask(t.url, CHIPS[0]!)).json();
    expect(out.mode).toBe("offline");
    expect(out.notice).toBeUndefined();
    expect(out.model).toBeUndefined();
    expect(out.trace).toHaveLength(1);
    expect(out.reply).toMatch(/^Rain's settled over Grand Baie until about four, so head somewhere covered\. Try /);
    expect(t.logs.some((l) => l.route === "/mcp" && Array.isArray(l.tools) && l.tools.includes("replan_day"))).toBe(true);
  });

  it("answers an unknown intent with a 2-sentence hint", async () => {
    t = await startTestApp();
    const out = await (await ask(t.url, "Sing me a song")).json();
    expect(out.reply).toBe(OFFLINE_HINT);
    expect(out.trace).toEqual([]);
  });

  for (const [label, file] of [
    ["the fixture", FIXTURE_PLACES],
    ["the seed", SEED_PLACES],
  ] as const) {
    it(`routes each suggestion chip to a non-error tool result with ${label} data`, async () => {
      const places = loadPlacesIndex(file);
      CHIPS.forEach((chip, i) => expect(routeOffline(chip, places)?.tool, chip).toBe(CHIP_TOOLS[i]));
      t = await startTestApp({ env: { PLACES_FILE: file }, feeds: { weather: rainBetween(14, 16) } });
      for (const [i, chip] of CHIPS.entries()) {
        const out = await (await ask(t.url, chip)).json();
        expect(out.trace, chip).toHaveLength(1);
        expect(out.trace[0], chip).toMatchObject({ tool: CHIP_TOOLS[i], ok: true });
        expect(out.reply, chip).not.toBe(OFFLINE_HINT);
      }
      await t.close();
      t = undefined;
    });
  }

  it("routes the chips with the right arguments", () => {
    const places = loadPlacesIndex(FIXTURE_PLACES);
    expect(routeOffline(CHIPS[0]!, places)).toEqual({ tool: "replan_day", args: { area: "grand-baie", window: "afternoon", reported_weather: "rain" } });
    expect(routeOffline(CHIPS[1]!, places)).toEqual({ tool: "weather_now", args: { area: "flic-en-flac" } });
    expect(routeOffline(CHIPS[2]!, places)).toEqual({ tool: "find_places", args: { area: "port-louis", kind: "market", rain_ok: true } });
    expect(routeOffline(CHIPS[3]!, places)).toEqual({ tool: "place_details", args: { place: "Blue Penny Museum" } });
    expect(routeOffline("Is it raining in Mahebourg?", places)?.tool).toBe("weather_now");
    expect(routeOffline("Any museums near Mahébourg?", places)).toEqual({ tool: "find_places", args: { area: "mahebourg", kind: "museum" } });
  });
});

describe("request checks", () => {
  it("validates the body", async () => {
    t = await startTestApp();
    expect((await ask(t.url, "")).status).toBe(400);
    expect((await ask(t.url, "x".repeat(301))).status).toBe(400);
    expect((await ask(t.url, "ok", Array.from({ length: 7 }, () => ({ role: "user", text: "x" })))).status).toBe(400);
    const res = await fetch(`${t.url}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ambree" }, body: "{oops" });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toMatch(/at .*\.ts|stack|SyntaxError/);
  });

  it("puts the Mauritius date and time in the system prompt", () => {
    expect(systemPrompt(FIXED_NOW)).toContain("It is Thursday 15 October 2026, 13:30 in Mauritius.");
  });
});
