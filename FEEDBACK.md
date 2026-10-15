# Feedback

One section per tool, API or SDK we used. Concrete snags are in [`FRICTION.md`](FRICTION.md).

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **What we used it for:** the server (`McpServer`, `registerTool`, `StreamableHTTPServerTransport` in stateless
  JSON mode) and the client inside our agent (`Client`, `StreamableHTTPClientTransport`), plus the tests.
- **What worked:** zod 4 schemas work directly for input and output; the client validates `structuredContent`
  against the output schema for free; stateless mode is a few lines; `serverInfo` takes `title`, `description`,
  `websiteUrl` and `icons`; schema failures are already `isError` results (SEP-1303); protocol-version checks
  (400 on an unsupported header) and the `Accept` check come built in.
- **What needs work:** unknown tools become `isError` instead of a protocol error; `registerTool` can't set
  `icons`; the DNS-rebinding helpers are deprecated in the transport and Express-only elsewhere; schemas come out
  as draft-07 with no option for 2020-12; a malformed `tools/call` becomes -32603 with a raw ZodError dump; no way
  to wrap request handlers without private fields. See `FRICTION.md`.
- **Onboarding (zero to hello world):** about 30 minutes from `npm install` to a stateless server answering `initialize` and `tools/list` from the SDK client. Most of it went on finding the stateless pattern (a new server and transport per request), which the docs show only in passing.
- **Would we use it again:** yes. It's the shortest path to a spec-current server. We'd like the friction items fixed so we can drop our handler wrapper.

## MCP specification 2025-11-25

- **What we used it for:** Streamable HTTP, tools with titles, annotations, icons and output schemas,
  `structuredContent`, `instructions`, and tool-execution errors (SEP-1303).
- **What worked:** `structuredContent` plus output schemas make results machine-checkable; SEP-1303 lets a model
  fix its own bad arguments; `icons`, `title` and `websiteUrl` make a server presentable in clients.
- **What needs work:** a short "stateless, tools-only server" profile that lists which parts apply (no sessions, no SSE stream, 405 on GET); one example `tools/list` response showing icons, annotations and an output schema together; and a louder note that JSON-RPC batching was removed in 2025-06-18, since SDK servers still accept batches unless you refuse them.
- **Onboarding (zero to hello world):** the dated changelog page made the 2025-06-18 → 2025-11-25 delta easy to scope: about 20 minutes to list every change that touches a tools-only server.
- **Would we use it again:** yes.

## Agent Skills format

- **What we used it for:** `skills/ambree-mauritius/SKILL.md`, which tells an agent when to call each tool and to
  read `speech` aloud.
- **What worked:** YAML frontmatter (`name`, `description`) plus Markdown is quick to write and easy to review.
- **What needs work:** a validator for the frontmatter and size limits, and a convention for pointing a skill at an MCP server (a URL field), so a client could offer to connect it.
- **Onboarding (zero to hello world):** about 10 minutes from reading the format to a working `SKILL.md`.
- **Would we use it again:** yes, as the human-readable twin of the MCP server.

## OpenRouter

- **What we used it for:** LLM mode: chat completions with tool calling, `models` fallbacks, `usage.include` for
  per-call cost, and `provider.data_collection: "deny"`.
- **What worked:** the OpenAI-compatible tool-calling format maps one-to-one onto MCP tools (we only strip the
  JSON Schema `$schema` key); `usage.cost` makes a daily budget guard simple.
- **What needs work:** pending the live run: so far LLM mode has only run against a mock OpenRouter in the tests.
- **Onboarding (zero to hello world):** pending the live run.
- **Would we use it again:** pending the live run.

## Amazon Nova 2 Lite (via OpenRouter)

- **What we used it for:** the default model in LLM mode (`amazon/nova-2-lite-v1`), choosing tools and phrasing
  short spoken replies.
- **What worked:** pending the live run: so far LLM mode has only run against a mock OpenRouter in the tests.
- **What needs work:** pending the live run.
- **Onboarding (zero to hello world):** pending the live run.
- **Would we use it again:** pending the live run.

## MET Norway Locationforecast 2.0

- **What we used it for:** the hourly forecast behind `weather_now` and `replan_day` (`/complete`, for
  precipitation probability where available).
- **What worked:** no key, a clear licence (CC BY 4.0), and cache-friendly headers (`Expires`, `Last-Modified`,
  304). Hourly steps for about two and a half days cover every window we need.
- **What needs work:** `probability_of_precipitation` is not present everywhere, so a rainy hour also has to be
  judged on the amount.
- **Onboarding (zero to hello world):** under an hour, because the terms of service say exactly what a good client does: a User-Agent with contact details, caching until `Expires`, `If-Modified-Since` and truncated coordinates.
- **Would we use it again:** yes. It's the most considerate free weather API we know.

## GDACS

- **What we used it for:** tropical cyclone alerts near Mauritius; an orange or red alert that affects Mauritius or
  is within 800 km makes `replan_day` say "stay safe".
- **What worked:** one GeoJSON call covers every active system with an alert level, position and affected
  countries.
- **What needs work:** times have no zone (they are UTC), and an empty search answers 204 or an empty body, so the
  client has to handle both.
- **Onboarding (zero to hello world):** about an hour. The search endpoint and its parameters had to be worked out from examples; a documented, versioned schema for `geteventlist` would help.
- **Would we use it again:** yes, for cyclone context. Answers always point to the Mauritius Meteorological Services, because GDACS is not an official warning.

## Web Speech API

- **What we used it for:** voice in (`SpeechRecognition` / `webkitSpeechRecognition`, `en-US`, interim results)
  and voice out (`speechSynthesis`, preferring a natural en-GB or en-US voice).
- **What worked:** no dependencies, and interim results make the page feel responsive.
- **What needs work:** recognition only works in Chromium-based browsers (and Chrome sends audio to Google), so
  the page needs a typed fallback; in headless Chromium the speaking state lingers, so the screenshot tests cancel speech.
 
- **Onboarding (zero to hello world):** minutes, both ways.
- **Would we use it again:** for a demo, yes. For the product we'd want on-device recognition, or a provider we choose, since Chrome sends the audio to Google.