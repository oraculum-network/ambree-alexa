// SDK conformance: the official SDK client against our /mcp over Streamable HTTP.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTRUCTIONS, SERVER_NAME, SERVER_TITLE } from "../src/mcp/server.ts";
import { VERSION } from "../src/meta.ts";
import { sentences } from "../src/tools/speech.ts";
import { findPlacesOutput } from "../src/tools/find-places.ts";
import { placeDetailsOutput } from "../src/tools/place-details.ts";
import { replanDayOutput } from "../src/tools/replan-day.ts";
import { weatherNowOutput } from "../src/tools/weather-now.ts";
import { type TestApp, connectClient, startTestApp } from "./helpers/app.ts";
import { rainBetween } from "./helpers/forecast.ts";

let t: TestApp;
let client: Client;

beforeAll(async () => {
  t = await startTestApp({ env: { RATE_LIMIT_SCALE: "10" }, feeds: { weather: rainBetween(13, 15) } });
  client = await connectClient(t.url);
});
afterAll(async () => {
  await client.close();
  await t.close();
});

describe("initialize", () => {
  it("negotiates exactly 2025-11-25 (the SDK's latest)", () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    const transport = client.transport as unknown as { protocolVersion?: string };
    expect(transport.protocolVersion).toBe("2025-11-25");
  });

  it("serves serverInfo with title, description, websiteUrl and icons, plus instructions", () => {
    const info = client.getServerVersion()!;
    expect(info.name).toBe(SERVER_NAME);
    expect(info.title).toBe(SERVER_TITLE);
    expect(info.version).toBe(VERSION);
    expect(info.websiteUrl).toBe("https://alexa.ambree.ai");
    expect(info.description).toMatch(/Mauritius/);
    expect(info.icons?.length).toBe(2);
    expect(info.icons?.[0]?.src).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(info.icons?.map((i) => i.theme)).toEqual(["light", "dark"]);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(client.getInstructions()).toMatch(/speech/);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });
});

describe("tools/list", () => {
  it("lists 4 tools with titles, annotations, input and output schemas and icons", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual(["find_places", "place_details", "replan_day", "weather_now"]);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.title).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.outputSchema?.properties).toHaveProperty("speech");
      // 2025-11-25 makes JSON Schema 2020-12 the default dialect (SEP-1613). The SDK alone
      // would list draft-07; our tools/list wrapper lists 2020-12 from the same zod schemas.
      expect(tool.inputSchema.$schema).toMatch(/\/draft\/2020-12\/schema$/);
      expect(tool.outputSchema?.$schema).toMatch(/\/draft\/2020-12\/schema$/);
      expect(tool.outputSchema?.additionalProperties).toBe(false);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
      expect(tool.annotations?.openWorldHint).toBe(tool.name === "weather_now" || tool.name === "replan_day");
      expect(tool.icons?.length).toBe(2);
      expect(tool.icons?.[0]?.mimeType).toBe("image/svg+xml");
    }
  });
});

describe("2020-12 schemas and the SDK client's validator", () => {
  it("Ajv in the SDK client compiles every listed output schema and validates structuredContent with it", async () => {
    const { tools } = await client.listTools();
    const ajv = new AjvJsonSchemaValidator();
    const res = (await client.callTool({ name: "place_details", arguments: { place: "Blue Penny Museum" } })) as CallToolResult;
    for (const tool of tools) expect(() => ajv.getValidator(tool.outputSchema!), tool.name).not.toThrow();
    const validate = ajv.getValidator(tools.find((x) => x.name === "place_details")!.outputSchema!);
    expect(validate(res.structuredContent).valid).toBe(true);
    const { speech: _dropped, ...broken } = res.structuredContent as { speech: string };
    expect(validate(broken).valid).toBe(false);
    expect(validate({ ...res.structuredContent, extra: 1 }).valid).toBe(false);
  });

  it("the input schemas keep defaults optional and describe each field", async () => {
    const { tools } = await client.listTools();
    const find = tools.find((x) => x.name === "find_places")!;
    expect(find.inputSchema.required ?? []).not.toContain("limit");
    expect((find.inputSchema.properties as Record<string, { description?: string }>).area?.description).toMatch(/Fuzzy/);
    const replan = tools.find((x) => x.name === "replan_day")!;
    expect(replan.inputSchema.required).toEqual(["area"]);
  });
});

describe("tools/call", () => {
  const cases: Array<[string, Record<string, unknown>, { parse: (v: unknown) => unknown }]> = [
    ["find_places", { area: "Grand Baie", rain_ok: true }, findPlacesOutput],
    ["place_details", { place: "Blue Penny Museum" }, placeDetailsOutput],
    ["weather_now", { area: "Flic en Flac", hours: 6 }, weatherNowOutput],
    ["replan_day", { area: "grand-baie", window: "afternoon", plan: "beach" }, replanDayOutput],
  ];

  for (const [name, args, schema] of cases) {
    it(`${name} returns structuredContent that validates, a matching text block, and short speech`, async () => {
      const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
      expect(res.isError).toBeFalsy();
      expect(() => schema.parse(res.structuredContent)).not.toThrow();
      const text = res.content.find((c) => c.type === "text");
      expect(text && "text" in text && JSON.parse(text.text)).toEqual(res.structuredContent);
      const speech = (res.structuredContent as { speech: string }).speech;
      expect(speech.length).toBeGreaterThan(10);
      expect(speech.length).toBeLessThanOrEqual(280);
      expect(sentences(speech).length).toBeLessThanOrEqual(2);
      expect(speech).not.toMatch(/https?:|www\.|[*_#`]|\p{Extended_Pictographic}/u);
    });
  }

  it("replan_day swaps the beach when the forecast is wet", async () => {
    const res = (await client.callTool({ name: "replan_day", arguments: { area: "Grand Baie", window: "afternoon", plan: "beach" } })) as CallToolResult;
    const out = replanDayOutput.parse(res.structuredContent);
    expect(out.decision).toBe("swap");
    expect(out.weather.basis).toBe("forecast");
    expect(out.options.every((o) => o.rain_ok)).toBe(true);
  });
});
