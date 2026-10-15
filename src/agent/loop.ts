// The simulated Alexa+ brain behind POST /api/agent.
//
// It is a real MCP client: it lists the tools from our own /mcp and calls them over
// Streamable HTTP. With OPENROUTER_API_KEY it lets an LLM choose the tools (capped
// rounds, calls and time); without a key, when OpenRouter fails, or when today's budget
// is spent, the offline keyword router picks one tool and Ambree speaks its result.

import type { Config } from "../config.ts";
import type { PlacesIndex } from "../data/places.ts";
import { capSpeech } from "../tools/speech.ts";
import { muParts, hhmmMu } from "../time.ts";
import type { Budget } from "./budget.ts";
import { type McpSession, type TraceEntry, openMcpSession, toFunctionTools } from "./mcp-client.ts";
import { OFFLINE_HINT, routeOffline } from "./offline.ts";
import { type ChatMessage, type ChatResponse, ChatError, MAX_TOKENS, chatCompletion } from "./openrouter.ts";

export const MAX_TOOL_ROUNDS = 4;
export const MAX_CALLS_PER_ROUND = 3;
export const MAX_CALLS_PER_TURN = 6;
export const LLM_CALL_TIMEOUT_MS = 20_000;
export const TURN_TIMEOUT_MS = 30_000;
export const REPLY_MAX_CHARS = 300;

export const NOTICES = {
  budget: "Today's AI budget is used up, so I'm answering in offline mode.",
  credit: "The AI service is out of credit, so I'm answering in offline mode.",
  down: "The AI model didn't respond, so I'm answering in offline mode.",
  busy: "Lots of people are asking right now, so I'm answering in offline mode.",
} as const;

export interface AgentInput {
  text: string;
  history?: Array<{ role: "user" | "assistant"; text: string }>;
}

export interface AgentReply {
  reply: string;
  mode: "llm" | "offline";
  model?: string;
  trace: TraceEntry[];
  notice?: string;
}

export interface AgentDeps {
  config: Pick<Config, "openrouterKey" | "openrouterUrl" | "model" | "fallbackModels">;
  mcpUrl: string;
  /** Extra headers on every MCP request (the app's internal token). */
  mcpHeaders?: Record<string, string>;
  /** Sent as HTTP-Referer to OpenRouter. */
  publicOrigin: string;
  places: PlacesIndex;
  budget: Budget;
  now: () => number;
  fetch?: typeof fetch;
  /** Per-call LLM timeout (tests shorten it). */
  llmTimeoutMs?: number;
}

export function systemPrompt(now: number): string {
  const p = muParts(now);
  return [
    "You are Ambree, a Mauritius travel guide, speaking through a voice assistant.",
    "Reply in at most 2 short sentences for the ear: no lists, markdown, URLs or emoji.",
    "Use the tools for every fact. Only mention places that come from tool results.",
    "Prefer replan_day when the traveller mentions weather changing their plans.",
    "If a tool fails, say so briefly.",
    `The traveller is staying in Grand Baie, Mauritius, with 3 days left. It is ${p.longDate}, ${hhmmMu(now)} in Mauritius.`,
  ].join(" ");
}

/** Strip markdown, then cap at 2 sentences and 300 characters. */
export function tidyReply(text: string): string {
  return capSpeech(text, 2, REPLY_MAX_CHARS);
}

async function offlineTurn(text: string, session: McpSession, places: PlacesIndex, signal: AbortSignal): Promise<string> {
  const route = routeOffline(text, places);
  if (!route) return OFFLINE_HINT;
  const out = await session.call(route.tool, route.args, signal);
  return out.speech || OFFLINE_HINT;
}

class BudgetSpent extends Error {
  override name = "BudgetSpent";
}

function noticeFor(e: unknown): string {
  if (e instanceof ChatError && e.kind === "http" && e.status === 402) return NOTICES.credit;
  return NOTICES.down;
}

