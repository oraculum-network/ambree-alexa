// POST /mcp: MCP over Streamable HTTP, stateless. Each request gets a fresh server
// and transport (the SDK's stateless pattern), with JSON responses instead of SSE.
// Origin, Host and rate limits are checked before this runs (see app.ts).

import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readJsonBody } from "../http/body.ts";
import { sendJsonRpcError } from "../http/headers.ts";
import type { ToolDeps } from "../tools/context.ts";
import { TOOL_NAMES, buildMcpServer } from "./server.ts";

export const MCP_BODY_LIMIT = 64 * 1024;

export interface McpRequestInfo {
  /** Tool names in a tools/call request (for the log line; never arguments). */
  tools: string[];
}

function toolNames(m: unknown): string[] {
  if (!m || typeof m !== "object" || (m as { method?: unknown }).method !== "tools/call") return [];
  const name = (m as { params?: { name?: unknown } }).params?.name;
  return [typeof name === "string" && (TOOL_NAMES as readonly string[]).includes(name) ? name : "unknown"];
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, deps: ToolDeps, info: McpRequestInfo): Promise<void> {
  if (req.method !== "POST") {
    sendJsonRpcError(res, 405, -32000, "Method not allowed: this server is stateless, so only POST is supported", { Allow: "POST" });
    return;
  }
  const body = await readJsonBody(req, MCP_BODY_LIMIT);
  if (!body.ok) {
    const code = body.status === 400 ? -32700 : -32000;
    sendJsonRpcError(res, body.status, code, body.status === 400 ? "Parse error: invalid JSON" : body.message, body.status === 413 ? { Connection: "close" } : {});
    return;
  }
  // MCP removed JSON-RPC batching in 2025-06-18. Refusing arrays also keeps one HTTP
  // request (one rate-limit token) to one message.
  if (Array.isArray(body.value)) {
    sendJsonRpcError(res, 400, -32600, "Invalid Request: JSON-RPC batches are not supported (removed in MCP 2025-06-18)");
    return;
  }
  info.tools.push(...toolNames(body.value));

  const server = buildMcpServer(deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body.value);
}
