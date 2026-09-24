# MCP Apps authority layers — evidence

Supports `docs/agents/assistant-providers.md` § "MCP client input and deprecated compatibility". The BST-1571 app-originated tool-call authority, host surface, and packaged verifier.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2887-2950); append rather than
rewrite.

---

BST-1571 adds the still-unregistered app-originated `tools/call` authority.
`McpAppToolCallAuthority` accepts only app-visible tools owned by the exact
server generation, holds every `ask` decision until its opaque host consent id
is approved, and releases provenance on denial, cancellation, failure, or
close. Each call also receives an authority-generated, generation-bound
preparation id and a required release callback before preparation starts. The
authority awaits that one-use release before settling denial or cancellation,
including cancellation after a broker prepared the ordinary executor but before
its response arrived. The `@brainstrike/agent` runtime captures an Apps admission capability
from its post-plan/post-permission/post-storage tool map. The preparer accepts
that admission capability instead of policy or invocation inputs, so it cannot
recreate or bypass ordinary admission or pair one decision with another
server/action executor. Admission returns an opaque one-use executor bound to
the exact post-gate tool entry and exact server/tool identity. The executor is
captured before artifact/model projection; a private in-memory marker on the
authority-owned abort signal preserves the complete App-facing
`CallToolResult` through the transport and temporary preview wrappers,
including canonical server-domain errors with `isError: true`, their content,
and `_meta`. Only transport/execution failures enter the ordinary guard's
sanitized error wrapper. Calls
absent from the ordinary map fail visibly; admitted calls use the already-bound
guard, Pre/PostToolUse hooks, and execution-duration telemetry exactly once,
and replay fails before a second execution. Apps telemetry contains only tool
name, outcome, and duration—never input, output, or app context. This is
infrastructure, not capability graduation: production Apps registration and
advertisement remain disabled; BST-1572 owns release enablement.

The BST-1571 host surface lives in the browser adapter package
`@brainstrike/mcp-app-host-ui` inside assistant-experience, not in the shared
foundation UI layer and not as a global or auto-mounted renderer. The
`@brainstrike/mcp-app-host` core remains NodeNext-compatible and React-free, so
agent-side Apps authority imports do not load renderer code. The surface's
closed state union renders loading, ready, sanitized error-code, cancelled, and
completed states without accepting raw error text. App-originated `ask` calls
render one focus-trapped `alertdialog` at a time, expose only the owned tool
name and risk category, and never render arguments or results. Allow and Deny
act on the authority's opaque consent id; tab/shift-tab stay inside the dialog,
Escape denies, and settlement restores focus to the host-provided recovery
target. The sandbox slot is inert and hidden from assistive technology while
consent is open. This surface still does not register or advertise MCP Apps in
production.

The BST-1571 packaged verifier launches the exact electron-builder output,
queries the live main process for `app.isPackaged === true`, and drives its
dedicated verifier window over Chromium CDP. That window composes the production
provenance authority, object-URL sandbox owner, opaque frame bridge, tool-call
authority, and accessible host surface. The sandboxed fixture uses the pinned
SDK's `App` and `PostMessageTransport` and validates the canonical initialize
result. A sibling dedicated sandbox WebContents proves the packaged Electron
policy denies popup escape and that lease teardown destroys that WebContents;
the policy is deliberately not attached to the host renderer, where it would
block the host-owned object-URL frame. App-originated `tools/call` traffic
crosses the real frame listener and reaches a loopback HTTP request/response;
host RPC responses return to the app. Completion, replacement, disconnect,
shutdown, denial, server failure, protocol failure, and timeout must release all
frames, object URLs, RPC callbacks/timers, consent listeners, calls, HTTP
requests, sockets, and the packaged child process. The verifier-only loopback broker
keys each prepared executor by the authority preparation id; execute or explicit
release consumes exactly that entry. Repeated denial and prepare-response
cancellation assert zero pending entries before generation teardown, so the
generation-wide release remains only a final shutdown assertion. Production uses
the IPC authority below and never imports this E2E implementation.
The `Native Electron Package` job runs this proof through
`test:e2e:lane:packaged-mcp-apps` against the artifact it just built.
