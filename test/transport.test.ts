// Transport behaviour of POST /mcp: methods, Origin/Host, protocol version, limits, errors.

import { request } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TestApp, INIT_PARAMS, MCP_HEADERS, connectClient, rpc, startTestApp } from "./helpers/app.ts";

let t: TestApp;

beforeAll(async () => {
  t = await startTestApp({ env: { PUBLIC_ORIGIN: "https://alexa.ambree.ai", ALLOWED_ORIGINS: "https://ambree.ai" } });
});
afterAll(() => t.close());

const post = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${t.url}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body });

/** A raw request with a custom Host header (fetch won't let us set Host). */
function rawPost(host: string, body: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(t.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { ...MCP_HEADERS, Host: host, "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("methods", () => {
  it("GET and DELETE /mcp give 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${t.url}/mcp`, { method, headers: { Accept: "application/json, text/event-stream" } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect((await res.json()).jsonrpc).toBe("2.0");
    }
  });
});

describe("Origin and Host", () => {
  it("rejects a foreign Origin with 403 and a JSON-RPC error", async () => {
    // Foreign origins: another site, our host over plain http, and localhost on another port.
    for (const origin of ["https://openrouter.ai", "http://alexa.ambree.ai", "http://localhost:1"]) {
      const res = await post(rpc("initialize", INIT_PARAMS), { Origin: origin });
      expect(res.status, origin).toBe(403);
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.code).toBe(-32000);
    }
  });

  it("accepts PUBLIC_ORIGIN, ALLOWED_ORIGINS and localhost origins", async () => {
    const { port } = new URL(t.url);
    for (const origin of ["https://alexa.ambree.ai", "https://ambree.ai", `http://localhost:${port}`, `http://127.0.0.1:${port}`]) {
      const res = await post(rpc("initialize", INIT_PARAMS), { Origin: origin });
      expect(res.status, origin).toBe(200);
    }
  });

  it("accepts a request without Origin (a non-browser client)", async () => {
    const res = await post(rpc("initialize", INIT_PARAMS));
    expect(res.status).toBe(200);
    expect((await res.json()).result.protocolVersion).toBe("2025-11-25");
  });

  it("rejects a Host we don't serve (DNS rebinding) and accepts ours", async () => {
    // A hostname we don't serve, as a DNS-rebinding page would send.
    const bad = await rawPost("api.met.no:80", rpc("initialize", INIT_PARAMS));
    expect(bad.status).toBe(403);
    expect(JSON.parse(bad.body).error.message).toMatch(/Host/);
    const good = await rawPost("alexa.ambree.ai", rpc("initialize", INIT_PARAMS));
    expect(good.status).toBe(200);
  });
});

describe("protocol version", () => {
  it("keeps older supported versions on initialize", async () => {
    const res = await post(rpc("initialize", { ...INIT_PARAMS, protocolVersion: "2025-06-18" }));
    expect((await res.json()).result.protocolVersion).toBe("2025-06-18");
  });

  it("gives 400 for an unsupported MCP-Protocol-Version header", async () => {
    const res = await post(rpc("tools/list"), { "MCP-Protocol-Version": "1999-01-01" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Unsupported protocol version/);
  });

  it("keeps the SDK's Accept check (406)", async () => {
    const res = await fetch(`${t.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/plain" }, body: rpc("tools/list") });
    expect(res.status).toBe(406);
  });
});

describe("bodies", () => {
  it("gives 413 above 64 KB", async () => {
    const big = rpc("tools/call", { name: "find_places", arguments: { query: "x".repeat(70 * 1024) } });
    const res = await post(big);
    expect(res.status).toBe(413);
  });

  it("gives 415 for a wrong content type", async () => {
    const res = await post(rpc("tools/list"), { "Content-Type": "text/plain" });
    expect(res.status).toBe(415);
  });

  it("gives a JSON-RPC parse error for invalid JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });
});

describe("errors", () => {
  it("invalid arguments are a tool result with isError (SEP-1303), not a JSON-RPC error", async () => {
    const res = await post(rpc("tools/call", { name: "find_places", arguments: { limit: 99, kind: "volcano" } }));
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/^Invalid arguments for find_places:/);
    expect(body.result.content[0].text).not.toMatch(/MCP error/);
  });

  it("an unknown area is a readable isError result with suggestions", async () => {
    const client = await connectClient(t.url);
    const res = await client.callTool({ name: "weather_now", arguments: { area: "Atlantis" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(/^I don't know the area 'Atlantis'\. Try: /);
    await client.close();
  });

  it("an unknown tool is a JSON-RPC error -32602", async () => {
    const res = await post(rpc("tools/call", { name: "book_hotel", arguments: {} }));
    const body = await res.json();
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(/Unknown tool/);
  });

  it("the SDK client surfaces an unknown tool as a thrown McpError", async () => {
    const client = await connectClient(t.url);
    await expect(client.callTool({ name: "book_hotel", arguments: {} })).rejects.toMatchObject({ code: -32602 });
    await client.close();
  });
});