async function llmTurn(input: AgentInput, session: McpSession, deps: AgentDeps, turnSignal: AbortSignal): Promise<{ reply: string; model: string }> {
  const key = deps.config.openrouterKey!;
  const tools = toFunctionTools(session.tools);
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(deps.now()) }];
  for (const h of input.history ?? []) if (h.text.trim()) messages.push({ role: h.role, content: h.text });
  messages.push({ role: "user", content: input.text });

  let totalCalls = 0;
  let lastSpeech = "";
  let model = deps.config.model;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const allowTools = round < MAX_TOOL_ROUNDS && totalCalls < MAX_CALLS_PER_TURN;
    // Reserve this call's worst case before sending it (synchronously), then settle.
    const reserved = deps.budget.reservationFor(JSON.stringify(messages).length + JSON.stringify(tools).length, MAX_TOKENS);
    if (!deps.budget.tryReserve(reserved)) throw new BudgetSpent();
    let cost = reserved;
    let res: ChatResponse;
    try {
      res = await chatCompletion({
        url: deps.config.openrouterUrl,
        apiKey: key,
        referer: deps.publicOrigin,
        model: deps.config.model,
        fallbackModels: deps.config.fallbackModels,
        messages,
        tools,
        toolChoice: allowTools ? "auto" : "none",
        signal: AbortSignal.any([turnSignal, AbortSignal.timeout(deps.llmTimeoutMs ?? LLM_CALL_TIMEOUT_MS)]),
        fetch: deps.fetch,
      });
      // No usage reported: keep the reservation rather than counting the call as free.
      cost = deps.budget.costOf(res.usage) ?? reserved;
    } catch (e) {
      // An error status means no completion was served; a timeout, network failure or
      // unreadable reply may still be billed, so it keeps its reservation.
      if (e instanceof ChatError && e.kind === "http") cost = 0;
      throw e;
    } finally {
      deps.budget.settle(reserved, cost);
    }
    if (res.model) model = res.model;
    const msg = res.choices[0]!.message;
    const calls = msg.tool_calls ?? [];
    if (!allowTools || calls.length === 0) {
      const reply = tidyReply(msg.content ?? "");
      return { reply: reply || lastSpeech || "Sorry, I couldn't find an answer to that.", model };
    }
    messages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments ?? "{}" } })),
    });
    for (const [i, c] of calls.entries()) {
      if (i >= MAX_CALLS_PER_ROUND || totalCalls >= MAX_CALLS_PER_TURN) {
        messages.push({ role: "tool", tool_call_id: c.id, content: "Not run: the tool call limit for this turn was reached. Answer with what you have." });
        continue;
      }
      let args: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(c.function.arguments || "{}");
        args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      totalCalls++;
      const out = await session.call(c.function.name, args, turnSignal);
      if (out.ok && out.speech) lastSpeech = out.speech;
      messages.push({ role: "tool", tool_call_id: c.id, content: out.text });
    }
  }
  return { reply: lastSpeech || "Sorry, I couldn't find an answer to that.", model };
}

export async function runAgentTurn(input: AgentInput, deps: AgentDeps): Promise<AgentReply> {
  const trace: TraceEntry[] = [];
  const turnSignal = AbortSignal.timeout(TURN_TIMEOUT_MS);
  let session: McpSession;
  try {
    session = await openMcpSession(deps.mcpUrl, trace, turnSignal, deps.mcpHeaders);
  } catch {
    return { reply: "Sorry, my Mauritius tools aren't reachable right now. Please try again in a minute.", mode: "offline", trace };
  }
  try {
    if (!deps.config.openrouterKey) {
      return { reply: await offlineTurn(input.text, session, deps.places, turnSignal), mode: "offline", trace };
    }
    const gate = deps.budget.beginTurn();
    if (!gate.ok) {
      const notice = gate.reason === "busy" ? NOTICES.busy : NOTICES.budget;
      return { reply: await offlineTurn(input.text, session, deps.places, turnSignal), mode: "offline", trace, notice };
    }
    try {
      const { reply, model } = await llmTurn(input, session, deps, turnSignal);
      return { reply, mode: "llm", model, trace };
    } catch (e) {
      const notice = e instanceof BudgetSpent ? NOTICES.budget : noticeFor(e);
      const fallbackSignal = AbortSignal.timeout(10_000);
      return { reply: await offlineTurn(input.text, session, deps.places, fallbackSignal), mode: "offline", trace, notice };
    } finally {
      deps.budget.endTurn();
    }
  } finally {
    await session.close();
  }
}
