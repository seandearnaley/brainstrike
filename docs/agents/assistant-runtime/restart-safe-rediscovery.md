# Restart-safe rediscovery — evidence

Supports `docs/agents/assistant-runtime.md` § "PERMISSION ENGINE (TOOL APPROVAL)".
Read before changing `listSuspendedMastraRuns`, the suspended-runs endpoint, hydration injection, or `PgliteWorkflowsStore` corrupt-row handling. BST-1084, BST-558.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 3725-3845), extracted verbatim.

Restart-safe rediscovery (a run suspended for approval OR by a tool's
`suspend()` survives a desktop restart / renderer reload, but the LIVE notice —
a never-persisted stream data part — is gone on reload): on thread open the
desktop history adapter rediscovers both pause kinds and re-surfaces working
notices, REUSING the (already restart-safe, stateless)
`streamMastraToolApprovalAction` / `streamMastraToolResumeAction` resume seams
untouched. Unified since BST-1084 — the previous "non-approval pauses are
tolerated + skipped" behavior is GONE, and with it the silent stranding path
that blocked run_python's Gate B. Flow:
- `listSuspendedMastraRuns(filter, options)` (`suspended-run-discovery.ts`,
  moved out of `agent-streaming.ts` by BST-1649) wraps
  `agent.listSuspendedRuns` — rebuilds a FRESH runtime (no in-memory handle),
  returns `{ approvals, suspends }`: approval-gated calls
  (`requiresApproval === true`) and non-approval `suspend()` pauses
  (submitPlan/askUser), both with `toolName` mapped back to the ORIGINAL dotted
  form (see NAME-FORM CONTRACT above), suspends carrying the tool-defined
  `suspendPayload` recovered from the durable snapshot (so a rediscovered
  plan/question renders its real content). Only a call missing its ids (e.g. a
  delegation-thread run) is tolerated + skipped (debug-logged). Discovery is
  CONTEXT-FREE + KEYLESS: the stable agent id
  (`brainstrike-assistant`) is provider-independent, so listing constructs a
  keyless `ollama` agent (no provider/apiKey from the renderer, no inference).
  Desktop constructs the paired PGlite memory/storage with observational memory
  and semantic recall disabled for this discovery request. An explicitly enabled
  observational-memory configuration could otherwise resolve its provider key
  before the inert listing model is reached, violating the keyless contract.
- Desktop route `GET /assistant/suspended-runs?threadId=&resourceId=`
  (`apps/desktop/src/assistant-server/status-endpoints.ts`): recomputes `riskCategory` from
  `buildNativeToolRiskMap()` (approvals), stamps `stale` against
  `BRAINSTRIKE_APPROVAL_STALE_MS` (both kinds), and flags a suspend whose tool
  has no `hasRegisteredSuspendResumeUi` with `resumeSupported: false` + a loud
  warning — the live path's honesty contract, never a silent drop. Missing
  thread ctx → 400; no storage → 503. Response is `SuspendedRunsResponse`
  (`suspends` is ADDITIVE; a client that only knows approvals ignores it).
- Renderer client `createSuspendedRunDiscovery` (app-shell,
  desktop-capability-gated — web omits it, no `isElectron()`) → hydration
  injection `appendSuspendedPauseMessages` appends one synthetic trailing
  assistant message per pause — `TOOL_APPROVAL_DATA_NAME` for approvals,
  `TOOL_SUSPEND_DATA_NAME` for suspends, interleaved oldest-first — identical
  to the live mapper's output; the existing notices + their resume seams render
  unchanged (an unregistered suspend gets the same dead-end notice as live).
  Staleness is display-only (D5) via the SHARED `RediscoveredPauseLines`
  (`packages/assistant-ui/src/rediscovered-pause-lines.tsx`, used by
  both notice kinds): a muted "Pending since <relative>" line always, an amber
  advisory when `stale`, controls enabled, NO auto-decline / auto-answer.
- Restart proofs extend the same specs: a run suspended under `openai` is
  rediscovered by a keyless `ollama` listing over the same PGlite DB and resumed
  to execution by a THIRD fresh runtime — for approvals
  (mastra-tool-approval-suspend.integration.spec.ts) AND for suspend() pauses
  with their payload (mastra-tool-suspend-resume.integration.spec.ts, the
  BST-1084 headline proof).
