# Feedback

One section per tool, API or SDK we used. What we learned while building is filled in; the rest is marked
`TODO(CTO)`. Concrete snags are in [`FRICTION.md`](FRICTION.md).

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1)

- **What we used it for:** the server (`McpServer`, `registerTool`, `StreamableHTTPServerTransport` in stateless
  JSON mode) and the client inside our agent (`Client`, `StreamableHTTPClientTransport`), plus the tests.
- **What worked:** zod 4 schemas work directly for input and output; the client validates `structuredContent`
  against the output schema for free; stateless mode is a few lines; `serverInfo` takes `title`, `description`,
  `websiteUrl` and `icons`; schema failures are already `isError` results (SEP-1303); protocol-version checks
  (400 on an unsupported header) and the `Accept` check come built in.
- **What needs work:** unknown tools become `isError` instead of a protocol error; `registerTool` can't set
  `icons`; the DNS-rebinding helpers are deprecated in the transport and Express-only elsewhere; schemas come out
  as draft-07; no way to wrap request handlers without private fields. See `FRICTION.md`.
- **Onboarding (zero to hello world):** quick for a server: under 30 minutes to a working stateless endpoint. The
  stateless pattern (a new server and transport per request) is easy to miss in the docs. TODO(CTO): your own
  timing.
- **Would we use it again:** yes. TODO(CTO): confirm.

## MCP specification 2025-11-25

- **What we used it for:** Streamable HTTP, tools with titles, annotations, icons and output schemas,
  `structuredContent`, `instructions`, and tool-execution errors (SEP-1303).
- **What worked:** `structuredContent` plus output schemas make results machine-checkable; SEP-1303 lets a model
  fix its own bad arguments; `icons`, `title` and `websiteUrl` make a server presentable in clients.
- **What needs work:** TODO(CTO).
- **Onboarding (zero to hello world):** TODO(CTO).
- **Would we use it again:** TODO(CTO).

## Agent Skills format

- **What we used it for:** `skills/ambree-mauritius/SKILL.md`, which tells an agent when to call each tool and to
  read `speech` aloud.
- **What worked:** YAML frontmatter (`name`, `description`) plus Markdown is quick to write and easy to review.
- **What needs work:** TODO(CTO).
- **Onboarding (zero to hello world):** TODO(CTO).
- **Would we use it again:** TODO(CTO).

## OpenRouter

- **What we used it for:** LLM mode: chat completions with tool calling, `models` fallbacks, `usage.include` for
  per-call cost, and `provider.data_collection: "deny"`.
- **What worked:** the OpenAI-compatible tool-calling format maps one-to-one onto MCP tools (we only strip the
  JSON Schema `$schema` key); `usage.cost` makes a daily budget guard simple.
- **What needs work:** TODO(CTO).
- **Onboarding (zero to hello world):** TODO(CTO).
- **Would we use it again:** TODO(CTO).

## Amazon Nova 2 Lite (via OpenRouter)

- **What we used it for:** the default model in LLM mode (`amazon/nova-2-lite-v1`), choosing tools and phrasing
  short spoken replies.
- **What worked:** TODO(CTO): not exercised in this build; all tests run against a mock OpenRouter.
- **What needs work:** TODO(CTO).
- **Onboarding (zero to hello world):** TODO(CTO).
- **Would we use it again:** TODO(CTO).

## MET Norway Locationforecast 2.0

- **What we used it for:** the hourly forecast behind `weather_now` and `replan_day` (`/complete`, for
  precipitation probability where available).
- **What worked:** no key, a clear licence (CC BY 4.0), and cache-friendly headers (`Expires`, `Last-Modified`,
  304). Hourly steps for about two and a half days cover every window we need.
- **What needs work:** `probability_of_precipitation` is not present everywhere, so a rainy hour also has to be
  judged on the amount. TODO(CTO).
- **Onboarding (zero to hello world):** TODO(CTO).
- **Would we use it again:** TODO(CTO).

## GDACS

- **What we used it for:** tropical cyclone alerts near Mauritius; an orange or red alert makes `replan_day` say
  "stay safe".
- **What worked:** one GeoJSON call covers every active system with an alert level, position and affected
  countries.
- **What needs work:** times have no zone (they are UTC), and an empty search answers 204 or an empty body, so the
  client has to handle both. TODO(CTO).
- **Onboarding (zero to hello world):** TODO(CTO).
- **Would we use it again:** TODO(CTO).

## Web Speech API

- **What we used it for:** voice in (`SpeechRecognition` / `webkitSpeechRecognition`, `en-US`, interim results)
  and voice out (`speechSynthesis`, preferring a natural en-GB or en-US voice).
- **What worked:** no dependencies, and interim results make the page feel responsive.
- **What needs work:** recognition only works in Chromium-based browsers (and Chrome sends audio to Google), so
  the page needs a typed fallback; in headless Chromium the speaking state lingers, so the screenshot tests cancel speech.
  TODO(CTO).
- **Onboarding (zero to hello world):** TODO(CTO).
- **Would we use it again:** TODO(CTO).
