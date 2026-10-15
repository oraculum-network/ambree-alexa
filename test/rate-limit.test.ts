// Token buckets: 429 with Retry-After, the loopback exemption, TRUST_PROXY_HOPS, the bounded map.

import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { cleanForwardedEntry, createClientIdentity, internalTokenAllowed, rateKey } from "../src/http/client-ip.ts";
import { createOriginPolicy } from "../src/http/origin.ts";
import { createRateLimiter } from "../src/http/rate-limit.ts";
import type { LogRecord } from "../src/log.ts";
import { INIT_PARAMS, MCP_HEADERS, type TestApp, rpc, startTestApp } from "./helpers/app.ts";
import { json, startMockServer } from "./helpers/mock-server.ts";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("token bucket", () => {
  it("allows the burst, then refills at the per-minute rate", () => {
    let now = 0;
    const l = createRateLimiter({ perMinute: 12, burst: 4, now: () => now });
    for (let i = 0; i < 4; i++) expect(l.take("a").ok).toBe(true);
    const denied = l.take("a");
    expect(denied).toEqual({ ok: false, retryAfterSec: 5 });
    now += 5000;
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a").ok).toBe(false);
    expect(l.take("b").ok).toBe(true);
  });

  it("bounds the map at maxKeys, evicting the least recently used key", () => {
    const l = createRateLimiter({ perMinute: 1, burst: 1, maxKeys: 10_000, now: () => 0 });
    expect(l.take("first").ok).toBe(true);
    for (let i = 0; i < 10_000; i++) l.take(`k${i}`);
    expect(l.size()).toBe(10_000);
    // "first" was evicted, so it starts with a full bucket again.
    expect(l.take("first").ok).toBe(true);
    expect(l.size()).toBe(10_000);
  });
});

const agent = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ambree", ...headers }, body: JSON.stringify({ text: "hello" }) });
const mcp = (url: string, headers: Record<string, string> = {}) => fetch(`${url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body: rpc("initialize", INIT_PARAMS) });

describe("routes", () => {
  it("/api/agent allows a burst of 4, then 429 with Retry-After", async () => {
    t = await startTestApp({ env: { FEEDS: "off" } });
    for (let i = 0; i < 4; i++) expect((await agent(t.url)).status).toBe(200);
    const res = await agent(t.url);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await res.json()).error).toBe("rate_limited");
  });

  it("/api/unlock allows 5, then 429", async () => {
    t = await startTestApp({ env: { DEMO_PASSCODE: "test-passcode-not-real", SESSION_SECRET: "test-session-secret-not-real-0123456789" } });
    const unlock = () =>
      fetch(`${t!.url}/api/unlock`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ambree" }, body: JSON.stringify({ passcode: "wrong" }) });
    for (let i = 0; i < 5; i++) expect((await unlock()).status).toBe(401);
    expect((await unlock()).status).toBe(429);
  });

  it("/mcp is limited for every client (burst 30), loopback included, with Retry-After", async () => {
    t = await startTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await mcp(t.url)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    const limited = await mcp(t.url);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await limited.json()).jsonrpc).toBe("2.0");
    // A guessed internal token doesn't help.
    expect((await mcp(t.url, { "X-Ambree-Internal": "a".repeat(43) })).status).toBe(429);
  });

  it("the agent's own MCP calls stay exempt (internal token) when the /mcp bucket is empty", async () => {
    t = await startTestApp({ env: { FEEDS: "off" } });
    for (let i = 0; i < 31; i++) await mcp(t.url);
    expect((await mcp(t.url)).status).toBe(429);
    const res = await fetch(`${t.url}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "ambree" },
      body: JSON.stringify({ text: "Tell me about the Blue Penny Museum." }),
    });
    const out = await res.json();
    expect(out.trace).toEqual([expect.objectContaining({ tool: "place_details", ok: true })]);
    // The token never appears in a log line or a response.
    const logText = JSON.stringify(t.logs);
    expect(logText).not.toMatch(/x-ambree-internal/i);
    expect(JSON.stringify(out)).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });

  it("TRUST_PROXY_HOPS keys on the N-th X-Forwarded-For entry from the right", async () => {
    t = await startTestApp({ env: { TRUST_PROXY_HOPS: "1", FEEDS: "off" } });
    for (let i = 0; i < 4; i++) expect((await agent(t.url, { "X-Forwarded-For": "::1, 127.0.0.1" })).status).toBe(200);
    expect((await agent(t.url, { "X-Forwarded-For": "::1, 127.0.0.1" })).status).toBe(429);
    // A different rightmost entry is a different client.
    expect((await agent(t.url, { "X-Forwarded-For": "127.0.0.1, ::1" })).status).toBe(200);
    await t.close();

    t = await startTestApp({ env: { TRUST_PROXY_HOPS: "2", FEEDS: "off" } });
    for (let i = 0; i < 4; i++) expect((await agent(t.url, { "X-Forwarded-For": "::1, 127.0.0.1" })).status).toBe(200);
    // With 2 hops the key is "::1", whatever the last proxy appended.
    expect((await agent(t.url, { "X-Forwarded-For": "::1, ::ffff:127.0.0.1" })).status).toBe(429);
  });
});

