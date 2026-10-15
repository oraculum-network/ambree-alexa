// The HTTP app: routes, guards and logging. No framework: node:http plus the MCP SDK.
//
//   POST /mcp          MCP (Streamable HTTP, stateless). Open, rate-limited.
//   POST /api/agent    The simulated Alexa+ brain (passcode session when set).
//   POST /api/unlock   Passcode -> session cookie.
//   GET  /healthz      { ok, version }
//   GET  /             The voice page (or the unlock page), then static files.

import { realpathSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createBudget, type Budget } from "./agent/budget.ts";
import { runAgentTurn } from "./agent/loop.ts";
import type { Config } from "./config.ts";
import { type PlacesIndex, loadPlacesIndex } from "./data/places.ts";
import { createCycloneClient, type CycloneClient } from "./feeds/cyclones.ts";
import { createWeatherClient, type WeatherClient } from "./feeds/weather.ts";
import { readJsonBody } from "./http/body.ts";
import { clientIp, isLocalUnproxied } from "./http/client-ip.ts";
import { sendJson, sendJsonRpcError, setSecurityHeaders } from "./http/headers.ts";
import { type OriginPolicy, createOriginPolicy } from "./http/origin.ts";
import { LIMITS, type RateLimiter, createRateLimiter } from "./http/rate-limit.ts";
import { SESSION_COOKIE, issueSession, passcodeMatches, readCookie, sessionCookie, verifySession } from "./http/session.ts";
import { resolveStatic, sendFile } from "./http/static.ts";
import { type Logger, jsonLogger } from "./log.ts";
import { handleMcp } from "./mcp/endpoint.ts";
import { VERSION } from "./meta.ts";
import type { ToolDeps } from "./tools/context.ts";

const PUBLIC_DIR = realpathSync(fileURLToPath(new URL("../public", import.meta.url)));
const API_BODY_LIMIT = 16 * 1024;

const AgentRequest = z.object({
  text: z.string().trim().min(1).max(300),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(400) }))
    .max(6)
    .optional(),
});
const UnlockRequest = z.object({ passcode: z.string().min(1).max(200) });

export interface AppOptions {
  config: Config;
  logger?: Logger;
  /** Clock for tools, sessions and the budget (tests pin it). */
  now?: () => number;
  /** Override the places index (tests). */
  places?: PlacesIndex;
}

export interface App {
  server: Server;
  places: PlacesIndex;
  weather: WeatherClient;
  cyclones: CycloneClient;
  budget: Budget;
  /** Listen on config.port (0 = any free port); resolves with the bound port. */
  listen(): Promise<number>;
  url(): string;
  close(): Promise<void>;
}

interface RequestMeta {
  route: string;
  mode?: string;
  tools?: string[];
}

