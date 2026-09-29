# MCP transport and startup rules — evidence

Supports `docs/agents/assistant-providers.md` § "Production Apps host". Per-transport construction rules, bearer auth, lifecycle ownership, and the SEP-2322 pre-codec mapping.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 3200-3315); append rather than
rewrite.

---

Desktop Settings consumes the singleton `DesktopMcpHostRuntime`'s browser-safe
`McpHostSnapshot` through `mcp:status:get` and revisioned
`mcp:status:updated` events. Renderer state accepts only strictly newer
revisions, tool presence never implies connection success, and connected or
failed zero-tool servers plus negotiation/config errors remain visible.

Startup policy is explicit per configured server: `automatic` permits one
bounded machine connection attempt during discovery, while
`authentication-required` publishes an actionable status without constructing
the transport when no reusable native OAuth credentials are stored. A stored
native HTTP OAuth grant starts disconnected and participates in app-load tool
discovery, reconnecting with the existing SDK token/refresh flow under the
ten-second machine deadline. This automatic attempt cannot open a browser;
only explicit host controls grant interactive authorization to the provider.
If login is needed, the attempt closes its transport/provider and returns to
authentication-required, without retrying on every assistant request. Its safe
error directs the user to Settings > AI Tools instead of a generic actor error.
`connect`, `retry`, `cancel`, `disconnect`, and `reauthorize` are explicit host
controls; user-paced authorization is not governed by the automatic ten-second
machine deadline. An explicit Connect arriving during a background attempt reuses
its success, or continues an authentication-required failure with a fresh
interactive provider after cleanup. It never retries cancellation, transport, or
cleanup failures. Omitted connection modes use the same non-interactive deadline
and provider policy as explicit false. Auth projection is awaited during config
staging before actor construction. Stdio stderr is piped through the SDK's
early-created stream, line-bounded and secret-redacted before it reaches the
server snapshot. Healthy stderr remains a session-only debug signal. On connect
failure or unexpected child exit, the host emits at most one durable `warn` per
server generation containing only the last five sanitized diagnostics plus an
honest omitted count; the per-server snapshot remains a 20-entry session ring.
Raw child stderr never enters either path.

Remote transport rules:
- `stdio` constructs only the official SDK's `StdioClientTransport`. The SDK
  inherits its documented safe environment allowlist and overlays only the
  explicitly configured `env`; spawn/connect failures remain visible. An
  unexpected child exit invalidates only that owned connection: the interrupted
  request fails without replay, and the next operation may start a fresh child.
- `streamable-http` is the modern MCP transport and normally targets one `/mcp`
  endpoint. It constructs only the official SDK's
  `StreamableHTTPClientTransport`.
- `sse` is the deprecated HTTP+SSE compatibility transport. It constructs only
  `SSEClientTransport`, even when its URL ends in `/mcp`.
- Interactive OAuth completion (`authorizationCallbackSource`) and OAuth scope
  step-up (`maxStepUpRetries`, `onInsufficientScope`) are Streamable-HTTP-only.
  Configuring any of them with `transport: "sse"` throws at client construction
  naming the unsupported combination; the SSE transport never silently drops
  them. Adding either capability to legacy HTTP+SSE is out of scope (BST-1605).
- `authorizationCallbackTimeoutMs` only ever applies while building the
  interactive completion, which a missing `authorizationCallbackSource` skips,
  so passing it alone throws on EVERY transport rather than being accepted and
  ignored. The guard is not SSE-specific: the same orphan option on
  `streamable-http` is refused for the same reason.
- There is NO automatic Streamable HTTP → SSE fallback. The MCP specification
  describes that fallback as an OPTIONAL compatibility strategy for ambiguous
  URLs; Brainstrike removes the ambiguity by requiring the user to select the
  transport. A 400/404/405 initialization failure therefore remains visible.
- Both HTTP variants share strict HTTP(S)-URL, no-embedded-credentials, header,
  secret-decryption, cancellation, progress, and lifecycle behavior.
- External bearer auth is desktop-main-only and reference-based. JSONC carries
  exactly `{ type: "bearer", credential: { store: "mcp-credentials", id:
  <uuid> } }`; the UUID maps to the `mcp-credentials:<uuid>` slot in the
  existing safeStorage-encrypted `SecretsService`. The renderer-visible host
  snapshot projects only `malformed | missing | stored | unreadable`. Its
  initial projection enumerates storage keys without decrypting credentials;
  the final owned fetch boundary validates the token and publishes the current
  state back to the actor snapshot. The credential authority resolves the
  token for every owned HTTP request and injects
  `Authorization: Bearer …` only after proving that the request origin equals
  the configured resource origin and that no competing Authorization header
  exists. The host runtime, config projection, actor context, status, logs,
  diagnostics, and errors receive no token. Missing, unreadable, malformed,
  cross-origin, and conflicting-auth states fail with fixed codes and static
  messages; no fallback to unauthenticated transport occurs. Ordinary
  disconnect closes the transport but retains the externally managed secret.
  Factory reset clears the shared SecretsService, and request-time resolution
  means no connected fetch closure can retain the cleared bearer.
- HTTP lifecycle ownership is explicit. `client-owned` connections invalidate,
  close, reconnect once, and replay only a reconnectable session failure.
  `host-owned` connections invalidate and close locally without replay; the
  triggering operation keeps its original transport failure, new operations
  may create a fresh connection, and the host receives one isolated
  `onUnexpectedClose` notification. Observer throws and asynchronous
  rejections are diagnosed without replacing the transport failure. Explicit
  `close()` remains idempotent and owns all final local/session cleanup.

Both explicit clients install the shared client-capability engine before each
connection opens; desktop production supplies the presenter-backed elicitation
resolver above, and any other capability still requires an explicit resolver.
Each connection owns the returned lease and
closes it with the transport: active legacy pushed-handler work is aborted,
handlers are removed, settlement is awaited, and cleanup failures remain part
of the transport's aggregate close result. URL elicitation is validated by one
host assertion before consent and before opening: HTTPS without credentials is
the production rule, while HTTP requires the explicit loopback-development
policy. Accepted form content is host-validated for the SDK's `email`, `uri`,
`date`, and `date-time` formats. Arrays remain limited to the SDK's
enum/multiselect schema; unconstrained arrays are rejected by the SDK ingress
schema.

Final SEP-2322 defines an absent `resultType` as `complete` for backward
compatibility. Stable `@modelcontextprotocol/client@2.0.0` instead rejects that
shape on a 2026 connection, so both explicit transports install one immutable
pre-codec mapping for the absent discriminator. It applies only to positively
modern messages (pinned 2026, or `auto` after the SDK reports a negotiated
modern era), never mutates the parsed message, and leaves explicit core or
extension result kinds untouched for the SDK to validate. Before negotiation,
transport classification can positively identify modern traffic; otherwise
unclassified `auto` and legacy messages remain unchanged. Installation preserves
and delegates through the transport's existing `onmessage` descriptor, composes
both the SDK probe and production handlers, and recognizes probe-detach wrapper
restoration without stacking or recursion. A second installation with a
conflicting protocol or negotiated-era resolver fails visibly. Retire this
mapping only when the pinned SDK implements
the final SEP rule and the official `sep-2322-client-request-state` scenario
still passes.
