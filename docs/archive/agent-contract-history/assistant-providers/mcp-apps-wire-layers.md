# MCP Apps disabled wire layers — evidence

Supports `docs/agents/assistant-providers.md` § "Production Apps host". The BST-1567 to BST-1570 projection, provenance, sandbox and frame-bridge layers.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 3101-3198); append rather than
rewrite.

---

BST-1567 owns the disabled Apps wire-contract projection from the immutable
`@modelcontextprotocol/ext-apps@1.7.5` schema and stable `2026-01-26` spec. It
accepts all 15 stable `ui/*` methods plus `tools/call`, `resources/read`,
`notifications/message`, and `ping`; package-only `ui/download-file` and
`ui/notifications/request-teardown` are rejected. The package schema defines
empty `ui/resource-teardown` params while the prose example includes a reason.
Brainstrike follows the machine schema and rejects the reason-bearing variant
until upstream reconciles the conflict. `ping` and `tools/call` are accepted
in both directions (either peer may ping; the host calls an app-declared
tool). JSON-RPC uses string or safe-integer IDs, exact envelopes, one-shot
correlation, 256 pending entries, 256 KiB messages, depth/node caps,
2,048-character URIs, and 32-entry/64 KiB metadata. An error response may
carry `id: null` as JSON-RPC 2.0 §5 requires when the responder could not read
the request id; it parses (for diagnostics) but never settles a pending
request. The correlator releases a slot when the reply to it fails validation,
exposes `cancel(id)` for an abandoned request (timeout, abort, send failure),
and `clear()` for transport close, so a misbehaving app cannot wedge the
256-entry bound. The parse-time size bound is defense in depth: the bridge
layer (BST-1570) bounds raw `postMessage` payloads before parsing. These inert
parsers do not register Apps support or provide resource, sandbox, frame, or
consent behavior.

BST-1568 adds the next disabled contract layer: one in-memory provenance
authority issues opaque handles for an authenticated server identity and its
monotonic connection generation. Tool `_meta.ui`, effective app/model
visibility, associated resource, tool input, and tool result remain attached to
that authority-owned generation. A replacement generation retires every prior
handle; duplicate tool names and concurrent type-sensitive request IDs fail
closed within the generation. `retireGeneration` is the explicit teardown for a server that disconnects
without a replacement; it keeps the latest generation number so a reconnect
must open a strictly greater one. A resource's `_meta` is read like a tool's:
`ui` is parsed when present and namespaced sibling keys are ignored. A settled
tool result carries the audience that issued the call. Resource resolution requires the owning tool and
generation,
the exact associated `ui://` URI and Apps MIME type, exactly one non-empty text
or canonical base64 body, fatal UTF-8 decoding, and at most 1 MiB decoded HTML.
Result settlement is one-shot. This authority does not infer ownership from a
URI or tool name and does not register Apps, fetch resources, render content,
or implement a frame, sandbox, consent, or approval path.

BST-1569 adds the disabled renderer boundary. One host-owned object URL contains
a shell whose only child is an opaque-origin `srcdoc` iframe with
`sandbox="allow-scripts"`; same-origin, popup, download, top-navigation, form,
object, and worker privileges remain absent. Validated Apps metadata constructs
the resource CSP (each declared source is rejected if it carries a CSP
delimiter or quote), and the shell carries that policy verbatim: the srcdoc app
inherits the shell's policies and CSP combination only narrows, so a shell
policy tighter than the app's would deny the app its declared sources, while
Chromium exempts the srcdoc load itself from `frame-src`. The host owns the
doctype so the app renders in standards mode with the CSP ahead of its bytes.
Requested camera, microphone, geolocation, and clipboard permissions are
recorded rather than granted until a later consent contract exists. Each owner permits at most eight active frames and 4 MiB of retained
shell HTML; the prior provenance layer independently caps decoded HTML at 1 MiB.
The Electron adapter requires a dedicated session, denies window creation,
navigation, redirects, webviews, downloads, and all permission checks/requests.
Session-scoped denials are installed once per session and never restored to
Electron's permissive defaults (a lease's close cannot fail a sibling open);
teardown removes the per-WebContents hooks, destroys the WebContents, clears
session cache/storage once the last lease closes, and revokes the owner URL.
Installation is failure-atomic: a partial hook registration closes the
WebContents and rolls back every per-WebContents listener (session denials
installed so far stay, and a retry installs only the missing ones); when the
rollback itself fails, `McpAppElectronSandboxInstallationError` carries a
`cleanup` lease that retains ownership. Teardown is retryable: each step
records its own success, failures aggregate into one error, per-WebContents
hooks are released only after the WebContents closes, and URL revocation keeps
frame and retained-byte ownership until it succeeds. Real Chromium and Electron adversarial
verifiers pin those boundaries and repeated cleanup; the Chromium verifier is
a `*.browser.test.ts` file run by the package's `test:browser`
script in the Browser tests lane (Playwright image), never in the Unit lanes. Nothing registers this
sandbox, advertises Apps, or implements app RPC, consent, or production UI.

BST-1570 adds the still-disabled frame bridge. A bridge binds exactly one
opaque-origin frame source and one live monotonic generation, requires the
`ui/initialize` response plus `ui/notifications/initialized` handshake before
normal dispatch, and applies the stable Apps/standard message parsers in both
directions. Source or origin mismatches are reported and ignored without giving
an unrelated frame a teardown primitive; malformed, unknown, replayed, or stale
traffic from the bound frame fails that channel closed. Requests and
notifications use bounded pending sets, owned deadlines and abort listeners;
request IDs are type-sensitive and one-shot, and correlated errors are safe.
Every successful response is validated against the exact originating request
method before it is posted or settles a correlated caller. The mapping uses the
pinned Apps result schemas for initialize, link, message, display-mode, and
teardown requests, plus the pinned MCP Core result schemas for `tools/call`,
`resources/read`, `ping`, and the empty `ui/update-model-context` result; there
is no generic-record success path.
Replacement, disconnect, close, or a bound-frame protocol failure aborts every
inbound callback, rejects every outbound request, clears every timer, removes
the message listener, and retires all request IDs. Real opaque-origin Chromium
and electron-builder-packaged Electron verifiers pin replacement, failure,
disconnect, and close quiescence; the packaged verifier asserts
`app.isPackaged === true`. This bridge still does not own resources or consent,
register Apps support, or expose a production renderer surface.
The packaged Electron verifier for the bridge runs only through
`test:e2e:lane:packaged-mcp-apps-bridge` in the Native Electron Package job;
its harness document lives in the disposable user-data directory and imports
the bridge module by absolute file URL, never from a published `dist/`.
