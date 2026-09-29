# MCP client extension registry — evidence

Supports `docs/agents/assistant-providers.md` § "MCP TRANSPORT SELECTION (CRITICAL)". The registration contract, the HTTP header bridge, and the dispatch ledger and its scope.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2405-2481); append rather than
rewrite.

---

Client extensions are host capabilities, not transport defaults. Both explicit
clients start with an empty `McpClientExtensionRegistry`, so the initialize
request omits `capabilities.extensions` unless the host registers an extension.
A registration must name the exact extension contract revision, pass that
contract's strict settings parser, and satisfy its complete-implementation
predicate before the registry will project it. Invalid versions, malformed
settings, duplicate registrations, and incomplete implementations throw; the
registry never advertises a partial implementation or silently drops one.

Registered extension requests are a separate closed dispatch surface: the host
must provide an exact request contract with Standard Schema params/results and
an explicit compatibility predicate for strictly parsed client/server settings.
The registry seals immutable settings and method snapshots before a connection
advertises them; late registration, valid post-connect settings mutation, and
contract mutation cannot diverge dispatch from advertised capabilities. Active
core/lifecycle namespaces and notifications are never eligible for the bridge.
The explicit clients expose this surface only on the exactly negotiated
`2026-07-28` revision; every other revision and unregistered method fails before
transport dispatch. The released client SDK still treats historical
extension methods that collide with retired core vocabulary as core-era methods,
so Brainstrike routes only registered contracts through a non-colliding internal
method and rewrites that method on its owned HTTP/stdio transport immediately
before serialization. Incoming result rewriting is installed before transport
start, follows the SDK's current handler across reassignment, and fails visibly
if a message arrives before the SDK handler exists. This is not an arbitrary
custom-method escape hatch and does not patch the SDK dependency.

The HTTP header bridge (`applyRegisteredExtensionHttpHeaders`) acts only on
registered-extension requests and passes every other request through untouched:
bodiless GET/DELETE, legacy-era core traffic without `Mcp-Method`, and the
SDK's 401/403 re-auth re-sends of core requests. An exclusive extension wire
method (`tasks/get`, `tasks/update`, `tasks/cancel`) is registered by shape
alone. `tools/call` is the one wire method the registry shares with core (the
Tasks result augmentation), so a `tools/call` counts as registered only while
its request id sits in the client's dispatch ledger, which the transport `send`
wrapper fills exactly when it rewrote the internal method (BST-1566 enablement
regression: every desktop stdio/streamable-http connection now carries a
registry, and a core legacy `tools/call` was rejected as a header mismatch). A
malformed or header-disagreeing REGISTERED request still throws.

`RegisteredExtensionDispatchLedger` is that one dispatch state, and it carries
the second fact only the raw-wire seam can see (BST-1596): the unstripped
`notifications/subscriptions/acknowledged` payload for a claimed
`subscriptions/listen` request. The SDK settles `McpSubscription.honoredFilter`
from the CORE `SubscriptionFilter` schema, which drops every extension field, so
an extension lease cannot otherwise learn which ids the server honored. A
consumer claims a capture with `captureSubscriptionAcknowledgement(filter)`
BEFORE calling `listen()`; the bridge's `send` wrapper binds that claim to the
listen request id by filter object identity (the SDK forwards the caller's
filter object untouched), and its incoming hook records the raw payload against
`_meta['io.modelcontextprotocol/subscriptionId']`. The registry still refuses a
contract for `notifications/subscriptions/acknowledged` itself — the SDK
consumes that notification before custom handlers — and this capture does NOT
consume it. Do not add a second dispatch substrate for raw-wire observation;
extend this ledger.

Ledger LIFETIME differs by transport and the ledger is not allowed to care:
stdio allocates one per connection, while HTTP builds its header-preserving
fetch once per CLIENT, so the ledger that fetch queries outlives every transport
the client installs (reconnect, session reset, auth step-up retry each build a
new one). Ownership therefore lives in a per-transport
`RegisteredExtensionDispatchScope` that `installRegisteredExtensionDispatch`
opens, and transport close clears only THAT scope — never the whole ledger
(review of #2928). A shared clear would drop a sibling transport's in-flight
`tools/call` id, and the fetch bridge would then classify it as core traffic and
throw a method/header mismatch, or drop a live subscription claim so the lease
fails as `never observed on this connection`. Subscription ids are JSON-RPC
request ids, which restart on every new connection, so they are unique only
inside one scope; never key raw-wire state by request id at ledger scope.

| Client extension | Canonical contract/settings | Brainstrike host surface | Advertised |
| --- | --- | --- | --- |
| MCP Apps (`io.modelcontextprotocol/ui`) | Stable spec `2026-01-26`; `mimeTypes` is required and its currently defined value is `text/html;profile=mcp-app` | Registered (BST-1572): the default desktop registry, dedicated Electron sandbox startup, generation-fenced resource reader, validated frame bridge, thread-keyed ordinary admission authority (live run, then run-detached host-port execution), and visible-UI IPC consent path form one complete host | Yes by default (stdio, streamable-http); off when either dial says so (BST-1604); sse: not registered |
| MCP Tasks (`io.modelcontextprotocol/tasks`) | Empty capability settings; task results, polling, mid-flight input, durable handles, cancellation, and optional subscription notifications are one complete contract | Registered (BST-1566): `createDefaultMcpExtensionRegistry` installs the exact get/update/cancel, task-result, routing-header, and notification-lease wire contracts on every stdio and streamable-http connection, and `McpDesktopTaskHost` runs the durable repository/lifecycle/interaction/presentation chain per negotiated generation; the legacy `sse` transport gets no registry | Yes by default (stdio, streamable-http); off when either dial says so (BST-1604); sse: not registered |
| OAuth Client Credentials (`io.modelcontextprotocol/oauth-client-credentials`) | Empty capability settings plus complete client-secret or private-key JWT token acquisition and refresh | Disabled: Brainstrike's product path is interactive user authorization, so no machine-to-machine credential host is registered | No |
| Enterprise-Managed Authorization (`io.modelcontextprotocol/enterprise-managed-authorization`) | Empty capability settings plus the complete enterprise IdP/ID-JAG exchange | Disabled: Brainstrike has no managed-enterprise authorization product surface or registered implementation | No |

