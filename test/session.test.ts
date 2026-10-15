// The passcode gate: cookie issue and checks, CSRF header, and fail-fast boot.

import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";
import { SESSION_MAX_AGE_SEC, issueSession, verifySession } from "../src/http/session.ts";
import { FIXED_NOW, type TestApp, startTestApp } from "./helpers/app.ts";

const PASSCODE = "test-passcode-not-real";
const SECRET = "test-session-secret-not-real-0123456789";
let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ env: { DEMO_PASSCODE: PASSCODE, SESSION_SECRET: SECRET, FEEDS: "off", RATE_LIMIT_SCALE: "10" } });
});
afterAll(() => t.close());

const api = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${t.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "ambree", ...headers }, body: JSON.stringify(body) });

describe("passcode gate", () => {
  it("/api/agent gives 401 without a session cookie", async () => {
    const res = await api("/api/agent", { text: "hello" });
    expect(res.status).toBe(401);
  });

  it("GET / serves the unlock page without a session, and the app with one", async () => {
    const locked = await (await fetch(`${t.url}/`)).text();
    expect(locked).toMatch(/id="unlock-form"/);
    const cookie = `amb_session=${issueSession(SECRET, FIXED_NOW, PASSCODE)}`;
    const open = await (await fetch(`${t.url}/`, { headers: { Cookie: cookie } })).text();
    expect(open).toMatch(/FOR ALEXA\+ · SIMULATED/);
    expect(await (await fetch(`${t.url}/index.html`)).text()).toMatch(/id="unlock-form"/);
  });

  it("gates the voice page on the resolved file, so path variants can't skip the gate", async () => {
    const { port } = new URL(t.url);
    const raw = (path: string, cookie?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: cookie ? { Cookie: cookie } : {} }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        req.on("error", reject);
        req.end();
      });
    for (const path of ["//index.html", "/%69ndex.html", "/index%2ehtml", "/index.html/", "/./index.html", "/INDEX.html"]) {
      const res = await raw(path);
      expect(res.body, path).not.toMatch(/id="ask-input"/);
      if (res.status === 200) expect(res.body, path).toMatch(/id="unlock-form"/);
      else expect(res.status, path).toBe(404);
    }
    // With a session, the same variants open the app.
    const cookie = `amb_session=${issueSession(SECRET, FIXED_NOW, PASSCODE)}`;
    for (const path of ["//index.html", "/%69ndex.html", "/index.html/"]) {
      expect((await raw(path, cookie)).body, path).toMatch(/id="ask-input"/);
    }
  });

  it("a wrong passcode gives 401; the right one sets a strict, HttpOnly cookie", async () => {
    expect((await api("/api/unlock", { passcode: "nope" })).status).toBe(401);
    const res = await api("/api/unlock", { passcode: PASSCODE });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^amb_session=\d+\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/);
    expect(cookie).not.toMatch(/Secure/); // PUBLIC_ORIGIN is http here
    const value = cookie.split(";")[0]!;
    const agent = await api("/api/agent", { text: "Tell me about the Blue Penny Museum." }, { Cookie: value });
    expect(agent.status).toBe(200);
    expect((await agent.json()).trace[0].tool).toBe("place_details");
  });

  it("rejects a tampered or expired cookie", async () => {
    const good = issueSession(SECRET, FIXED_NOW, PASSCODE);
    const [exp, mac] = good.split(".") as [string, string];
    const tampered = `${Number(exp) + 999}.${mac}`;
    expect((await api("/api/agent", { text: "hi" }, { Cookie: `amb_session=${tampered}` })).status).toBe(401);
    const otherSecret = issueSession("another-secret-that-is-long-enough-123", FIXED_NOW, PASSCODE);
    expect((await api("/api/agent", { text: "hi" }, { Cookie: `amb_session=${otherSecret}` })).status).toBe(401);
    const expired = issueSession(SECRET, FIXED_NOW - (SESSION_MAX_AGE_SEC + 60) * 1000, PASSCODE);
    expect((await api("/api/agent", { text: "hi" }, { Cookie: `amb_session=${expired}` })).status).toBe(401);
    expect(verifySession(good, SECRET, FIXED_NOW, PASSCODE)).toBe(true);
    expect(verifySession(good, SECRET, FIXED_NOW + (SESSION_MAX_AGE_SEC + 1) * 1000, PASSCODE)).toBe(false);
    expect(verifySession("garbage", SECRET, FIXED_NOW, PASSCODE)).toBe(false);
  });

  it("binds the session to the passcode: a cookie issued under another passcode is rejected", async () => {
    const old = issueSession(SECRET, FIXED_NOW, "the-previous-passcode");
    expect(verifySession(old, SECRET, FIXED_NOW, PASSCODE)).toBe(false);
    expect((await api("/api/agent", { text: "hi" }, { Cookie: `amb_session=${old}` })).status).toBe(401);
  });

  it("requires the X-Requested-With header, JSON and an allowed Origin", async () => {
    const cookie = `amb_session=${issueSession(SECRET, FIXED_NOW, PASSCODE)}`;
    const noCsrf = await fetch(`${t.url}/api/agent`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ text: "hi" }) });
    expect(noCsrf.status).toBe(403);
    expect((await api("/api/unlock", { passcode: PASSCODE }, { "X-Requested-With": "XMLHttpRequest" })).status).toBe(403);
    const form = await fetch(`${t.url}/api/agent`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Requested-With": "ambree", Cookie: cookie }, body: "hi" });
    expect(form.status).toBe(415);
    expect((await api("/api/agent", { text: "hi" }, { Cookie: cookie, Origin: "https://openrouter.ai" })).status).toBe(403);
    expect((await fetch(`${t.url}/api/agent`)).status).toBe(405);
  });

  it("keeps /mcp and /healthz open", async () => {
    expect((await fetch(`${t.url}/healthz`)).status).toBe(200);
    const res = await fetch(`${t.url}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "x", version: "1" } } }),
    });
    expect(res.status).toBe(200);
  });

  it("on https names the cookie __Host-amb_session, with Secure, and ignores a plain amb_session", async () => {
    const https = await startTestApp({ env: { DEMO_PASSCODE: PASSCODE, SESSION_SECRET: SECRET, PUBLIC_ORIGIN: "https://alexa.ambree.ai" } });
    const res = await fetch(`${https.url}/api/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "ambree" },
      body: JSON.stringify({ passcode: PASSCODE }),
    });
    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^__Host-amb_session=\d+\.[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800; Secure$/);
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=/);
    const value = setCookie.split(";")[0]!.split("=")[1]!;
    const agent = (cookie: string) =>
      fetch(`${https.url}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "ambree", Cookie: cookie },
        body: JSON.stringify({ text: "Tell me about the Blue Penny Museum." }),
      });
    expect((await agent(`__Host-amb_session=${value}`)).status).toBe(200);
    // A same-valued cookie without the prefix (one a sibling subdomain could set) doesn't count.
    expect((await agent(`amb_session=${value}`)).status).toBe(401);
    await https.close();
  });
});

describe("boot", () => {
  it("fails fast with a passcode but no SESSION_SECRET (or a short one)", () => {
    expect(() => loadConfig({ DEMO_PASSCODE: PASSCODE })).toThrow(ConfigError);
    expect(() => loadConfig({ DEMO_PASSCODE: PASSCODE, SESSION_SECRET: "too-short" })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ DEMO_PASSCODE: PASSCODE, SESSION_SECRET: SECRET })).not.toThrow();
  });

  it("fails fast when DEMO_PASSCODE is present but blank (empty still means no gate)", () => {
    expect(() => loadConfig({ DEMO_PASSCODE: "   ", SESSION_SECRET: SECRET })).toThrow(/DEMO_PASSCODE is set but blank/);
    expect(() => loadConfig({ DEMO_PASSCODE: "\t" })).toThrow(ConfigError);
    expect(loadConfig({ DEMO_PASSCODE: "" }).passcode).toBeUndefined();
  });

  it("the server process exits 1 with a clear message", () => {
    const entry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
    const out = spawnSync(process.execPath, [entry], {
      env: { PATH: process.env.PATH ?? "", PORT: "0", DEMO_PASSCODE: PASSCODE },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/SESSION_SECRET is required and must be at least 32 characters/);
  });
});
