# Production Tasks host — evidence

Supports `docs/agents/assistant-providers.md` § "Production Tasks host". The extension-registry seam, request-option parity, and the wedged-transport invalidation rule.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2606-2665); append rather than
rewrite.

---

Extension registration is a host-runtime seam:
`DesktopMcpHostRuntimeDependencies.resolveExtensionRegistry(server, context)`
(defaulted like `resolveClientCapabilities`) runs once per connection
generation and must return a FRESH `McpClientExtensionRegistry` each time — a
registry seals on its first projection, so one instance can never serve two
connections. The production default `createDefaultMcpExtensionRegistry`
calls `registerMcpTasksWireContracts` for `stdio` and `streamable-http` and
returns `undefined` for legacy `sse` (it never negotiates `2026-07-28`, so it
is not advertised rather than advertised-and-refused). The registry is threaded
into both explicit clients' `extensionRegistry` option and into
`McpCoreServerFeatures`, which routes `tools/call` through
`requestExtension(MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT)` whenever the registry
registers Tasks and the server advertises the extension: on the pinned client
a core `callTool` answer with `resultType: 'task'` is rejected by the SDK
funnel, so a task can only arrive on the registered path. That path takes
exactly `{ name, arguments }`; an operation carrying `_meta` or `task` throws.
Both dispatch paths receive the same SDK request options (`onprogress` from the
invoke's `onProgress`, `resetTimeoutOnProgress: true`, the merged signal):
`requestExtension` hands them straight to `client.request`, so progress and the
timeout reset behave identically whichever path the advertisement selects.

`resetTimeoutOnProgress` re-arms the SDK's 60s request timeout on EVERY progress
notification, so only `normalizeMcpRequestOptions`' `maxTotalTimeout` (default
600 000 ms) bounds a chatty server. The CALLER'S SIGNAL is therefore the real
deadline: the agent's per-tool execution guard aborts it when it gives up (see
`docs/agents/assistant-runtime.md`, "Per-tool guard"), which makes the SDK
withdraw the request (`notifications/cancelled`) instead of leaving the POST
open for the remaining absolute budget. Correspondingly, `McpServerActor`
does NOT retire a generation for an `operation`-category failure
(`mcp-request-timeout`, `mcp-input-rounds-exhausted`,
`mcp-list-pagination-exceeded`): those describe the CALL, not the transport, and
retiring on them turned one slow tool call into a server the user later found
disconnected (BST-1594). Every other category still poisons the generation
immediately.

**The one bounded exception is a transport that stops answering at all.**
`mcp-request-timeout` is the only operation code that is AMBIGUOUS — the SDK
gave up WITHOUT an answer, which is what a merely slow server and a wedged
stdio child or black-holed HTTP endpoint both look like — and nothing else in
the actor probes liveness: `onUnexpectedClose` fires only when the transport
actually CLOSES, and there is no ping or health probe. `McpServerActor`
therefore counts CONSECUTIVE unanswered `mcp-request-timeout`s and, at
`MCP_WEDGED_TRANSPORT_TIMEOUTS` (2), INVALIDATES the transport instead of
merely failing the call. Any answer of any kind resets the counter to zero — a
successful result, and equally `mcp-input-rounds-exhausted` or
`mcp-list-pagination-exceeded`, which the server had to respond to produce. A
caller-side cancellation (the agent's per-tool execution guard) never reaches
the counter, because the caller-abort check rejects first; only the SDK's own
request bounds feed it. Invalidation is the state `McpHostService.invoke`
already SELF-HEALS by building a fresh generation on the next call, so a dead
server reconnects on its own rather than staying permanently and silently
`connected`. One slow call still retires nothing. Pinned by
`apps/desktop/src/__tests__/main/mcp-server-actor.test.ts` (both halves: the
retirement AND the streak resets), `mcp-host-service.test.ts` for the self-heal
replacement, and, over a real spawned stdio child,
`apps/desktop/src/__tests__/main/mcp-progress-cancellation.integration.test.ts`.
A later MCP Apps host registers onto the same fresh registry from this seam.
`apps/desktop/src/__tests__/main/mcp-host-runtime-tasks.test.ts` pins that the
real default resolver advertises exactly the support matrix's supported
extension ids, AND that each dial's off state advertises exactly the remainder.
