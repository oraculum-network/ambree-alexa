# Friction log

Real snags we hit building this with the MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.32.1, zod 4), the
MCP spec 2025-11-25 and their docs. Each entry: what happened, the time it cost, and a suggestion.

## 2026-10-15: an unknown tool name comes back as `isError`, not a protocol error

- **What happened:** the spec (2025-11-25, tools, error handling) lists "unknown tools" under protocol errors.
  `McpServer`'s `tools/call` handler throws `McpError(InvalidParams, "Tool X not found")` and then catches every
  error except `UrlElicitationRequired` and returns it as a `CallToolResult` with `isError: true`. A client
  therefore can't tell "this tool doesn't exist" from "this tool ran and failed". The JSON-RPC message also
  repeats the code ("MCP error -32602: …") once you do throw it.
- **Time lost:** about 25 minutes (reading `server/mcp.js`, then choosing a workaround).
- **Workaround:** after registering the tools we wrap the SDK's own `tools/call` handler (it lives in a private
  `_requestHandlers` map) and throw -32602 for names we don't know, including non-string names. We throw a plain
  `Error` with a numeric `code`, because `McpError` puts "MCP error -32602:" into its own message and the SDK sends
  that message as it is. `src/mcp/server.ts` fails at startup if the map ever moves.
- **Suggestion:** let `McpError`s with protocol codes (or at least "tool not found") propagate as JSON-RPC
  errors, or add an option for it; and expose a supported hook to wrap request handlers.

## 2026-10-15: `registerTool` has no `icons`, so `tools/list` drops them

- **What happened:** 2025-11-25 adds `icons` to `Tool`, and the SDK's `ToolSchema` accepts it, but
  `registerTool`'s config has no `icons` field and the `tools/list` handler builds each tool from a fixed set of
  fields. `serverInfo` icons, `description` and `websiteUrl` work fine.
- **Time lost:** about 10 minutes.
- **Workaround:** the same handler wrapper adds `icons` to each listed tool.
- **Suggestion:** accept `icons` in `registerTool` (and `registerPrompt` / `registerResource`) and pass it through.

## 2026-10-15: DNS-rebinding options are deprecated, and the replacement is Express-only

- **What happened:** `StreamableHTTPServerTransport`'s `allowedHosts`, `allowedOrigins` and
  `enableDnsRebindingProtection` are marked deprecated ("use external middleware"). The SDK's
  `hostHeaderValidation` middleware is an Express `RequestHandler`, so a plain `node:http` server has nothing to use.
- **Time lost:** about 10 minutes.
- **Workaround:** our own Origin and Host checks (`src/http/origin.ts`), port-agnostic like the SDK's middleware.
- **Suggestion:** ship a framework-neutral helper, e.g. `validateHost(hostHeader, allowed)` and
  `validateOrigin(originHeader, allowed)`, that any server can call.

## 2026-10-15: tool schemas are emitted as JSON Schema draft-07

- **What happened:** with zod 4, `tools/list` emits a draft-07 `$schema` URI for both input and output schemas,
  while 2025-11-25 makes 2020-12 the default dialect (SEP-1613). It's valid (the dialect is explicit), but it
  surprised us, and there is no option to pick the target: `registerTool` calls its converter without one.
- **Time lost:** about 5 minutes at first; about 20 more on the second day to list 2020-12 instead and to check
  that the SDK client still validates.
- **Workaround:** the `tools/list` wrapper replaces each tool's `inputSchema` and `outputSchema` with
  `z.toJSONSchema(schema, { target: "draft-2020-12", io })`, generated once from the same zod schemas. The SDK's
  own validation (zod, server side) is untouched. The SDK client validates `structuredContent` with Ajv's default
  (draft-07) class, created with `validateSchema: false` and `strict: false`, so it compiles a schema that declares
  2020-12; ours only use keywords that mean the same in both dialects, and a test checks that the client's
  validator accepts real results and rejects broken ones. We didn't hit it, but a 2020-12-only keyword such as
  `prefixItems` would be silently ignored by that client.
- **Suggestion:** emit 2020-12 by default for the 2025-11-25 protocol (or take a target option), and have the
  client pick Ajv's 2020-12 class when a schema declares it.

## 2026-10-15: a malformed `tools/call` becomes -32603 with a raw ZodError dump

- **What happened:** `tools/call` with `arguments` that isn't an object (`"arguments": "x"`) fails the SDK's
  request schema inside `setRequestHandler`'s parse. The error is a bare ZodError with no `code`, so it goes out as
  -32603 (Internal error) and its message is the JSON array of zod issues, where -32602 (Invalid params) and one
  line of text would be right.
- **Time lost:** about 10 minutes.
- **Workaround:** the `tools/call` wrapper maps an error with `issues` to -32602, "Invalid tools/call request:
  params.arguments: Invalid input: expected record, received string".
- **Suggestion:** turn request-schema failures into -32602 with a short message in `Protocol`.

## 2026-10-15: input-validation `isError` text carries a JSON-RPC prefix

- **What happened:** SDK 1.32.1 already follows SEP-1303 (a schema failure is an `isError` tool result, not a
  JSON-RPC error). The text reads "MCP error -32602: Input validation error: Invalid arguments for tool X: …",
  which mixes a protocol code into a message meant for the model.
- **Time lost:** about 5 minutes.
- **Workaround:** the handler wrapper trims it to "Invalid arguments for X: …".
- **Suggestion:** drop the `MCP error -32602:` prefix from tool-result text.

## 2026-10-15: the client opens a GET stream against a stateless JSON server

- **What happened:** after `initialize`, the SDK's `StreamableHTTPClientTransport` sends `GET /mcp` to open an SSE
  stream. Our stateless server answers 405 (as the spec allows) and the client copes, but every agent turn adds a
  405 to the logs.
- **Time lost:** about 5 minutes (we spotted it in the request logs and traced it in the client code).
- **Suggestion:** a client option to skip the standalone GET stream, or skip it when the server never set a
  session id.

## 2026-10-15: the negotiated protocol version isn't on `Client`

- **What happened:** to assert that `initialize` negotiated `2025-11-25` we had to read `protocolVersion` from the
  transport (`client.transport`, typed as the generic `Transport`, so it needs a cast). `Client` exposes server
  info, capabilities and instructions, but not the version.
- **Time lost:** about 5 minutes.
- **Suggestion:** add `client.getProtocolVersion()`.
