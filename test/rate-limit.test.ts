// Token buckets: 429 with Retry-After, the loopback exemption, TRUST_PROXY_HOPS, the bounded map.

import { afterEach, describe, expect, it } from "vitest";
import { createRateLimiter } from "../src/http/rate-limit.ts";
import { INIT_PARAMS, MCP_HEADERS, type TestApp, rpc, startTestApp } from "./helpers/app.ts";

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

  it("/mcp exempts only loopback requests without X-Forwarded-For", async () => {
    t = await startTestApp();
    for (let i = 0; i < 40; i++) expect((await mcp(t.url)).status).toBe(200);
    // The same loopback socket, but relayed by a proxy: limited (burst 30).
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await mcp(t.url, { "X-Forwarded-For": "127.0.0.1" })).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
    const limited = await mcp(t.url, { "X-Forwarded-For": "127.0.0.1" });
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await limited.json()).jsonrpc).toBe("2.0");
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
