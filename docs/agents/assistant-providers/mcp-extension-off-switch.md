# Registered extension off switch — evidence

Supports `docs/agents/assistant-providers.md` § "Registered extension off switch". The two dials, how a flip advances generations, and what disabling removes.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 2669-2793); append rather than
rewrite.

---

Both registered extensions ship ON; two dials can turn one off without a new
build, and the effective state is `global AND per-server`:

- **Per-server**: an optional `extensions: { apps?: boolean, tasks?: boolean }`
  object in the MCP configuration document, alongside `transport` / `protocol`
  / `auth` / `startup`. An omitted key is enabled; an unknown key or a
  non-boolean value is a config validation error, never a coerced default.
- **Global**: `McpExtensionEnablement` persisted by main under
  `mcpExtensionPreferences.v1` in the `brainstrike-settings` electron-store
  (`apps/desktop/src/mcp/extension-preferences.ts`), reached from the renderer
  over `mcp:extensions:get` / `mcp:extensions:set` and pushed back on
  `mcp:extensions:updated`. A write persists BEFORE it reaches the live host,
  so a rejected write never leaves the process advertising a state the next
  launch would not reproduce. A stored value that cannot be parsed is
  `unreadable` and fails CLOSED — both extensions off — because the stored
  value is the only record of a deliberate opt-out.

`DesktopMcpHostRuntime` folds the global dials into every server's PRIVATE
definition (`applyMcpExtensionPreferences`) before staging, so a flipped dial
changes the affected servers' `configRef` and the replacement runs the ordinary
server-definition path: `taskHost.retired(id, 'server-replaced')` retires the
epoch before the old generation closes, the presenter authority is retired, and
`McpHostService` mints a new generation. A server whose effective state is
unchanged keeps its ref, its generation, and its live epoch — the dial advances
generations only for AFFECTED servers. `setMcpExtensionPreferences` goes through
the same replacement queue as `replaceResolvedConfig` and parses inside it, so a
malformed preference rejects that replacement and leaves the live dials alone.
Nothing mutates a live registry: the registry still seals before a connection
advertises, and the decision is made once per generation.

Disabling is absence, not degradation. With an extension off, `initialize`
carries no `capabilities.extensions` entry for it; with BOTH off the client is
constructed with no registry at all, so `capabilities.extensions` is omitted
entirely and every registered wire method fails before transport dispatch. An
Apps-only registry opens NO task session (`bindTaskHost` is gated on the sealed
Tasks capability), so `McpDesktopTaskHost.track()` still throws naming the
missing advertisement exactly as it does for a server that never advertised it —
that throw is the contract and must not be softened. `sse` remains unregistered
regardless of either dial.

The host snapshot carries the EFFECTIVE per-server state
(`McpHostServerSnapshot.extensions`, transport rule included), which is what the
settings support matrix and the per-server diagnostics render — never the
compiled-in default. The visible renderer subscribes to that snapshot
(`apps/desktop/src/renderer/use-mcp-apps-enablement.ts`) and feeds
`McpAppsEnablementProvider`, so turning Apps off unmounts every mounted app for
that server through its ordinary teardown (frame bridge close, tool-call
authority close, generation retirement, sandbox shell release) and the run-
detached admissions drop on the generation change the same replacement caused.
Factory reset clears the stored dials and returns the runtime to the shipped
default; a failed reset restores the captured dials with the rest of the
snapshot. Pinned by
`apps/desktop/src/__tests__/main/mcp-extension-preferences.test.ts`,
`ipc-mcp-extensions.test.ts`, `mcp-host-runtime-tasks.test.ts`,
`packages/mcp-app-host-ui/src/__tests__/mcp-app-tool-result.test.tsx`, and the
real-wire absence proofs in
`packages/agent/src/__tests__/mcp-modern-stdio-extension.integration.spec.ts`
and `mcp-modern-http-extension.integration.spec.ts`.

