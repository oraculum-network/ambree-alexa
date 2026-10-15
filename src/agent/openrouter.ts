// OpenRouter chat completions with tool calling (OpenAI-compatible).

import { z } from "zod";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface FunctionTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const ResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function").optional(),
                function: z.object({ name: z.string(), arguments: z.string().optional() }),
              }),
            )
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), cost: z.number().optional() }).optional(),
});
export type ChatResponse = z.infer<typeof ResponseSchema>;

export type ChatFailure = "network" | "timeout" | "http" | "malformed";

export class ChatError extends Error {
  override name = "ChatError";
  readonly kind: ChatFailure;
  readonly status: number | null;
  constructor(kind: ChatFailure, status: number | null = null) {
    super(status ? `${kind} ${status}` : kind);
    this.kind = kind;
    this.status = status;
  }
}

export interface ChatRequest {
  url: string;
  apiKey: string;
  referer: string;
  model: string;
  fallbackModels: string[];
  messages: ChatMessage[];
  tools: FunctionTool[];
  toolChoice: "auto" | "none";
  signal: AbortSignal;
  fetch?: typeof fetch;
}

export const MAX_TOKENS = 300;
export const TEMPERATURE = 0.3;
const MAX_RESPONSE_BYTES = 512 * 1024;

export async function chatCompletion(r: ChatRequest): Promise<ChatResponse> {
  const body = {
    model: r.model,
    models: [r.model, ...r.fallbackModels],
    messages: r.messages,
    tools: r.tools,
    tool_choice: r.toolChoice,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    usage: { include: true },
    provider: { data_collection: "deny" },
  };
  let res: Response;
  try {
    res = await (r.fetch ?? fetch)(r.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${r.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": r.referer,
        "X-Title": "Ambree for Alexa+",
      },
      body: JSON.stringify(body),
      signal: r.signal,
    });
  } catch {
    throw new ChatError(r.signal.aborted ? "timeout" : "network");
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ChatError(r.signal.aborted ? "timeout" : "network");
  }
  if (!res.ok) throw new ChatError("http", res.status);
  if (text.length > MAX_RESPONSE_BYTES) throw new ChatError("malformed");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ChatError("malformed");
  }
  const parsed = ResponseSchema.safeParse(json);
  if (!parsed.success) throw new ChatError("malformed");
  return parsed.data;
}
