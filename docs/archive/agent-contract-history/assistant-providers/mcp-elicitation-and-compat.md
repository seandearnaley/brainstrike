# MCP elicitation and deprecated compatibility — evidence

Supports `docs/agents/assistant-providers.md` § "MCP client input and deprecated compatibility". The capability runtime, the elicitation consent surface, and the compatibility-only surfaces.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2797-2886); append rather than
rewrite.

---

Core client capabilities are installed through the one `McpClientCapabilityRuntime`
used by both explicit HTTP and stdio clients. The runtime projects a capability
only when its complete handler is present; no handler means no declaration and
an inbound request fails through the SDK's missing-capability path. Modern
`input_required` and legacy pushed requests dispatch through those same SDK
`setRequestHandler` registrations. Automatic fulfillment is enabled with a
Brainstrike cap of eight rounds (below the SDK's ten-round ceiling), so the SDK
keeps opaque `requestState`, cancellation, request metadata, progress, and the
originating tool call/approval context on one invocation. Round exhaustion and
malformed requests stay visible SDK errors.

The desktop host's production capability resolver (BST-1584) advertises exactly
`{ elicitation }` — form and URL modes backed by the process-local presenter
authority through `createMcpElicitationCapability(elicitationPresenter.presenter)`
with the default `https-only` URL policy — so both HTTP and stdio constructor
option objects carry `clientCapabilities.elicitation` for every connection.
Roots, sampling, and protocol logging remain absent. An explicit
`resolveClientCapabilities` dependency (the conformance client injects its own)
replaces this default wholesale; a resolver that returns `undefined` yields
capability-free options exactly as before. The input-required policy stays the
SDK automation policy `{ autoFulfill: true, maxRounds: 8 }`, so a modern
`input_required` round dispatches through the same presenter as a legacy pushed
`elicitation/create`.

Desktop main owns one process-local elicitation presenter authority. An explicit active-invocation
registry binds only a single matching server operation and rejects ambiguous concurrency; no async
context or untrusted MRTR `requestState` supplies authority. Grants are weak, settlement is once-only,
and actor retirement covers failure, replacement, reset, disconnect, and close.

The consent surface is one IPC seam plus one app-wide modal:

- `apps/desktop/src/mcp/elicitation-bridge.ts` attaches the presenter's single
  listener once per `registerMcpIpcHandlers` lifetime and broadcasts every
  presentation (`mcp:elicitation:requested`) and every finalization
  (`mcp:elicitation:retired`, `{ id, code }` — settlement, caller abort,
  generation retirement, detach, close) to every live `BrowserWindow`. The
  renderer answers through the `mcp:elicitation:settle` invoke; the payload is
  parsed by `parseMcpElicitationSettlement` (`@brainstrike/assistant-contract`,
  strict keys, `content` only with `accept`, safe-integer `generation`) before
  it reaches `settle()`, and presenter failures surface as a code-only
  `McpElicitationBridgeError` — no cause detail crosses the bridge.
- Detaching the bridge (handler unregistration) rejects every pending
  presentation with `mcp-elicitation-presenter-unavailable`; with no listener
  attached an inbound request fails closed the same way. There is no auto-accept.
- `McpElicitationHost` (`@brainstrike/settings-ui`, mounted app-wide in
  app-shell's root layout beside the shell routes) resolves the three bridge
  members by capability, queues presentations oldest-first, and renders one
  `McpElicitationDialog` at a time. The dialog is non-dismissible (no corner
  close, Escape and outside clicks ignored), names the provenance in its
  accessible title/description (server identity, website origin, operation and
  target, transport, negotiated revision), renders the restricted form schema
  with labelled controls and a client-side mirror of
  `validateMcpElicitationResult` (never a replacement — main and the SDK
  re-validate), shows a URL request's full URL verbatim, and focuses Decline
  by default. Accept on a URL request records a one-use grant; only main opens
  the browser, and only after that accept. A retired presentation swaps the
  actions for an explanation naming the code plus Dismiss.

Elicitation has independently declared form and URL modes. The host presenter
must render the SDK-validated restricted form schema and return exactly
`accept`, `decline`, or `cancel`; the SDK validates accepted content against the
requested schema before retry. URL requests are bounded, restricted to HTTP(S)
without embedded credentials, shown to the presenter in full, and opened only
after its explicit `accept`. Decline/cancel never call the external opener.

Roots, sampling, and protocol logging are compatibility-only and independently
disabled by omission for every server. Enabling roots requires a snapshotted
list of explicit `file:` URIs from the mounted-workspace/server configuration
authority. Roots are advisory hints, never filesystem grants, and
`listChanged` is advertised only when the caller also owns change emission.
Sampling requires an explicit per-server handler; no handler means the
capability is structurally absent. The handler receives only the server's
validated sampling request and the outer abort signal, so a product adapter
must use the already-selected Brainstrike provider/model and limits and must not
append conversation history. Protocol logging requires an explicit minimum
level and sink; entries are capped at 32 KiB, sensitive-key values are redacted,
and remote `logger`/data fields remain payload under the fixed local server
scope rather than becoming Brainstrike logger scopes.

These three surfaces were deprecated in MCP `2026-07-28`. Review them for
removal on 2027-07-28 (the specification's earliest-removal boundary); each can
be removed or disabled without changing elicitation or the other compatibility
surfaces.

MCP Apps may register only after one reviewed implementation proves every
graduation gate together: supported MIME declaration, `ui://` resource loading,
tool/result association, isolated sandbox and enforced CSP, validated
bidirectional messages, permission/consent, lifecycle cleanup, and renderer
tests. A partial or text-only host never advertises the extension.

