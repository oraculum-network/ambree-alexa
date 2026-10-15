// Start the app in-process on port 0, with mock MET and GDACS feeds and captured logs.

import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type App, createApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";
import type { LogRecord } from "../../src/log.ts";
import { type HourSpec, type GdacsSpec, makeForecast, makeGdacs } from "./forecast.ts";
import { type MockServer, json, startMockServer } from "./mock-server.ts";

export const FIXTURE_PLACES = fileURLToPath(new URL("../fixtures/places.json", import.meta.url));
export const SEED_PLACES = fileURLToPath(new URL("../../data/places.json", import.meta.url));

/** 2026-10-15 09:30 UTC = 13:30 in Mauritius (a Thursday afternoon). */
export const FIXED_NOW = Date.UTC(2026, 9, 15, 9, 30);
const HOUR = 3600_000;

export interface FeedScript {
  weather?: (muHour: number, time: number) => HourSpec;
  cyclones?: GdacsSpec[];
}

export interface TestApp {
  app: App;
  url: string;
  logs: LogRecord[];
  met: MockServer;
  gdacs: MockServer;
  close(): Promise<void>;
}

export async function startTestApp(opts: { env?: Record<string, string>; now?: () => number; feeds?: FeedScript } = {}): Promise<TestApp> {
  const now = opts.now ?? (() => FIXED_NOW);
  const feeds = opts.feeds ?? {};
  const met = await startMockServer((_req, res) => {
    const start = Math.floor(now() / HOUR) * HOUR - HOUR;
    json(res, 200, makeForecast(start, 60, feeds.weather), {
      Expires: new Date(now() + 30 * 60_000).toUTCString(),
      "Last-Modified": new Date(now() - 10 * 60_000).toUTCString(),
    });
  });
  const gdacs = await startMockServer((_req, res) => json(res, 200, makeGdacs(feeds.cyclones ?? [])));
  const logs: LogRecord[] = [];
  const config = loadConfig({
    PORT: "0",
    HOST: "127.0.0.1",
    PLACES_FILE: FIXTURE_PLACES,
    MET_URL: `${met.url}/weatherapi/locationforecast/2.0/complete`,
    GDACS_URL: `${gdacs.url}/gdacsapi/api/events/geteventlist/SEARCH`,
    ...opts.env,
  });
  const app = createApp({ config, logger: (r) => logs.push(r), now });
  await app.listen();
  return {
    app,
    url: app.url(),
    logs,
    met,
    gdacs,
    async close() {
      await app.close();
      await met.close();
      await gdacs.close();
    },
  };
}

export async function connectClient(url: string): Promise<Client> {
  const client = new Client({ name: "ambree-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
  return client;
}

export const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

export function rpc(method: string, params: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

export const INIT_PARAMS = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-test", version: "0.0.0" } };
