// Static files, security headers and the health check.

import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAGE_CSP } from "../src/http/headers.ts";
import { VERSION } from "../src/meta.ts";
import { type TestApp, startTestApp } from "./helpers/app.ts";

let t: TestApp;
beforeAll(async () => {
  t = await startTestApp({ env: { FEEDS: "off" } });
});
afterAll(() => t.close());

/** Send a raw path (fetch would normalize "/../"). */
function rawGet(path: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(t.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("static files", () => {
  it("refuses traversal, dotfiles and unknown types", async () => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/fonts/../../src/app.ts", "/..%2fsrc%2fapp.ts", "/.env", "/.well-known/x.json", "/fonts/.hidden.txt", "/%00.html", "/src/app.ts"]) {
      const res = await rawGet(path);
      expect([400, 404], path).toContain(res.status);
      expect(res.body, path).not.toMatch(/createApp|"dependencies"/);
    }
  });

  it("serves files with the right types and caching", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["/", "text/html; charset=utf-8", /^no-cache$/],
      ["/app.js", "text/javascript; charset=utf-8", /max-age=3600/],
      ["/styles.css", "text/css; charset=utf-8", /max-age=3600/],
      ["/ambree-lockup.svg", "image/svg+xml", /max-age=3600/],
      ["/fonts/InstrumentSans.ttf", "font/ttf", /max-age=3600/],
    ];
    for (const [path, type, cache] of cases) {
      const res = await fetch(`${t.url}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect(res.headers.get("cache-control"), path).toMatch(cache);
    }
  });

  it("puts the security headers on every response and the CSP on pages", async () => {
    for (const path of ["/", "/app.js", "/healthz", "/missing.html"]) {
      const res = await fetch(`${t.url}${path}`);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("cross-origin-opener-policy"), path).toBe("same-origin");
      expect(res.headers.get("permissions-policy"), path).toBe("microphone=(self), camera=(), geolocation=()");
      expect(res.headers.get("strict-transport-security"), path).toBeNull(); // http here
    }
    const page = await fetch(`${t.url}/`);
    expect(page.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(PAGE_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
  });

  it("has no inline scripts or styles in the pages, and no external URLs", async () => {
    for (const path of ["/", "/unlock.html"]) {
      const html = await (await fetch(`${t.url}${path}`)).text();
      expect(html, path).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(html, path).not.toMatch(/\sstyle=|<style/);
      expect(html, path).not.toMatch(/\son[a-z]+=/);
      const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
      expect(urls.filter((u) => /^(https?:)?\/\//.test(u) && u !== "https://github.com/oraculum-network/ambree-alexa"), path).toEqual([]);
    }
  });
});

describe("health", () => {
  it("GET /healthz returns ok and the version", async () => {
    const res = await fetch(`${t.url}/healthz`);
    expect(await res.json()).toEqual({ ok: true, version: VERSION });
  });

  it("unknown API routes are 404 JSON without stack traces", async () => {
    const res = await fetch(`${t.url}/api/nope`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"not_found"}');
  });
});