`McpDesktopTaskHost` (`apps/desktop/src/mcp/task-host.ts`) implements the
agent runtime's `McpTaskTrackingCapability` and the host runtime's connection
observer. It is constructed by `DesktopMcpHostRuntime` (exposed as
`runtime.taskHost`) and threaded by `apps/desktop/src/assistant-server.ts`
through `initializeAgentStream({ mcpTaskTracking })` →
`AssistantStreamRuntimeOptions.mcpTaskTracking` →
`MastraAgentRuntimeOptions.mcpTaskTracking`, exactly like `mcpHost`. Per
connected generation whose negotiated capabilities advertise
`io.modelcontextprotocol/tasks` on `2026-07-28` it composes `McpTaskRepository`
over the existing desktop database (`db-main.getDatabase()`, never a new
PGlite), one `McpTaskObservationPort`, the sole-authority `McpTaskLifecycle`,
and `McpTaskInteraction`, and runs `recover()` so every non-terminal handle of
the live epoch resumes. A server that does not advertise Tasks opens no session
and `track()` throws naming the missing advertisement. The actor client closes
the task session (`stop('disconnect')`) before the transport; a replaced
private definition retires the epoch (`stop('server-replaced')`) and a removed
server `stop('server-removed')` before the old generation closes, while an
enabledTools-only reload is a plain reconnect (same `configRef`, same epoch).
Retirement happens only AFTER the replacement configuration has been staged
(`stageResolvedConfig`: auth projection for every server): a replacement whose
preparation rejects (e.g. a bearer credential that cannot be inspected) leaves
the old actor connected with its Tasks session intact. Retirements of distinct
servers are independent sessions and run concurrently; any failure aggregates
into the rejected replacement. The card-driven `recover` action reuses the
host's registered entry for any id the lifecycle already polls (lifecycle
recovery is idempotent, see above), so recovering one card never fails because
another task on the same server is live.

Handle derivation (`McpTaskHandle`): `serverId` is the configured server id
(`ResolvedMcpServer.name`, equal to the host snapshot's `configuredServerId`);
`resource` is the canonical server URL (fragment stripped) for streamable-http
and the reserved marker `https://stdio.mcp.brainstrike.invalid/` for stdio (the
repository requires a canonical HTTP(S) URL and a child process has no
protected resource); `principalId` is `none`, `bearer:<credential id>`, or
`oauth-user:<resource>|<sorted scope key>` for streamable-http and
`local-process` for stdio; `authorityEpoch` is minted/rebound by the
repository. The repository's `connectionGeneration` is a host-owned
*definition* generation that advances only when `configRef` changes (or after
a retirement), never on the host's per-actor generation, so a transport
reconnect rebinds the live epoch instead of orphaning its rows.

`awaitSettlement(handle, { timeoutMs, signal })` resolves
`{ settled: false, reason: 'timeout', task }` at the bound and never throws for
a timeout; it rejects for an unknown handle, a handle outside a live session,
a lifecycle stop, or observation exhaustion. Task-scoped `input_required`
elicitation cannot use `runWithOperation`: the presenter's single-matching-
operation guard has nothing to bind outside a `tools/call` and would misattribute
provenance during a concurrent one, so the host binds each tracked task through
`McpElicitationPresenterAuthority.bindTaskPresenter({ configuredServerId,
generation, operation: { type: 'tools/call', target: toolName } })`, a separate
authority that skips the operation registry, validates the live generation, and
is released on settlement. One notification lease exists per connection and is
fixed at subscription time, so the interaction subscribes for the ids known when
it starts (recovered handles or the first tracked task); later tasks in the same
generation are admitted and driven by the authoritative poller alone, logged at
info level.

Renderer seam (`apps/desktop/src/mcp/task-bridge.ts`, mirroring the
elicitation bridge): `mcp:task:status-changed` pushes every presentation change
to tracked visible-UI windows, `mcp:task:list` returns the bounded live
presentation set, and `mcp:task:act` runs one card action through the
presentation controller fence; both invokes carry the visible-UI sender policy.
The preload exposes `window.mcp.tasks` (`McpTaskBridge`) on the visible-UI
preload only; hidden hosts never receive the `mcp` global. The support matrix
row for Tasks is `supported` (BST-1566) and the settings-ui matrix pin and the
desktop truthfulness test change together with it.