- **Corrupt snapshot rows (BST-558, settled — do not relitigate.)** Every
  TARGETED snapshot read in `PgliteWorkflowsStore`
  (`loadWorkflowSnapshot`, `getWorkflowRunById`, `updateWorkflowResults`)
  THROWS on a snapshot that is not an object or lacks `context`: the malformed
  row is the answer the caller asked for, so skipping it would be a lie.
  `listWorkflowRuns` — which backs `agent.listSuspendedRuns` and therefore this
  rediscovery flow — is the ONE deliberate exception: it still returns the
  intact rows, because throwing for the page would let a single corrupt row
  make EVERY pending approval undiscoverable (a total outage traded for a
  partial one). The corruption is not swallowed: each excluded row is logged at
  ERROR severity with code `mastra_workflow_snapshot_malformed`, which the
  DIAGNOSTIC EVENTS contract eagerly flushes into
  `brainstrike_diagnostic_events` and surfaces in the debug bundle. Do not
  downgrade it to a warn/debug log, and do not make listing throw.
- **The ERROR record is emitted ONCE PER RUN PER PROCESS** (settled — do not
  relitigate), guarded by `PgliteWorkflowsStore#reportedMalformedRuns`. A
  corrupt row is PERMANENT in production (`deleteWorkflowRunById` has no
  production caller) while the listing runs on every renderer reload AND on
  every `readResumedApprovalToolCall` during tool approval — so an unguarded
  ERROR would write another eagerly flushed `brainstrike_diagnostic_events` row
  per approval, forever, for one unfixable condition, bounded only by retention
  purge. Repeats carry no information: `computeDiagnosticFingerprint(code,
  scope, message)` is identical every time. This is NOT a silent fallback — the
  condition is reported at ERROR once, and suppressed repeats still emit a
  `debug` record. Do not remove the guard, and do not re-report per call.
- **`total` and `runs.length` may legitimately disagree** (settled — do not
  relitigate). `total` comes from a separate `SELECT COUNT(*)` and is
  AUTHORITATIVE for what matches the filter IN STORAGE — that is what keeps page
  boundaries stable, so it must not shrink as corrupt rows are excluded page by
  page. `runs` is what is SERVABLE; the invariant is `runs.length <= total`, and
  the shortfall is exactly the excluded corrupt rows (genuinely unfetchable —
  `getWorkflowRunById` throws for them by design). Excluding corrupt rows from
  the COUNT would need a SQL predicate mirroring `parseWorkflowSnapshot`'s JS
  predicate, and any drift between the two would silently miscount. No in-repo
  consumer reads `total`: `agent.listSuspendedRuns` destructures `{ runs }`
  only. The corruption signal is the ERROR diagnostic, not the arithmetic.

When changing this flow, update this section and the related tests.

NOTE: the per-tool approval gate is SEPARATE from tool SUSPENSION (submitPlan /
askUser) — see PLAN MODE & TOOL SUSPENSION below. Approval pauses BEFORE a tool
runs (`tool-call-approval` → `approveToolCall`/`declineToolCall`); suspension
pauses DURING a tool's `execute` via `suspend()` (`tool-call-suspended` →
`resumeStream`). run_python's Gate B network escalation (BST-1070) is the
third registered suspending tool: per-call, argument-aware, and structurally
ungrantable — the escalation card (`RunPythonNetworkNotice`) requires every
named domain individually ticked, renders deny primary/autofocused, and has
no grant surface at all. submitPlan/askUser are classified `riskCategory:'read'` so the
permission engine never stacks an approval prompt on top of their own suspend.

Desktop request initialization validates `enabledNativeToolIds` against the
shared desktop catalog before constructing a stream. A stale/unknown id returns
`invalid_enabled_native_tool_ids` at stage `native_tool_preferences` and logs a
safe id or fingerprint with a correlation id; it is never silently dropped.
Workspace-root enrichment has its own `workspace_root_resolution` initialization
stage. A persisted binding whose root is no longer live returns the trusted
`bound_workspace_root_unavailable` message with HTTP 409 so the user can
reconnect it; unrelated resolution faults retain the redacted correlation-id
502 response.
Catalogued tools that are intentionally unavailable for the active provider
(for example suspend/task/session tools under the built-in local model) are a
capability omission, debug-logged separately, and are not mislabeled unknown.
Admitted-child configuration failures retain their typed identity through runtime
construction. An unavailable admitted model/tool returns the same actionable HTTP
409 as a rejected persisted profile, including approval and question resume; it
is never rewrapped as a generic runtime-initialization 502. The service initializer
and real native revoked-tool regression cover this boundary.
Other initialization failures return only a safe stage
(`provider_model_bootstrap` or `stream_construction`) plus a correlation id;
the structured main-process log retains the same pair and the redacted error.
