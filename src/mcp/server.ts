// Builds the MCP server: serverInfo, instructions and the 4 read-only tools.
// A new instance per request (stateless Streamable HTTP); building one is cheap.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { VERSION, SITE_URL } from "../meta.ts";
import type { ToolDeps, ToolOutcome } from "../tools/context.ts";
import { findPlaces, findPlacesInput, findPlacesOutput } from "../tools/find-places.ts";
import { placeDetails, placeDetailsInput, placeDetailsOutput } from "../tools/place-details.ts";
import { replanDay, replanDayInput, replanDayOutput } from "../tools/replan-day.ts";
import { weatherNow, weatherNowInput, weatherNowOutput } from "../tools/weather-now.ts";
import { type Icon, SERVER_ICONS, TOOL_ICONS } from "./icons.ts";

export const SERVER_NAME = "ambree-mauritius";
export const SERVER_TITLE = "Ambree: Mauritius travel tools";
export const SERVER_DESCRIPTION =
  "Hyper-local Mauritius travel tools from Ambree: verified places, the live forecast and cyclone alerts, and weather-aware re-planning, with every answer written to be spoken.";

export const INSTRUCTIONS =
  "Ambree's tools help travellers in Mauritius. Use find_places and place_details to look up places, weather_now for the live forecast and cyclone alerts, and replan_day whenever the weather changes someone's plans. " +
  "Every result has a speech field: plain text of at most 2 sentences, written to be read aloud as it is. " +
  "Places come only from Ambree's verified dataset, so recommend only places these tools return.";

export const TOOL_NAMES = ["find_places", "place_details", "weather_now", "replan_day"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const TOOL_SCHEMAS: Record<ToolName, { input: z.ZodType; output: z.ZodType }> = {
  find_places: { input: findPlacesInput, output: findPlacesOutput },
  place_details: { input: placeDetailsInput, output: placeDetailsOutput },
  weather_now: { input: weatherNowInput, output: weatherNowOutput },
  replan_day: { input: replanDayInput, output: replanDayOutput },
};

/**
 * The schemas we list, as JSON Schema 2020-12 (the 2025-11-25 default dialect, SEP-1613),
 * generated once from the same zod schemas the SDK validates with. The SDK itself would
 * list draft-07.
 */
export const LISTED_SCHEMAS: Record<ToolName, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }> = Object.fromEntries(
  TOOL_NAMES.map((name) => [
    name,
    {
      inputSchema: z.toJSONSchema(TOOL_SCHEMAS[name].input, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(TOOL_SCHEMAS[name].output, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>,
    },
  ]),
) as Record<ToolName, { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }>;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

function toResult<T extends Record<string, unknown>>(outcome: ToolOutcome<T>): CallToolResult {
  if (!outcome.ok) return { content: [{ type: "text", text: outcome.message }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], structuredContent: outcome.value };
}

export function buildMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: VERSION,
      description: SERVER_DESCRIPTION,
      websiteUrl: SITE_URL,
      icons: SERVER_ICONS,
    },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "find_places",
    {
      title: "Find places",
      description:
        "Find places to go in Mauritius from Ambree's verified dataset. Filter by area (a name or id such as 'Grand Baie'), kind (museum, market, beach and so on), rain_ok (true for indoor or covered places) and a short free-text query. " +
        "With an area, places in that area come first, then places within 25 km, nearest first. Read the speech field aloud.",
      inputSchema: findPlacesInput,
      outputSchema: findPlacesOutput,
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async (args) => toResult(findPlaces(args, deps)),
  );

  server.registerTool(
    "place_details",
    {
      title: "Place details",
      description:
        "Get the full verified record for one place in Mauritius by id or name (fuzzy, accents optional): what it is, how long to allow, whether it works in the rain, its source and when it was checked. Read the speech field aloud.",
      inputSchema: placeDetailsInput,
      outputSchema: placeDetailsOutput,
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    async (args) => toResult(placeDetails(args, deps)),
  );

  server.registerTool(
    "weather_now",
    {
      title: "Weather now",
      description:
        "The live hourly forecast for an area of Mauritius (MET Norway), with when rain is likely and any tropical cyclone alerts near the island (GDACS). Use it when the traveller asks about the weather. " +
        "If the feed can't be reached, status is 'unavailable' and the speech says so.",
      inputSchema: weatherNowInput,
      outputSchema: weatherNowOutput,
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async (args) => toResult(await weatherNow(args, deps)),
  );

  server.registerTool(
    "replan_day",
    {
      title: "Re-plan the day",
      description:
        "Re-plan part of a day in Mauritius when the weather changes. Give the area, the time window and what the traveller reports (rain, dry, wind or heat), plus their plan if known. " +
        "It checks the live forecast and cyclone alerts, then keeps the plan, swaps it for nearby covered places with approximate travel times, or says to stay safe. Prefer this tool whenever weather affects plans.",
      inputSchema: replanDayInput,
      outputSchema: replanDayOutput,
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async (args) => toResult(await replanDay(args, deps)),
  );

  patchToolHandlers(server, TOOL_ICONS);
  return server;
}

/**
 * A JSON-RPC error whose message is exactly `message`: the SDK sends `code` and `message`
 * as they are, while McpError would prefix "MCP error <code>: " to the message.
 */
function protocolError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(data !== undefined ? { data } : {}) });
}