export function createApp(opts: AppOptions): App {
  const { config } = opts;
  const log = opts.logger ?? jsonLogger;
  const now = opts.now ?? Date.now;
  const places = opts.places ?? loadPlacesIndex(config.placesFile);
  const weather = createWeatherClient({ url: config.metUrl, userAgent: config.weatherUserAgent, enabled: config.feedsEnabled, log });
  const cyclones = createCycloneClient({ url: config.gdacsUrl, userAgent: config.weatherUserAgent, enabled: config.feedsEnabled, log });
  const budget = createBudget({
    dailyUsd: config.dailyUsd,
    dailyTurns: config.dailyTurns,
    priceInPerM: config.priceInPerM,
    priceOutPerM: config.priceOutPerM,
    now,
  });
  const deps: ToolDeps = { places, weather, cyclones, now };
  const limiter = (l: { perMinute: number; burst: number }): RateLimiter =>
    createRateLimiter({ perMinute: l.perMinute * config.rateLimitScale, burst: Math.max(1, Math.round(l.burst * config.rateLimitScale)) });
  const limits = { mcp: limiter(LIMITS.mcp), agent: limiter(LIMITS.agent), unlock: limiter(LIMITS.unlock) };

  let port = config.port;
  let policy: OriginPolicy = createOriginPolicy({ publicOrigin: config.publicOrigin ?? `http://localhost:${port}`, port, extraOrigins: config.allowedOrigins });
  const publicOrigin = () => config.publicOrigin ?? `http://localhost:${port}`;
  const https = () => publicOrigin().startsWith("https:");
  const mcpUrl = () => config.mcpUrl ?? `http://127.0.0.1:${port}/mcp`;

  const hasSession = (req: IncomingMessage) =>
    !config.passcode || verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), config.sessionSecret!, now());

  function rateLimited(res: ServerResponse, l: RateLimiter, req: IncomingMessage, jsonRpc: boolean): boolean {
    const d = l.take(clientIp(req, config.trustProxyHops));
    if (d.ok) return false;
    const headers = { "Retry-After": String(d.retryAfterSec) };
    if (jsonRpc) sendJsonRpcError(res, 429, -32000, "Too many requests", headers);
    else sendJson(res, 429, { error: "rate_limited", message: "Too many requests. Please wait a moment." }, headers);
    return true;
  }

  /** Same-origin browser calls only: JSON, our CSRF header, and an allowed Origin. */
  function apiGuard(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
      return false;
    }
    if (req.headers["x-requested-with"] !== "ambree") {
      sendJson(res, 403, { error: "csrf", message: "Missing X-Requested-With header" });
      return false;
    }
    return true;
  }

  async function agentRoute(req: IncomingMessage, res: ServerResponse, meta: RequestMeta): Promise<void> {
    if (!apiGuard(req, res)) return;
    if (!hasSession(req)) return sendJson(res, 401, { error: "locked", message: "Unlock the demo first." });
    if (rateLimited(res, limits.agent, req, false)) return;
    const body = await readJsonBody(req, API_BODY_LIMIT);
    if (!body.ok) return sendJson(res, body.status, { error: "bad_request", message: body.message }, body.status === 413 ? { Connection: "close" } : {});
    const parsed = AgentRequest.safeParse(body.value);
    if (!parsed.success) return sendJson(res, 400, { error: "bad_request", message: "Send { text } with 1 to 300 characters, and at most 6 history items." });
    const result = await runAgentTurn(parsed.data, { config, mcpUrl: mcpUrl(), publicOrigin: publicOrigin(), places, budget, now });
    meta.mode = result.mode;
    meta.tools = result.trace.map((t) => t.tool);
    sendJson(res, 200, result);
  }

  async function unlockRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!apiGuard(req, res)) return;
    if (!config.passcode) return sendJson(res, 404, { error: "not_enabled" });
    if (rateLimited(res, limits.unlock, req, false)) return;
    const body = await readJsonBody(req, API_BODY_LIMIT);
    if (!body.ok) return sendJson(res, body.status, { error: "bad_request", message: body.message }, body.status === 413 ? { Connection: "close" } : {});
    const parsed = UnlockRequest.safeParse(body.value);
    if (!parsed.success || !passcodeMatches(parsed.data.passcode, config.passcode)) {
      return sendJson(res, 401, { error: "wrong_passcode", message: "That passcode didn't work." });
    }
    sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(issueSession(config.sessionSecret!, now()), https()) });
  }

  async function staticRoute(req: IncomingMessage, res: ServerResponse, path: string, meta: RequestMeta): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
    const head = req.method === "HEAD";
    let target = path;
    if (path === "/" || path === "/index.html") {
      meta.route = "page";
      target = hasSession(req) ? "/index.html" : "/unlock.html";
    } else {
      meta.route = path.endsWith(".html") ? "page" : "static";
    }
    const found = await resolveStatic(PUBLIC_DIR, target);
    if (!found.ok) {
      meta.route = "not_found";
      return sendJson(res, found.status, { error: found.status === 400 ? "bad_request" : "not_found" });
    }
    await sendFile(res, found.file, found.type, head);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const meta: RequestMeta = { route: "other" };
    setSecurityHeaders(res, https());
    res.on("finish", () => {
      log({ route: meta.route, method: req.method ?? "", status: res.statusCode, ms: Math.round(performance.now() - started), mode: meta.mode, tools: meta.tools });
    });

    const rawPath = (req.url ?? "/").split("?")[0] || "/";
    const isMcp = rawPath === "/mcp";
    const knownApi = rawPath === "/api/agent" || rawPath === "/api/unlock";
    meta.route = isMcp ? "/mcp" : knownApi ? rawPath : rawPath.startsWith("/api/") ? "/api/unknown" : rawPath === "/healthz" ? "/healthz" : "static";

    if (rawPath === "/healthz") {
      // Health probes may use any Host, so this one route skips the Host check.
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
      return sendJson(res, 200, { ok: true, version: VERSION });
    }
    if (!policy.isAllowedHost(req.headers.host)) {
      if (isMcp) return sendJsonRpcError(res, 403, -32000, "Forbidden: Host not allowed");
      return sendJson(res, 403, { error: "forbidden_host" });
    }
    const origin = req.headers.origin;
    if (!policy.isAllowedOrigin(origin)) {
      if (isMcp) return sendJsonRpcError(res, 403, -32000, "Forbidden: Origin not allowed");
      return sendJson(res, 403, { error: "forbidden_origin" });
    }

    if (isMcp) {
      if (!isLocalUnproxied(req) && rateLimited(res, limits.mcp, req, true)) return;
      const info = { tools: [] as string[] };
      meta.tools = info.tools;
      return handleMcp(req, res, deps, info);
    }
    if (rawPath === "/api/agent") return agentRoute(req, res, meta);
    if (rawPath === "/api/unlock") return unlockRoute(req, res);
    if (rawPath.startsWith("/api/")) return sendJson(res, 404, { error: "not_found" });
    return staticRoute(req, res, rawPath, meta);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log({ level: "error", route: "internal", error: e instanceof Error ? e.name : "unknown" });
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 20_000;

  return {
    server,
    places,
    weather,
    cyclones,
    budget,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        const done = () => {
          port = (server.address() as AddressInfo).port;
          policy = createOriginPolicy({ publicOrigin: publicOrigin(), port, extraOrigins: config.allowedOrigins });
          resolve(port);
        };
        if (config.host) server.listen(config.port, config.host, done);
        else server.listen(config.port, done);
      });
    },
    url: () => `http://127.0.0.1:${port}`,
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}
