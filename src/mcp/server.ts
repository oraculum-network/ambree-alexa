// Builds the MCP server: serverInfo, instructions and the 4 read-only tools.
// A new instance per request (stateless Streamable HTTP); building one is cheap.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
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

type RawRequest = { method: string; params?: Record<string, unknown> };
type RawHandler = (request: RawRequest, extra: unknown) => Promise<unknown>;

/**
 * Two gaps in SDK 1.32.1's McpServer, closed by wrapping its own handlers:
 *  - tools/list drops `icons` (the 2025-11-25 Tool field), so we add them;
 *  - tools/call turns an unknown tool name into an `isError` result, but the spec
 *    makes it a protocol error, so we answer -32602 first. Input that fails a schema
 *    stays an `isError` result (SEP-1303), with the SDK's message tidied for the reader.
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
    return { ...result, tools: result.tools.map((t) => (icons[t.name] ? { ...t, icons: icons[t.name] } : t)) };
  });

  handlers.set("tools/call", async (request: RawRequest, extra: unknown) => {
    const name = request.params?.name;
    if (typeof name !== "string" || !known.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${String(name).slice(0, 64)}. Available tools: ${TOOL_NAMES.join(", ")}`);
    }
    const result = (await call(request, extra)) as CallToolResult;
    if (result.isError && result.content[0]?.type === "text") {
      const text = result.content[0].text
        .replace(/^MCP error -?\d+: /, "")
        .replace(/^Input validation error: Invalid arguments for tool (\w+): /, "Invalid arguments for $1: ");
      return { ...result, content: [{ type: "text", text }, ...result.content.slice(1)] };
    }
    return result;
  });
}
