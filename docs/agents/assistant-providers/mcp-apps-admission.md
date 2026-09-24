# MCP Apps ordinary admission — evidence

Supports `docs/agents/assistant-providers.md` § "Production Apps host". Thread-keyed admission, the live-run to detached lifetime, and the IPC domain.

The contract holds the rules; this file is the record behind them. Extracted
verbatim from the pre-distillation contract (lines 3020-3099); append rather than
rewrite.

---

`McpDesktopAppHost` owns ordinary admission in main, keyed by the OWNING
THREAD. `assistant-server.ts` registers each runtime's `mcpAppToolAdmission`
as `{ runId, threadId: runtimeData.memory.threadId }` — a run without a
persisted thread publishes nothing — and calls `invalidateAdmission` from
runtime disposal. `McpAppPrepareRequest.threadId` is mandatory: the shared
`ToolResultRendererProps.threadId` seam (populated in `todo-progress.tsx` from
`ActiveThreadKeyContext`, the same id the request lifecycle sends as
`memory.threadId`) carries the thread that owns the tool result, and
`McpAppToolResult` renders a visible "requires a persisted thread" note instead
of mounting when it is absent. Preparation resolves the admission of exactly
that thread and requires it to admit the requested server; it never picks by
recency, so two threads on the same server each execute under their own run's
approval/risk state. It binds the one-use executor and release to the
requesting WebContents plus preparation id and fails closed with
`mcp_app_admission_unavailable` otherwise. A newer run registering for the
same thread supersedes the older admission (live or detached) and releases its
pending preparations; a later disposal of that older run leaves the newer one
intact. Registration is gated on the run being able to mount an app at all:
`createMcpAppToolAdmissionCapability` counts admitted tools whose execution
metadata carries the `appCapable` marker (set in `mcp-runtime-client.ts` from
the same `_meta.ui` predicate as the Apps projector), and `agent-runtime.ts`
skips `mcpAppAdmission.register` when that count is zero. Consequence: an
app-free later run of the same thread does NOT supersede the thread's
still-mounted app admission, and it never detaches into a host watch (the
packaged lifecycle E2E's `subscriptionsClosed: 1` pins this).

**Admission lifetime: live run → detached → superseded/retired** (BST-1572
acceptance: the user reads the rendered app and clicks a button AFTER the
assistant's turn ended). While the run is live, the admitted executor is the
run's exact gated MCP tool entry (hooks, telemetry, run-owned
`McpRuntimeClient`). Run `dispose()` closes that client, so the authority does
NOT keep executing through it: `invalidateAdmission` releases the run's
pending preparations and DETACHES the admission. The admission capability's
`admit` reads only the static per-tool maps built at runtime assembly
(`createMcpAppToolAdmissionCapability`: decision from `askTools`, risk from the
permission snapshot, tool identity namespace-resolved through `toolNameMap` to
the server-side name) and touches no client, so a detached prepare returns the
same `allow`/`ask` decision and risk category — the renderer consent dialog
still gates `ask` tools exactly as before. Detached execution is one
process-level host-port call,
`host.invoke({ type: 'tools/call', configuredServerId, toolName, arguments }, { signal })`
on `getDesktopMcpHostRuntime().host` (the app's `toolName` is already the
server-side name; `origin.serverId` is the configured server id), and the
canonical `CallToolResult` is what the renderer posts back into the frame.
When a Tasks-capable server answers a detached call with a CreateTaskResult
(detected with `readMcpCreatedTaskResult`, which unwraps the registry envelope
too), the authority hands it to the desktop task host through its lazily
resolved `resolveTaskHost` seam (`getDesktopMcpHostRuntime().taskHost`) so the
repository/lifecycle/lease own the task, then returns the canonical
CreateTaskResult to the frame without awaiting settlement — the same shape the
run-owned app path returns (see "TOOL-PATH WIRING (BST-1566)" in
`assistant-runtime.md`). A task the host cannot track fails the call visibly.
Detached calls bypass the run's tool hooks, guard/error processors, and
telemetry by design: there is no run. Retention is bounded: at most one
admission per thread; a detached admission is pinned to each admitted server's
live host generation at detach time (servers not live on the host are not
retained; an admission with none is dropped), a `host.watch` on those servers
drops it when a generation retires or the server disappears, and prepare
re-checks the live snapshot generation because watch delivery is
microtask-queued. Host close rejects the invoke (`mcp-host-closed`) rather than
degrading. There is no app-unmount signal today, so a detached admission lives
until supersession or generation retirement. Execution, explicit release, run
disposal, supersession, generation retirement, and WebContents destruction
consume preparations; stale and replayed preparation ids cannot execute.

The renderer supplies the preparation id and preparation awaits the admission
preparer, so `prepare` reserves the id SYNCHRONOUSLY before its first await
and drops the reservation on every exit path: a concurrent duplicate rejects
with `mcp_app_preparation_duplicate` instead of overwriting the first entry
(whose executor would otherwise be dropped without release).
The visible-UI-only IPC domain is `mcp:apps:prepare`, `mcp:apps:execute`,
`mcp:apps:release`, `mcp:apps:prepareShell`, and `mcp:apps:releaseShell`
(`McpAppShellPrepareRequest` = `{ contentSecurityPolicy, document,
permissionsPolicy }`, result `{ shellUrl, token }` with the URL pinned to the
token root on the shell scheme). `window.mcp.apps.readResource` resolves the server's live
generation and uses the existing `mcp:content:readResource` path for the exact
server id and `ui://` URI, then requires text content and the exact Apps MIME
type. Hidden preloads expose no `mcp` global. Renderer consent remains owned by
`McpAppToolCallAuthority`; main executes only the ordinary runtime's already
gated tool entry.