/**
 * Errors from the SDK's tools/call path, made readable: a request that fails the SDK's
 * own request schema (a bare ZodError, which would go out as -32603 with an issue dump)
 * becomes -32602, and an McpError loses its "MCP error <code>: " prefix.
 */
function cleanProtocolError(e: unknown): unknown {
  const issues = (e as { issues?: unknown })?.issues;
  if (Array.isArray(issues)) {
    const detail = issues
      .slice(0, 3)
      .map((i: { path?: unknown[]; message?: string }) => `${(i.path ?? []).join(".") || "request"}: ${i.message ?? "invalid"}`)
      .join("; ");
    return protocolError(ErrorCode.InvalidParams, `Invalid tools/call request: ${detail}`);
  }
  if (!(e instanceof Error) || !Number.isSafeInteger((e as { code?: unknown }).code)) return e;
  const code = (e as unknown as { code: number }).code;
  return protocolError(code, e.message.replace(/^MCP error -?\d+: /, ""), (e as { data?: unknown }).data);
}

type RawRequest = { method: string; params?: Record<string, unknown> };
type RawHandler = (request: RawRequest, extra: unknown) => Promise<unknown>;

/**
 * Gaps in SDK 1.32.1's McpServer, closed by wrapping its own handlers:
 *  - tools/list drops `icons` (the 2025-11-25 Tool field), so we add them, and lists
 *    draft-07 schemas, so we list our 2020-12 ones (validation stays the SDK's);
 *  - tools/call turns an unknown tool name into an `isError` result, but the spec
 *    makes it a protocol error, so we answer -32602 first. Input that fails a schema
 *    stays an `isError` result (SEP-1303), with the SDK's message tidied for the reader;
 *  - protocol error messages lose the duplicated "MCP error <code>: " prefix.
 * The SDK keeps handlers in a private map; if that ever moves, fail at startup.
 */
function patchToolHandlers(server: McpServer, icons: Record<string, Icon[]>): void {
  const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
  if (!(handlers instanceof Map) || !handlers.has("tools/list") || !handlers.has("tools/call")) {
    throw new Error("Unsupported MCP SDK: the tool request handlers were not found");
  }
  const list = handlers.get("tools/list") as RawHandler;
  const call = handlers.get("tools/call") as RawHandler;
  const known = new Set<string>(TOOL_NAMES);

  handlers.set("tools/list", async (request: RawRequest, extra: unknown) => {
    const result = (await list(request, extra)) as { tools: Array<{ name: string }> };
    return {
      ...result,
      tools: result.tools.map((t) => {
        const listed = known.has(t.name) ? LISTED_SCHEMAS[t.name as ToolName] : undefined;
        return { ...t, ...listed, ...(icons[t.name] ? { icons: icons[t.name] } : {}) };
      }),
    };
  });

  handlers.set("tools/call", async (request: RawRequest, extra: unknown) => {
    const name = request.params?.name;
    if (typeof name !== "string") {
      throw protocolError(ErrorCode.InvalidParams, `Invalid tool name: expected a string. Available tools: ${TOOL_NAMES.join(", ")}`);
    }
    if (!known.has(name)) {
      throw protocolError(ErrorCode.InvalidParams, `Unknown tool: ${name.slice(0, 64)}. Available tools: ${TOOL_NAMES.join(", ")}`);
    }
    let result: CallToolResult;
    try {
      result = (await call(request, extra)) as CallToolResult;
    } catch (e) {
      throw cleanProtocolError(e);
    }
    if (result.isError && result.content[0]?.type === "text") {
      const text = result.content[0].text
        .replace(/^MCP error -?\d+: /, "")
        .replace(/^Input validation error: Invalid arguments for tool (\w+): /, "Invalid arguments for $1: ");
      return { ...result, content: [{ type: "text", text }, ...result.content.slice(1)] };
    }
    return result;
  });
}
