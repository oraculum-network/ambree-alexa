// Environment parsing. Fails fast with one clear message per problem.
// Empty values count as unset, so a copied .env.example boots with the defaults.

import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SITE_URL, VERSION } from "./meta.ts";

export const MET_ENDPOINT = "https://api.met.no/weatherapi/locationforecast/2.0/complete";
export const GDACS_ENDPOINT = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";
export const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_PLACES_FILE = fileURLToPath(new URL("../data/places.json", import.meta.url));

const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const httpUrl = z.url({ protocol: /^https?$/ });
const list = z.string().transform((s) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && x.toLowerCase() !== "none"),
);

const EnvSchema = z.object({
  PORT: num(0, 65535).pipe(z.int()).default(8080),
  HOST: z.string().optional(),
  PUBLIC_ORIGIN: httpUrl.optional(),
  ALLOWED_ORIGINS: list.default([]),
  TRUST_PROXY_HOPS: num(0, 10).pipe(z.int()).default(0),
  RATE_LIMIT_SCALE: num(0.1, 1000).default(1),

  DEMO_PASSCODE: z.string().max(200).optional(),
  SESSION_SECRET: z.string().optional(),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_URL: httpUrl.default(OPENROUTER_ENDPOINT),
  AGENT_MODEL: z.string().max(100).default("amazon/nova-2-lite-v1"),
  AGENT_FALLBACK_MODELS: list.default(["deepseek/deepseek-v4-flash"]),
  AGENT_PRICE_IN_PER_M: num(0, 1000).default(0.3),
  AGENT_PRICE_OUT_PER_M: num(0, 1000).default(2.5),
  AGENT_DAILY_USD: num(0, 10000).default(0.5),
  AGENT_DAILY_TURNS: num(0, 1_000_000).pipe(z.int()).default(300),
  MCP_URL: httpUrl.optional(),

  WEATHER_USER_AGENT: z.string().max(200).optional(),
  MET_URL: httpUrl.default(MET_ENDPOINT),
  GDACS_URL: httpUrl.default(GDACS_ENDPOINT),
  FEEDS: z.enum(["on", "off"]).default("on"),
  PLACES_FILE: z.string().optional(),
});

export interface Config {
  port: number;
  host: string | undefined;
  /** Origin only (scheme://host[:port]); undefined means http://localhost:<bound port>. */
  publicOrigin: string | undefined;
  allowedOrigins: string[];
  trustProxyHops: number;
  rateLimitScale: number;
  passcode: string | undefined;
  sessionSecret: string | undefined;
  openrouterKey: string | undefined;
  openrouterUrl: string;
  model: string;
  fallbackModels: string[];
  priceInPerM: number;
  priceOutPerM: number;
  dailyUsd: number;
  dailyTurns: number;
  mcpUrl: string | undefined;
  weatherUserAgent: string;
  metUrl: string;
  gdacsUrl: string;
  feedsEnabled: boolean;
  placesFile: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

function originOf(raw: string, key: string): string {
  const u = new URL(raw);
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    throw new ConfigError(`${key} must be an origin like https://alexa.ambree.ai (no path), got a URL with a path`);
  }
  return u.origin;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(EnvSchema.shape)) {
    const v = env[key];
    if (typeof v === "string" && v.trim() !== "") cleaned[key] = v.trim();
  }
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "env"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;

  if (e.DEMO_PASSCODE && (!e.SESSION_SECRET || e.SESSION_SECRET.length < 32)) {
    throw new ConfigError("DEMO_PASSCODE is set, so SESSION_SECRET is required and must be at least 32 characters");
  }

  return {
    port: e.PORT,
    host: e.HOST,
    publicOrigin: e.PUBLIC_ORIGIN ? originOf(e.PUBLIC_ORIGIN, "PUBLIC_ORIGIN") : undefined,
    allowedOrigins: e.ALLOWED_ORIGINS.map((o) => originOf(o, "ALLOWED_ORIGINS")),
    trustProxyHops: e.TRUST_PROXY_HOPS,
    rateLimitScale: e.RATE_LIMIT_SCALE,
    passcode: e.DEMO_PASSCODE,
    sessionSecret: e.DEMO_PASSCODE ? e.SESSION_SECRET : undefined,
    openrouterKey: e.OPENROUTER_API_KEY,
    openrouterUrl: e.OPENROUTER_URL,
    model: e.AGENT_MODEL,
    fallbackModels: e.AGENT_FALLBACK_MODELS,
    priceInPerM: e.AGENT_PRICE_IN_PER_M,
    priceOutPerM: e.AGENT_PRICE_OUT_PER_M,
    dailyUsd: e.AGENT_DAILY_USD,
    dailyTurns: e.AGENT_DAILY_TURNS,
    mcpUrl: e.MCP_URL,
    weatherUserAgent: e.WEATHER_USER_AGENT ?? `ambree-alexa/${VERSION} (+${SITE_URL})`,
    metUrl: e.MET_URL,
    gdacsUrl: e.GDACS_URL,
    feedsEnabled: e.FEEDS === "on",
    placesFile: e.PLACES_FILE ?? DEFAULT_PLACES_FILE,
  };
}
