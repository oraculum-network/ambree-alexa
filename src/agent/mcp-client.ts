// The agent's MCP client: the SDK Client over Streamable HTTP, pointed at our own
// /mcp. Every tool the agent uses is listed and called through it.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../meta.ts";
import type { FunctionTool } from "./openrouter.ts";

export interface TraceEntry {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
}

export interface ToolCallOutcome {
  ok: boolean;
  /** What the model sees: the structured JSON, or the error text. */
  text: string;
  /** The tool's speech when it succeeded, or its error message. */
  speech: string;
}

export interface McpSession {
  tools: Tool[];
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallOutcome>;
  close(): Promise<void>;
}

const CALL_TIMEOUT_MS = 10_000;

export async function openMcpSession(url: string, trace: TraceEntry[], signal?: AbortSignal): Promise<McpSession> {
  const client = new Client({ name: "ambree-voice-agent", version: VERSION });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport, { signal, timeout: CALL_TIMEOUT_MS });
  const { tools } = await client.listTools(undefined, { signal, timeout: CALL_TIMEOUT_MS });

  return {
    tools,
    async call(name, args, callSignal) {
      const started = performance.now();
      let outcome: ToolCallOutcome;
      try {
        const result = (await client.callTool({ name, arguments: args }, undefined, { signal: callSignal ?? signal, timeout: CALL_TIMEOUT_MS })) as CallToolResult;
        const text = result.content.find((c) => c.type === "text");
        const errorText = text && "text" in text ? text.text : "The tool failed.";
        if (result.isError) {
          outcome = { ok: false, text: errorText, speech: errorText };
        } else {
          const structured = result.structuredContent as { speech?: unknown } | undefined;
          outcome = {
            ok: true,
            text: structured ? JSON.stringify(structured) : errorText,
            speech: typeof structured?.speech === "string" ? structured.speech : "",
          };
        }
      } catch (e) {
        const msg = e instanceof Error && /Unknown tool/.test(e.message) ? `Unknown tool ${name}.` : "The tool could not be reached.";
        outcome = { ok: false, text: msg, speech: "Sorry, one of my tools isn't responding right now." };
      }
      trace.push({ tool: name, args, ms: Math.round(performance.now() - started), ok: outcome.ok });
      return outcome;
    },
    async close() {
      await client.close().catch(() => {});
    },
  };
}

/** MCP tools as OpenAI-style function tools (the JSON Schema without `$schema`). */
export function toFunctionTools(tools: Tool[]): FunctionTool[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...parameters } = t.inputSchema as Record<string, unknown>;
    return { type: "function", function: { name: t.name, description: t.description ?? t.title ?? t.name, parameters } };
  });
}