// IPv6 documentation addresses (2001:db8::/32, RFC 3849), assembled at run time so that no
// address literal other than loopback sits in the source.
const DOC_PREFIX = ["2001", "db8"].join(":");
const v6 = (subnet: number, host: number) => `${DOC_PREFIX}:1:${subnet.toString(16)}::${host.toString(16)}`;

function fakeReq(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) } as unknown as IncomingMessage;
}

describe("client keys (R4, R9)", () => {
  it("keys IPv6 clients by their /64, and IPv4-mapped ones as IPv4", () => {
    expect(rateKey("127.0.0.1")).toBe("127.0.0.1");
    expect(rateKey("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(rateKey("::1")).toBe("0:0:0:0::/64");
    expect(rateKey(v6(2, 1))).toBe(rateKey(v6(2, 0xffff)));
    expect(rateKey(v6(2, 1))).toBe(`${DOC_PREFIX}:1:2::/64`);
    expect(rateKey(v6(2, 1))).not.toBe(rateKey(v6(3, 1)));
  });

  it("strips a port and brackets from an X-Forwarded-For entry", () => {
    expect(cleanForwardedEntry("127.0.0.1:443")).toBe("127.0.0.1");
    expect(cleanForwardedEntry("[::1]:8443")).toBe("::1");
    expect(cleanForwardedEntry("[::1]")).toBe("::1");
    expect(cleanForwardedEntry("::1")).toBe("::1");
    expect(cleanForwardedEntry(` ${v6(2, 7)} `)).toBe(v6(2, 7));
  });

  it("falls back to the socket for a non-address entry, and logs that once without the value", () => {
    const logs: LogRecord[] = [];
    const id = createClientIdentity({ trustProxyHops: 1, internalToken: "t".repeat(43), log: (r) => logs.push(r) });
    expect(id.key(fakeReq("::1", { "X-Forwarded-For": "127.0.0.1:443" }))).toBe("127.0.0.1");
    expect(id.key(fakeReq("::1", { "X-Forwarded-For": "[::1]:443" }))).toBe("0:0:0:0::/64");
    expect(id.key(fakeReq("::ffff:127.0.0.1", { "X-Forwarded-For": "garbage" }))).toBe("127.0.0.1");
    expect(id.key(fakeReq("::ffff:127.0.0.1", { "X-Forwarded-For": "more-garbage" }))).toBe("127.0.0.1");
    expect(logs).toEqual([{ level: "warn", event: "xff_not_ip", hops: 1 }]);
  });

  it("treats a request as internal only with the exact token and no X-Forwarded-For", () => {
    const token = "k".repeat(43);
    const id = createClientIdentity({ trustProxyHops: 0, internalToken: token, log: () => {} });
    expect(id.isInternal(fakeReq("::1", { "X-Ambree-Internal": token }))).toBe(true);
    // From any socket: MCP_URL may point at a non-loopback address.
    expect(id.isInternal(fakeReq("::ffff:127.0.0.1", { "X-Ambree-Internal": token }))).toBe(true);
    expect(id.isInternal(fakeReq("::1", { "X-Ambree-Internal": token, "X-Forwarded-For": "127.0.0.1" }))).toBe(false);
    expect(id.isInternal(fakeReq("::1", { "X-Ambree-Internal": token.slice(1) + "x" }))).toBe(false);
    expect(id.isInternal(fakeReq("::1"))).toBe(false);
  });

  it("one IPv6 /64 behind the proxy shares one unlock bucket", async () => {
    t = await startTestApp({ env: { TRUST_PROXY_HOPS: "1", DEMO_PASSCODE: "test-passcode-not-real", SESSION_SECRET: "test-session-secret-not-real-0123456789" } });
    const unlock = (xff: string) =>
      fetch(`${t!.url}/api/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "ambree", "X-Forwarded-For": xff },
        body: JSON.stringify({ passcode: "wrong" }),
      });
    const statuses: number[] = [];
    for (let host = 1; host <= 7; host++) statuses.push((await unlock(v6(2, host))).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // Another /64 is another client.
    expect((await unlock(v6(3, 1))).status).toBe(401);
  });
});

describe("where the internal token may go (N7)", () => {
  it("only to a loopback MCP_URL or the app's own HOST", () => {
    expect(internalTokenAllowed(undefined, undefined)).toBe(true);
    expect(internalTokenAllowed("http://127.0.0.1:8080/mcp", undefined)).toBe(true);
    expect(internalTokenAllowed("http://localhost:8080/mcp", undefined)).toBe(true);
    expect(internalTokenAllowed("http://[::1]:8080/mcp", undefined)).toBe(true);
    expect(internalTokenAllowed("https://alexa.ambree.ai/mcp", undefined)).toBe(false);
    expect(internalTokenAllowed("http://ambree.ai:8080/mcp", "ambree.ai")).toBe(true);
    expect(internalTokenAllowed("http://ambree.ai:8080/mcp", "localhost")).toBe(false);
  });

  it("sends the token to a loopback MCP_URL", async () => {
    const sniffer = await startMockServer((_req, res) => json(res, 500, {}));
    t = await startTestApp({ env: { MCP_URL: `http://localhost:${new URL(sniffer.url).port}/mcp`, FEEDS: "off" } });
    await fetch(`${t.url}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ambree" }, body: JSON.stringify({ text: "hello" }) });
    expect(sniffer.requests.length).toBeGreaterThan(0);
    expect(sniffer.requests[0]!.headers["x-ambree-internal"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.logs.some((l) => l.event === "agent_mcp_rate_limited")).toBe(false);
    await sniffer.close();
  });

  it("omits it for any other host, and logs once that the agent's MCP calls are rate-limited", async () => {
    t = await startTestApp({ env: { MCP_URL: "https://alexa.ambree.ai/mcp", FEEDS: "off" } });
    const warnings = t.logs.filter((l) => l.event === "agent_mcp_rate_limited");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toMatch(/alexa\.ambree\.ai/);
  });
});

describe("hosts and origins (R8, R18)", () => {
  it("accepts the MCP_URL host and an http://[::1]:PORT origin", () => {
    const p = createOriginPolicy({ publicOrigin: "https://alexa.ambree.ai", port: 8080, extraOrigins: [], extraHosts: ["ambree.ai"] });
    expect(p.isAllowedHost("ambree.ai:8080")).toBe(true);
    expect(p.isAllowedOrigin("http://[::1]:8080")).toBe(true);
    expect(p.isAllowedOrigin("http://[::1]:8081")).toBe(false);
  });

  it("the app adds MCP_URL's host to the allowed hosts", async () => {
    t = await startTestApp({ env: { MCP_URL: "http://ambree.ai:9/mcp" } });
    const { port } = new URL(t.url);
    const post = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const body = rpc("initialize", INIT_PARAMS);
        const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...MCP_HEADERS, Host: host, "Content-Length": Buffer.byteLength(body) } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        });
        req.on("error", reject);
        req.end(body);
      });
    expect(await post("ambree.ai:9")).toBe(200);
    expect(await post("alexa.ambree.ai")).toBe(403);
    const origin = await fetch(`${t.url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, Origin: `http://[::1]:${port}` }, body: rpc("initialize", INIT_PARAMS) });
    expect(origin.status).toBe(200);
  });
});
