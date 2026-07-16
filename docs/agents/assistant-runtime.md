# Assistant Runtime: Resilience, Permissions, Hooks, Plan Mode

> Extracted from AGENTS.md (2026-07-12). Read before changing the assistant tool/stream chain, tool approval, lifecycle hooks, or plan-mode/suspension. Keep this doc updated with the code.

## ASSISTANT RESILIENCE (CRITICAL)

The assistant tool→stream chain must never freeze the thread. The renderer safety
net, the two server-side resilience layers, and the Mastra error-processor layer
below are LIVE.

1. **Renderer safety net (LIVE)** — `packages/ui/src/assistant-ui-panel/assistant-panel-error-boundary.tsx`
   wraps `ChatThreadUI` (inside `AssistantRuntimeProvider`, so reset preserves
   the runtime). The data-stream adapter surfaces transport errors via `onError`
   and rethrow (never swallows). A run rejected BEFORE any stream part (e.g.
   memory-construction failure → HTTP 502) has zero message parts;
   `AssistantMessage` mounts `AssistantMessageError` (ErrorPrimitive) so that
   rejection renders as a visible error block — styling lives on the
   error-conditional `Message`, never on the always-rendered `Root` (a styled
   Root paints an empty red bar under every assistant message).

2. **Per-tool guard (LIVE)** —
   `packages/agent/src/tools/guard-tool-execution.ts`. `applyToolGuards` wraps
   the combined Mastra tool map in `createMastraAgentRuntime` after local and MCP
   tools are sanitized/discovered. Tool timeouts and throws resolve to structured
   `GuardedToolError` payloads; guarded timeout/failure payloads are surfaced as
   failed tool events, not successful completions.

3. **Stream inactivity watchdog (LIVE)** —
   `packages/agent/src/stream/with-inactivity-timeout.ts` (`withInactivityTimeout`,
   `StreamStalledError`). `streamChunksFromMastra` wraps the raw Mastra iterator.
   A stream stall emits a visible assistant message, a terminal `run.failed`
   event, and an error finish so the renderer does not remain in-flight forever.

4. **Mastra error-processor layer (LIVE)** —
   `packages/agent/src/mastra/error-processors.ts`, wired into `new Agent` +
   `buildToolLoopOptions` in `agent-runtime.ts`. Adopts three `@mastra/core`
   built-ins that recover on EMITTED provider/API errors — disjoint from the
   guard (tool-execute failures) and watchdog (silent stalls), so no
   double-wrapping:
   - **StreamErrorRetryProcessor** — retries transient mid-stream errors
     (OpenAI Responses `error`/`response.failed`, provider `isRetryable`, and an
     `isEconnResetStreamError` matcher with capped exponential backoff). Since
     core 1.51 the config additionally sets `retryUnknownErrors: true` — an
     UNKNOWN stream error (matched by nothing) is retried under the same
     bounded budget/backoff, while known-terminal authorization failures
     (401/403 or `invalid_api_key`-class codes, walked through the cause
     chain) surface immediately with NO retry (a bad key must fail loudly) —
     and `maxRetryAfterMs` pinned to the SAME 30s ceiling as the backoff cap,
     clamping provider `Retry-After` headers so neither our wait nor the
     provider's demand can stall a retry past it; the wait is abort-aware.
     **ERROR-PROCESSOR ORDER IS LOAD-BEARING** (do not relitigate): Mastra's
     ProcessorRunner returns at the FIRST processor that requests a retry, so
     the stack is [PrefillErrorHandler, ProviderHistoryCompat,
     StreamErrorRetryProcessor] — the FIXUP processors must see the error (at
     `retryCount === 0`) before the unknown-error retry, or a deterministic
     prefill/history-compat rejection is blindly re-sent unchanged until the
     budget burns. Pinned by the prompt-sensitive prefill test (the scripted
     model keeps rejecting while the prompt still ends with an assistant
     message — a blind retry cannot fake recovery). Deliberate trade-off:
     deterministic non-auth errors (e.g. 400 context-length) eat the bounded
     ~3s unknown-retry budget before surfacing.
   - **PrefillErrorHandler** — recovers reloaded-thread assistant-prefill
     rejections (Anthropic / Qwen `enable_thinking`).
   - **ProviderHistoryCompat** — cross-provider `mastra_messages` reuse.
   Placement (verified against the compiled loop, do NOT relitigate): the two
   `processAPIError`-only processors + ProviderHistoryCompat's REACTIVE rules go
   on the Agent-config `errorProcessors` seam (never clobbered by the per-call
   TokenLimiter). ProviderHistoryCompat's PREEMPTIVE `processLLMRequest` rules
   (strip foreign reasoning — the ONLY place that incompatibility is handled)
   fire ONLY from `inputProcessors`, so a SECOND ProviderHistoryCompat instance
   is composed into the per-call `inputProcessors` array ALONGSIDE the
   TokenLimiter in `buildToolLoopOptions` (composing, not clobbering — their
   hooks are disjoint stages). **`maxProcessorRetries` MUST stay pinned**
   (`ASSISTANT_MAX_PROCESSOR_RETRIES = 3`): any `errorProcessors` flips Mastra's
   implicit default to 10. The whole layer is EXCLUDED for the built-in local
   provider (the hidden llm-host owns its own engine-fault recovery; no
   hosted-provider wire quirks apply).

> **LIVE validation requirement:** A prior attempt wired the guard + watchdog into
> the live path and BROKE real Mastra tool calling (hosted-provider tools silently
> stopped executing) while mocked tests stayed green. Future changes to these
> layers MUST preserve coverage that runs the actual Mastra agent loop end to end
> with real tool `execute`, not only mocked stream parts. The current proofs live
> in `packages/agent/src/__tests__/mastra-tool-execution.integration.spec.ts` and
> `mastra-error-processors.spec.ts` (retry, prefill recovery, TokenLimiter
> clobber-guard regression, pinned `maxProcessorRetries`, bounded-terminal).

Config (strict parse — malformed value THROWS, per the no-silent-fallbacks rule),
defined in `packages/agent/src/config/resilience-config.ts`:
- `BRAINSTRIKE_TOOL_TIMEOUT_MS` (default 60000) applies to every native and MCP tool execution.
- `BRAINSTRIKE_STREAM_INACTIVITY_MS` (default 120000)
- A local-runtime inactivity termination includes the normalized provider and
  selected model in both the structured error log and visible run failure. Do
  not include bearer tokens or silently restart/unload the external server.
- Invariant: tool timeout < stream inactivity.
- `BRAINSTRIKE_APPROVAL_STALE_MS` (default 86400000 = 24h) — advisory age after
  which a REDISCOVERED suspended approval is flagged `stale` in the re-surfaced
  notice (see PERMISSION ENGINE §restart-safe rediscovery). Deliberately
  DECOUPLED from the two timeouts above: a human approval may legitimately take
  hours after a restart, so it is NOT tied to the in-flight stream/tool windows.
  Advisory only — both buttons stay enabled, never an auto-decline.

Stream part continuity: run-event data parts ('aui-data') CLOSE the active
text/reasoning append in assistant-stream's accumulator, slicing visible text
into fragments. `DataStreamMapper` therefore defers run events that arrive
while a text/reasoning part is streaming and flushes them at the next boundary
(tool start, approval, finish, error, stream end) — never drop them, never
emit them mid-part (proof: data-stream-text-continuity.spec.ts). The renderer's
data-stream runtime also defers assistant-stream's decoded `message-finish` until
decoder flush: assistant-stream 0.3.25 emits that marker before its trailing
`part-finish`, and exposing completion early lets an immediate next turn abort a
still-draining text controller. Aborted runs propagate the authoritative abort
reason without surfacing cancellation teardown as a new assistant error; server
subscriptions detach on cancel without double-closing their stream controller.

Live shell output (executeCommand streaming): `executeCommand` streams its
subprocess stdout/stderr incrementally through Mastra's tool `writer` as it is
produced (a long build/test run is visible live, not only on exit). The tool
writes via `writer.custom({ type: SHELL_OUTPUT_STREAM_PART_TYPE, … })`
(`packages/agent/src/mastra/shell-output-stream.ts`), which places the slice on
the fullStream VERBATIM — deliberately NOT `writer.write` (that wraps it as a
`tool-output` part, colliding with subagent delegation and masquerading as a
successful tool result). `processMastraStreamPart` maps that part to a dedicated
transient `shell-output` StreamChunk; `DataStreamMapper.handleShellOutput` emits
it as a `SHELL_OUTPUT_DATA_NAME` aui-data part (subject to the SAME text-part
deferral). It is NOT a run-event kind ON PURPOSE: run-events are persisted
server-side into `assistant_run_events` (and their metadata is redaction-
sanitized, which strips `output`/`text` keys) — a `shell-output` StreamChunk is
ignored by that persistence tap (`chunk.type !== 'run-event'`), so live slices
are TRANSIENT (never persisted; absent on reload — the FINAL captured output
persists as the tool result). A COMBINED streaming cap
(`MAX_STREAMED_OUTPUT_BYTES`, separate from the 1 MB capture cap) stops a runaway
process flooding the stream: at the cap one truncation notice is emitted,
streaming stops, and teardown/capture continue unchanged. Mastra hands a plain
tool OBJECT the raw `outputWriter` fn + top-level `toolCallId` (a `createTool`
instance gets `writer.custom` + `agent.toolCallId`); the desktop wiring accepts
both. The renderer accumulates slices per toolCallId INCREMENTALLY
(`createShellOutputAccumulator` + `ShellOutputProvider`, via
`useChainActivityDerivations`) into the live tool card (`LiveShellOutputPane`,
shown only while running). The accumulator is O(new parts) per streamed update
and keeps record identity stable when no shell slice arrived — do NOT replace
it with a full rescan per update (`collectShellOutputs` is the pure/batch
variant): the full rebuild is quadratic over a chatty command and its
per-chunk fresh record identity re-renders every tool card in the turn. Same
rule for `ToolDurationProvider` (value-stable via `useStableRecord`).
background:true (run the tool as a Mastra background task) is a documented
FOLLOW-UP, not in v1. Proofs:
mastra-tool-execution.integration.spec ('streams incremental shell-output …'),
execute-command-tool.test / execute-command-live-loop.test, shell-output-parts.test.

Parallel tool calls: Mastra executes tool calls within a step concurrently
(default concurrency 10; `toolCallConcurrency` loop option). Mastra forces
sequential execution when the run-wide `requireToolApproval` is set OR any active
tool carries the per-tool `requireApproval` flag / a suspend schema. The
permission engine (see PERMISSION ENGINE below) marks `'ask'` tools with the
PER-TOOL `requireApproval`, so a run that includes any ask tool executes its step
sequentially (the price of the per-tool gate), but only the ask tool actually
suspends — allowed tools still run. A run with no ask tools stays parallel. The
approval-resume path sets the run-wide `requireToolApproval`. The data-stream
mapper and UI key all per-call state by toolCallId and handle interleaving.

When changing this flow, update this section and the related tests.

---

## POST-EDIT LSP DIAGNOSTICS (report R2 Phase A)

After a successful workspace edit, a language server runs over the edited file
and its diagnostics (errors/warnings) are attached to the tool result, so the
agent learns about a broken edit immediately instead of only when a later
build/test fails. Desktop-only (needs child processes + fs; web omits it —
capability-gated, no `isElectron()`).

- **Bespoke, not the core primitive.** Core 1.51 ships an LSP primitive but
  only inside its (non-adopted) Workspace/sandbox model and behind unexported
  deep paths, so `apps/desktop/src/assistant-server/lsp-diagnostics.ts` lifts
  the WIRE PROTOCOL (standard `vscode-jsonrpc` + `vscode-languageserver-
  protocol`, both bundled desktop deps), not the class.
- **Bundled flagship server.** Phase A ships TypeScript/JavaScript only, via a
  BUNDLED `typescript-language-server` + `typescript` (desktop `dependencies`,
  so it works out-of-box). Reliability recipe (all three required, verified):
  spawn the server's `cli.mjs` through `process.execPath` +
  `ELECTRON_RUN_AS_NODE=1` (packaged apps have no standalone `node`); pin
  `initializationOptions.tsserver.path` to the bundled `typescript/lib/
  tsserver.js` (deterministic — OUR TS version); and advertise the
  `textDocument.publishDiagnostics` client capability (without it the server
  stays silent). Diagnostics land as two pushes (`[]` then the real set), so a
  settle-window is mandatory — an empty publish is polled a little longer
  before the "clean" verdict is trusted. py/go/rust + an `lsp_inspect` read
  tool (hover/definition/implementations, `<<<` cursor) are Phase B.
- **Pool + lifecycle.** One pooled server child process per workspace `rootId`
  (module-level Map, mirroring `execute-command-tool`'s `liveChildProcesses`).
  Every server MUST be torn down: `disposeLspServers()` is wired into BOTH the
  factory-reset `runtimes[]` and graceful shutdown in `main.ts` (alongside the
  shell/terminal reapers); `evictLspServersForRoot(rootId)` fires from the
  `fs:removeRoot` IPC handler. The no-orphan proof is the heart of
  `lsp-diagnostics.integration.test.ts`.
- **No silent fallbacks.** An unresolvable server, an unsupported language, or
  a diagnostics timeout all resolve to an honest result the caller attaches —
  never a throw that would fail the already-applied edit. Unsupported languages
  (markdown/json) OMIT the `lsp` field entirely (no note spam); a supported
  language whose server is unavailable/timed out attaches `{available:false,
  message}`. Diagnostics are self-bounded (≤15, message ≤300 chars, errors
  first) because `lsp.diagnostics` is NESTED and not a trimmable collection key
  — the transport budget guard cannot rescue an oversized blob.
- **Scope note.** Wired into `write` + `stringReplace` (content-editing tools,
  where diagnostics catch a just-introduced error); `rename` is deliberately
  excluded (content unchanged → diagnostics would report pre-existing state as
  noise, plus a bonus read).

Diagnostics run OUTSIDE the per-file write lock (a language-server round-trip
must not extend the write's critical section). Proofs:
`lsp-diagnostics.integration.test.ts` (real subprocess: diagnostics,
pooling, no-orphan dispose, honest degrade) + the `post-edit LSP diagnostics`
cases in `assistant-tools.integration.test.ts`. When changing this flow, update
this section and those tests.

---

## PERMISSION ENGINE (TOOL APPROVAL)

Mutation tools PROMPT for per-call approval by default. The permission policy
store (`packages/preferences/src/stores/permission-policy-store.ts`) defaults to
`enforce: true` with policies `{read:allow, mcp:allow, edit:ask, execute:ask}`,
so by default read/MCP tools run free while edits and shell commands suspend the
run for user approval. A user can turn `enforce` off (explicit opt-out), set a
category to `allow`/YOLO, or grant a session category.

Flow (desktop assistant server → agent runtime):
1. The renderer attaches the persisted policy snapshot to the request only when
   `enforce` is true. `resolveRequestPermissionPolicy` (agent) builds the trusted
   `PermissionToolGateSnapshot` with a SERVER-built `riskByTool`
   (`buildNativeToolRiskMap`) — the client never classifies tool risk.
2. `filterToolsByPermissionWithMetadata` (`packages/agent/src/mastra/permission-tool-gate.ts`)
   gates the tool map BEFORE the immutable `Agent` is built: `'deny'`→omit;
   `'allow'`→keep unchanged; `'ask'`→keep a CLONE with Mastra's PER-TOOL
   `requireApproval: true` and record in `askToolIds`.
3. PER-TOOL, not global: marking each ask tool with `requireApproval` (Mastra
   >=1.37) makes Mastra suspend ONLY when that tool is actually called — allowed
   `read`/`mcp` tools in the same run still run free. We deliberately do NOT force
   the run-wide `requireToolApproval` (it would suspend EVERY tool call, breaking
   the read-only default). `createMastraAgentRuntime`'s `resolveAskToolsForRun`
   only decides whether ask tools may STAY: WITH Mastra workflow storage they stay
   (their per-tool flag suspends + the resume path can restore the run); WITHOUT
   storage (`streamMastraToolApprovalAction` throws) they are fail-safe OMITTED
   (never run an approval-required tool unprompted — no-silent-fallbacks).
4. The approval UI + resume chain (`makeApprovalRequiredChunks` →
   `tool-approval-required` chunk → `DataStreamMapper.handleToolApprovalRequired`
   → `TOOL_APPROVAL_DATA_NAME` data part → `assistant-tool-approval-notice.tsx`)
   prompts the user; approve→execute, decline→skip. Alongside Approve/Decline
   the notice offers two GRANT actions when (a) a `ToolApprovalGrantProvider`
   is mounted above it (app-shell wraps the panel, same outside-in pattern as
   `EditCheckpointProvider`; no provider → no buttons, capability gating) and
   (b) the approval carries a valid `riskCategory` (policy-driven ask —
   non-policy pauses never over-promise a grant): "Always allow <tool>" →
   `setToolOverride(toolId,'allow')` (persisted), "Allow <category> this
   session" → `grantSessionCategory` (session-lived). Both record the grant
   FIRST, then approve the pending call through the normal resume — the grant
   affects the NEXT request via the wrapper's reactive store subscription; the
   pending call still resolves through `streamMastraToolApprovalAction`.
   An OpenRouter approval pause terminates its transport leg with zero-token
   usage and no claimed cost: Mastra emits the pause before that model step's
   `step-finish`. Approval resume emits the deferred step finish before later
   steps, so normal terminal aggregation records the exact total then.
   Management surface: Settings > Permissions lists per-tool overrides
   (change decision / remove via `setToolOverride(id,null)`) and active
   session grants (revoke via `revokeSessionCategory`). The chunk carries an optional
   `riskCategory`/`policyDecision` so the notice can name the reason. The
   data-stream mapper correlates Mastra's transient tool error emitted before a
   deliberate `suspend()` and suppresses only that call's false failure fallback;
   unrelated tool failures remain visible. The
   approve/decline resume (`streamMastraToolApprovalAction`) passes
   `requireToolApproval: true` (the resume API needs it); the gate runs again on
   resume so the ask tools keep their per-tool flag. Because run-wide
   `requireToolApproval: true` would suspend EVERY tool call on the resumed leg,
   `resolveResumeApprovalGate` (agent-runtime.ts) substitutes the FUNCTION form of
   the gate backed by the rebuilt runtime's authoritative `askTools` set. Allowed
   read/internal-state tools keep running, ask-gated mutations may suspend again,
   and the canonical Mastra internal ids (`internal-approval-exempt-tools.ts`:
   `updateWorkingMemory`/`setWorkingMemory`) remain explicitly exempt. An empty
   policy ask set denotes an explicitly global approval request, so its resumed
   leg continues gating every non-internal tool.

Migration (enforce-on is a SECURITY fix): the store bumps to v2. Under v1,
`false` was the default AND always persisted, so a pre-v2 `false` slice is
indistinguishable from an opt-out — `migrate` adopts the secure default (`true`)
for ANY pre-v2 slice (a genuine v1 opt-out gets re-prompted once, the safe
direction). Only a v2+ persisted boolean is honored verbatim. Skipping this would
leave upgrading `enforce:false` users with the now-always-registered, ungated
`executeCommand` — the regression this guards against.

Web: the in-renderer LocalRuntimeChat never reaches `streamMastraAgent` (no
assistant server / storage), so ask tools are fail-safe-omitted there and web
local chat is unaffected (desktop-first).

Live-loop proof (real Agent + real PGlite workflow storage, no agent mock):
`packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts` —
suspend→approve→execute, suspend→decline→skip, AND an allowed read tool runs
FREE while an ask tool is in the map (the per-tool-not-global guard). NOTE: the
scripted model's synchronous stream starves the event loop during the
PGlite-backed resume; the test drains with a per-chunk `setImmediate` yield
(mirrors real streaming) — a harness concern, not a production bug.

Restart-safe rediscovery (a run suspended for approval survives a desktop
restart / renderer reload, but the LIVE approval notice — a never-persisted
stream data part — is gone on reload): on thread open the desktop history
adapter rediscovers pending approvals and re-surfaces a working notice, REUSING
the (already restart-safe) `streamMastraToolApprovalAction` resume seam
untouched. Flow:
- `listSuspendedMastraRuns(filter, options)` (`agent-runtime.ts`) wraps
  `agent.listSuspendedRuns` — rebuilds a FRESH runtime (no in-memory handle),
  returns approval-gated tool calls only (`requiresApproval === true`);
  non-approval `suspend()` pauses (submitPlan/askUser) and delegation-thread runs
  are tolerated + skipped (debug-logged) — a unified suspend rediscovery is a
  follow-up. Discovery is CONTEXT-FREE + KEYLESS: the stable agent id
  (`brainstrike-assistant`) is provider-independent, so listing constructs a
  keyless `ollama` agent (no provider/apiKey from the renderer, no inference).
- Desktop route `GET /assistant/suspended-runs?threadId=&resourceId=`
  (`apps/desktop/src/assistant-server.ts`): recomputes `riskCategory` from
  `buildNativeToolRiskMap()` and stamps `stale` against
  `BRAINSTRIKE_APPROVAL_STALE_MS`. Missing thread ctx → 400; no storage → 503.
- Renderer client `createSuspendedApprovalDiscovery` (app-shell,
  desktop-capability-gated — web omits it, no `isElectron()`) → hydration
  injection `appendSuspendedApprovalMessages` appends one synthetic trailing
  assistant message per approval carrying a `TOOL_APPROVAL_DATA_NAME` data part
  identical to the live mapper's output; the existing notice + its
  Approve/Decline resume render unchanged. Staleness is display-only (D5): a
  muted "Pending since <relative>" line always, an amber advisory when `stale`,
  both buttons enabled, NO auto-decline.
- Restart proof extends the same spec: a run suspended under `openai` is
  rediscovered by a keyless `ollama` listing over the same PGlite DB and resumed
  to execution by a THIRD fresh runtime.

When changing this flow, update this section and the related tests.

NOTE: the per-tool approval gate is SEPARATE from tool SUSPENSION (submitPlan /
askUser) — see PLAN MODE & TOOL SUSPENSION below. Approval pauses BEFORE a tool
runs (`tool-call-approval` → `approveToolCall`/`declineToolCall`); suspension
pauses DURING a tool's `execute` via `suspend()` (`tool-call-suspended` →
`resumeStream`). submitPlan/askUser are classified `riskCategory:'read'` so the
permission engine never stacks an approval prompt on top of their own suspend.

---

## TOOL-LIFECYCLE HOOKS (Claude-Code-style)

User-authored shell commands that run at lifecycle events and (for blocking
events) can refuse to proceed. **Desktop-only by construction** — shell hooks
need Node `child_process` + absolute root paths + the assistant server; web
constructs NO hook runner (capability-gated, no `isElectron()` checks).

Seven events, three blocking (`PreToolUse`, `Stop`, `UserPromptSubmit`). A hook
is `{ type:'command', command, matcher?:{tool_name}, timeout?, description? }`.
It receives a JSON payload on **stdin** (secret-redacted), returns optional JSON
on **stdout** (`{decision, reason, additionalContext}`); its **exit code** is
authoritative: `2` = hard block on a blocking event, other non-zero =
warn-and-continue, `0` = ok. Per-hook timeout → **SIGKILL**.

**Insertion points (do not move):**
- `PreToolUse`/`PostToolUse` live in the tool-execute seam. `applyToolHooks`
  (`packages/agent/src/tools/hook-tool-wrap.ts`) is a SIBLING of `applyToolGuards`,
  composed OUTSIDE the guard, BEFORE the permission gate:
  `combinedTools → applyToolGuards → applyToolHooks → plan-mode → permission gate`
  (`agent-runtime.ts`). Permission runs downstream of `execute`, so **hooks
  REFINE, never widen**: a PreToolUse hook can BLOCK a permitted tool but can
  never allow a denied/ask tool. A block returns a `HookBlockedToolError`
  (`error.code:'tool_blocked_by_hook'`, recognized by `isGuardedToolError`) so it
  renders as a FAILED tool event. PostToolUse `additionalContext` is capped
  (`HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET` 2000) and merged into the tool result.
  A hook-runner FAULT is allow-on-fault (a runner bug must not brick tool calling).
- `UserPromptSubmit`/`Stop` run in `apps/desktop/src/assistant-server.ts`
  (`initializeAgentStream`). A UserPromptSubmit block short-circuits the turn with
  a visible message + `run.failed` and NEVER invokes the model; additionalContext
  prepends a `system` message. The blocked branch returns an `ok:true` stream but
  carries `terminalStatus:'failed'` (+ `terminalError`) on `AgentStreamSuccess`, so
  `streamAssistantPostResponse` persists the `thread_runs` row as `failed` — never
  the default `completed`, which would contradict the visible `run.failed`.
  **Stop is NOTIFY-ONLY in v1** (surface the block reason as a `hook.notice`; NO
  auto-continue). Stop is ALSO the only phase that may report a **Task Ledger
  run verdict** (see the Run-verdict protocol below). The terminal Stop hook
  (`withStopHook`) MUST run BEFORE the
  `message-finish` chunk is yielded, not only in its `finally`: the live
  data-stream consumer stops pulling the source the instant the mapper emits
  `finish`, so a `hook.notice`/`hook.blocked` queued AFTER the finish reaches
  neither the live renderer nor persistence. Running Stop at the finish boundary
  lets the observer drain those queued run events (the mapper defers them past an
  open text part and flushes at the boundary); `finally` still fires Stop for
  streams that end without a finish chunk (bare return / throw / abort).
  SessionStart/SessionEnd/Notification are implemented but UNWIRED in v1.

**Timeout invariant (honest ceiling — no summed guarantee).** There is NO
enforced `pre + tool + post` sum ceiling. What IS enforced:
- **Per-hook:** `config.ts` rejects any hook whose `timeout >=
  resolveToolTimeoutMs()`; every hook is SIGKILLed at its own timeout (default
  10_000ms). Chain: `per-hook (<60s) < BRAINSTRIKE_TOOL_TIMEOUT_MS (60_000) <
  BRAINSTRIKE_STREAM_INACTIVITY_MS (120_000)`.
- **Watchdog-covered in-stream phases** (`PreToolUse`/`PostToolUse`): bounded by
  the per-hook SIGKILL + the stream inactivity watchdog (120s) as the backstop —
  NOT by an aggregate cap. These run WHILE an `iterator.next()` is pending, so the
  watchdog timer is armed and covers them.
- **Boundary phases the watchdog CANNOT reach** (`UserPromptSubmit` + `Stop`):
  both gate a user-visible boundary with the watchdog disarmed, so each carries
  its OWN aggregate bound (`resolveToolTimeoutMs()`, 60s), applied at runtime by
  `runHooksForEvent` (`aggregateTimeoutMs`, threaded via the manager's
  `aggregateTimeoutMs` ctx): the in-flight hook is SIGKILLed at the remaining
  budget and the rest are skipped with a loud warning (timeout ==
  warn-and-continue; hooks proceed, never silently stall turn start / finish
  delivery).
  - `UserPromptSubmit` runs BEFORE the model is invoked; it ALSO enforces the
    bound on the config-load end: `loadHooksConfig` disables the phase fail-LOUD
    (a `HookConfigError`) when the combined declared timeout reaches the ceiling.
    Over-budget config never silently truncates.
  - `Stop` runs in FRONT of the `message-finish` yield (the watchdog is applied
    UPSTREAM of the `withStopHook` seam and its timer is disarmed while Stop
    awaits), so an unbounded chain of Stop hooks would delay finish delivery, the
    Stop notices, HTTP stream close, and the `thread_runs` status write. The
    runtime aggregate cap is its only bound — the watchdog does NOT cover it.
    (v1 has no config-load check for the Stop combined timeout; the runtime cap
    is authoritative.)

**Malformed config = disable-with-visible-error (NOT throw-at-load).**
`loadHooksConfig` returns `{hooks, errors, sources}`; a malformed/untrusted file
contributes ZERO hooks (fail-CLOSED) AND records a `HookConfigError` surfaced on
THREE channels (`logger.error`, a `hook.notice(failed)` run event via
`reportConfigErrors`, the Hooks settings banner). Never throw at load — that
would brick every run over a config typo and hand a malicious repo a DoS. This is
loud + fail-closed, the opposite of a silent fallback.

**Security spine (trust gate).** Global hooks (`~/.brainstrike/hooks.json`, the
user's own machine) run without approval. **Project** hooks
(`<root>/.brainstrike/hooks.json`, per mounted desktop root) run ONLY after a
per-root approval **pinned to the file's SHA-256**. The trust store
(`packages/preferences/src/stores/hook-trust-store.ts`, persisted,
factory-reset-registered) records `{rootId → {approvedSha256, approvedAt}}`. The
renderer only ATTESTS approved hashes over the wire (`HookTrustRequest`); the
server independently RE-READS + RE-HASHES disk (`trust.ts` `resolveTrustedRoots`)
and runs a root's hooks only when `sha256(disk) === approvedSha256`. The trust
hash is over the RAW file BYTES (`sha256OfBuffer`), and the approve-time review
(`ipc-hooks-handlers.ts`) hashes those same bytes — never a utf8-decoded string,
which would diverge for BOM/non-utf8 bytes and silently void an approval. Trust
+ parse come from ONE read (`loadHooksConfig` reads the bytes once, hashes them,
and parses those same bytes only when trusted — no read-vs-hash TOCTOU window). A
changed file → untrusted (re-approve). Keyed by durable `rootId`, never raw path.
Stdin payloads are secret-redacted before spawn (`executor.ts` `redactSecrets`,
mirrors the logger redact key set). NOTE: redaction covers ONLY the stdin JSON —
it does NOT extend to the hook's inherited `process.env` (hooks inherit the full
assistant-server env). Low-risk here: provider API keys live in the encrypted
keychain, never in the process env.

**Config paths (D6):** global `~/.brainstrike/hooks.json` (new home-dotfile, for
discoverability); per-root `<root>/.brainstrike/hooks.json`. Merge order:
global-first, then roots in mounted order; each loaded hook is tagged with its
source `cwd`/`rootId` (global hooks' cwd = primary root).

**Threading:** `RuntimeData.hookRunner` (trusted, agent-only, never serialized —
mirrors `localLlmHostClient`; preserved by `resolveRuntimeConfiguration`'s spread)
+ `RuntimeData.hookTrustRequest` (wire). The server STRIPS any client-supplied
`hookRunner` and injects the server-built one (closure over `HookManager`).

**Run-verdict protocol (Task Ledger source 'hook').** A **Stop** hook (e.g. one
that runs the test suite after the agent finishes) may label the run's outcome
by printing ONE JSON line to stdout:
`{"brainstrikeRunVerdict":{"verdict":"succeeded"|"failed"|"mixed","detail":"…"}}`.
Rules (`hooks/run-verdict.ts`, strict — hook stdout is UNTRUSTED repo data):
- **Stop-only by construction**: `captureRunVerdict` is set solely by
  `HookManager.runStop` — a Pre/PostToolUse hook printing the line is ignored
  (a post-tool hook on the last tool is NOT run-completion semantics).
- **Bounded scan**: only the trailing `RUN_VERDICT_STDOUT_SCAN_CHARS` (64 KiB)
  of raw stdout are scanned; a window that slices mid-line drops the partial
  first line. Candidate lines = lines containing the marker key. The LAST valid
  line wins within a hook, and the LAST hook with a valid verdict wins across
  the phase (mirrors the ledger's later-write-upserts rule).
- **Strict or ignored, never coerced**: malformed JSON, unknown verdict values,
  a non-string/oversized `detail` (> 2000 chars — the repository bound), or any
  extra key ⇒ that line is ignored with a CONTENT-FREE warning (no stdout
  excerpt leaks into logs/run events) surfaced as a `hook.notice` via
  `surfaceOutcome`. A bad line never fails the hook flow or the run. This scan
  is separate from the decision protocol (`{decision, reason,
  additionalContext}` parses the WHOLE trimmed stdout as one JSON object).
- **Persistence (main-process, path A)**: `withStopHook` awaits the threaded
  `onRunVerdict` IN FRONT of the `message-finish` yield, so the label lands
  before the post-stream `thread_runs` status write — a finishing run cannot
  lose it to teardown. `recordDesktopAssistantHookRunOutcome`
  (assistant-server.ts) upserts `brainstrike_assistant_run_outcomes` via the
  desktop DB handle, deriving thread/resource ids from the runs row (mirrors
  the run-event insert); a missing runs row THROWS (never a silent no-op).
  The upsert is byte-consistent with the app-shell repository's
  `recordRunOutcome` (documented duplication, like the bootstrap-SQL precedent)
  PLUS the SQL precedence guard `source <> 'user'`: a hook label NEVER
  overwrites an explicit user verdict (skip, logged), while a later user
  verdict still replaces a hook label; the repository applies the SAME guard
  for `source: 'hook'` writes. Allow-on-fault: a failed verdict write is a
  loudly logged lost label, never a lost finish. No runId ⇒ no recorder is
  threaded (hooks still run). See assistant-persistence.md § TASK LEDGER.

**Run-event kinds:** `hook.blocked`, `hook.notice` (in `ASSISTANT_RUN_EVENT_KINDS`).

**Settings + review IPC:** `hooks-settings-section.tsx` (per-root
trusted/untrusted/changed/parse-error + approve/revoke) via
`hooks:getProjectHooksForReview` IPC (`ipc-hooks.ts`) + `window.hooks` preload
bridge (capability-gated). The LIVE mounted roots are threaded from the desktop
settings page (`apps/desktop/.../settings/page-content.tsx`): it reads
`activeRootIds` + `rootDescriptors` from the file-explorer zustand store (reactive
to mount/unmount, no restart) and maps them to `HookReviewRoot`
(`{rootId, absPath, displayName}`, sidebar order) for `createHooksSettingsCategory`.
Capability-gated by construction — the WEB settings page never constructs the Hooks
category, so it needs no roots. Each row's review is fetched independently; a
transport-level bridge failure for one root renders THAT row `Unavailable` (a
structured `error` review), never a stale/empty "no hooks" lie.

**Trust is keyed by the DB `roots.id`, NOT the adapter rootId (SECURITY).** The
adapter uuid is minted afresh on every `fs:addRoot` and dropped on `fs:removeRoot`,
so a remove→re-add of the SAME path yields a NEW adapter id while the DB `roots`
row persists and is path-matched by `reconcileRoots` — the two ids DIVERGE on that
ordinary flow. The server keys trust by the DB id (its roots come from the DB
`roots` table), so the panel MUST too or revoke/approve target a dead id while the
server keeps trusting a live grant (the fail-OPEN #1570 closed). Mechanism:
- The review IPC runs in MAIN (DB access): it CONTAINMENT-checks the reviewed path
  against the mounted DB roots (realpath'd — `resolveDbRootForPath`; an arbitrary
  or symlink-escaping path is refused, fixing the old "any absolute path" read) and
  returns the resolved `dbRootId`. The panel keys status/approve/revoke by THAT id.
- `buildHookTrustRequest` (hook-trust store) is SCOPED to the currently-mounted
  roots' DB ids. The assistant wrapper resolves them via
  `window.hooks.resolveTrustedRootIds(mountedPaths)` (same main DB-id seam) and
  attests NOTHING until resolved / if the resolver is absent (fail closed). A
  disconnected root's grant is therefore never presented to the server → its hooks
  fail closed even though the DB row stays `status='live'`. NOTE: the
  disconnect-severs property is RENDERER-ENFORCED (via this attestation scoping) —
  the server keys off ALL `status='live'` DB rows and nothing sets a row non-live
  on disconnect. This is sound under the app's same-process trust model plus the
  server's authoritative disk re-hash: a renderer that skips scoping can at most
  re-run byte-identical already-approved hooks, never new content.
- The store bumped to v2: pre-v2 adapter-keyed approvals are DROPPED at migration
  (unremappable without DB access → re-approval is the safe direction; mirrors the
  permission-policy v2 security bump). Factory reset clears the store unchanged.

Live-loop proofs (real Agent + real `applyToolHooks`, no stream mocks):
`packages/agent/src/__tests__/mastra-tool-execution.integration.spec.ts` (block / allow +
PostToolUse context / runtime-threaded / no-runner regression / runner-fault).
Server composition: `apps/desktop/src/__tests__/assistant-server/hooks/`.
Run-verdict protocol: `hooks/run-verdict.test.ts` (strict parse + bounded scan),
the verdict cases in `hooks/server-composition.integration.test.ts` (real Stop
hooks: record-before-finish ordering, finally-path, malformed→notice,
recorder-fault, non-Stop guard, last-hook-wins), and
`apps/desktop/src/__tests__/assistant-server/hook-run-outcome.integration.test.ts`
(real-PGlite precedence: hook lands / never over user / user over hook /
unknown-run throws).

**Deferred (documented follow-ups):** SessionStart/SessionEnd/Notification
wiring; Stop auto-continue; Stop `assistant_message` accumulation; full hooks.json
editor UI; rendering the fetched `content` in-panel (approval is hash-only today);
a refetch on approve/revoke/refocus (a disk edit after the fetch shows a stale
badge until reopen — fail closed server-side); `<userData>` vs home-dotfile
decision.

When changing this flow, update this section and the paired tests.

---

## PLAN MODE & TOOL SUSPENSION (ask-user / submit-plan)

Two SUSPENDING native tools pause the run DURING execution and resume with
arbitrary data, on a NEW transport that PARALLELS the approval transport (it does
not overload it). Built on `@mastra/core@1.50` tool `suspend()`/`suspendSchema`/
`resumeSchema` + `agent.resumeStream(resumeData, {runId, toolCallId})`.

- **`submitPlan`** (packages/agent/src/tools/submit-plan-tool.ts): takes a
  structured plan INLINE (`{title, overview, steps[], risks?, verification?}` —
  NOT an on-disk path like Mastra's builtin `submit_plan`), `suspend()`s with it,
  and on resume returns `{status, feedback?}`. Resume vocab is the builtin-
  compatible `{action:'approved'|'rejected', feedback?}` (SubmitPlanDecision).
- **`askUser`** (ask-user-tool.ts): `{question, options?, selectionMode?}`,
  resumes with `string | string[]` (AskUserAnswer); multi-select joins with ", ".

**Transport table (parallel to approval):**

| Layer | Approval | Suspend (this feature) |
|---|---|---|
| Stream chunk | `tool-approval-required` | `tool-suspend-required` |
| Data part | `brainstrike.tool-approval` | `brainstrike.tool-suspend` |
| Run-config key | `brainstrikeToolApproval` | `brainstrikeToolSuspend` |
| Resume action | `AssistantToolApprovalAction` | `AssistantToolResumeAction` |
| Server fn | `streamMastraToolApprovalAction` | `streamMastraToolResumeAction` |
| Mastra call | `approveToolCall`/`declineToolCall` | `resumeStream(resumeData,{runId,toolCallId})` |
| UI renderer | `AssistantToolApprovalNotice` | `AssistantToolSuspendNotice` (branches by toolName) |

Contract types + guards live in `@brainstrike/assistant-contract/tool-suspend`
(`readToolResumeRunConfigAction` returns `{invalid:true}` on a malformed action —
surfaced as a 400, never coerced).

**Stream path** (agent-runtime.ts): Mastra emits `tool-call-suspended` when a
suspending tool calls `suspend()`. `makeToolSuspendRequiredChunks` turns it into
a resumable `tool-suspend-required` chunk + a tool-calls finish and STOPS at the
pause (this replaced the old `makeUnsupportedApprovalChunks` dead-end at ~936).
A native OpenRouter pause finish has zero tokens and no billed-cost field because
Mastra has not exposed that step's `step-finish` yet. Resume emits the deferred
step finish before continuing, so the resumed terminal finish aggregates the
pre-pause and subsequent step costs.
A malformed pause (missing toolCallId/runId) still falls back to the unsupported
termination so it fails visibly. `DataStreamMapper.handleToolSuspendRequired`
emits the `brainstrike.tool-suspend` data part, honoring the text-part deferral
contract (flush pending run events + finalize open text first). The data part is
transient (aui-data, NOT persisted) — same as approval.

**Resume** (`streamMastraToolResumeAction`): REQUIRES Mastra workflow storage
(throws without it — no silent fallback), calls `resumeStream`, threads
`withRuntimeDerivedStreamOptions` so the rebuilt Agent keeps its native tools
(the same desktop write-on-approval fix), and does NOT pass `requireToolApproval`
(that is approval-specific). Stateless: it holds no in-memory runId, so a future
`listSuspendedRuns` rehydrator can call it with a discovered runId unchanged.

**Storage fail-safe** (`resolveSuspendToolsForRun`, plan-mode-tool-gate.ts): a
tool that can `suspend()` (detected structurally by an own `suspendSchema`) is
FAIL-SAFE omitted from the map when there is no storage to resume it — mirrors
the ask-tools omit in `resolveAskToolsForRun`. Web in-renderer LocalRuntimeChat
has no server/storage, so both suspend tools are omitted there (desktop-first, v1).

**Plan mode** (opt-in, per-request `runtimeData.planMode`): a persisted composer
toggle (`assistant-preferences-store.planModeEnabled`) sends `planMode:true` only
when on (presence-means-on, gated to the desktop data-stream transport in the
app-shell wrapper). `filterToolsForPlanMode` runs BEFORE the permission gate in
`createMastraAgentRuntime`: it keeps read/mcp tools + the suspending tools and
OMITS every edit/execute tool, so the model investigates read-only and proposes a
plan before any changes. `manageTaskList` (`riskCategory:'read'`) DELIBERATELY
stays available in plan mode: it is thread bookkeeping (the assistant's own todo
list), not workspace/fs mutation, so the model can plan its steps while planning.
`buildDefaultInstructions(toolNameMap, {planMode})`
prepends a PLAN-MODE block. THREE-SIDED local gating (mirrors the task-list tool):
plan mode is EXCLUDED for provider `'local'` (the filter + the instruction block
+ the runtime `planModeActive` guard all check `normalizedProvider !== 'local'`),
and the composer toggle itself is HIDDEN for the `'local'` provider in the
app-shell wrapper (`selectedProvider !== 'local'`) rather than silently no-opping.
**Approve exits plan mode:** APPROVING a submitted plan clears the persisted
`planModeEnabled` toggle BEFORE the resume request is composed (via the
`PlanModeExitProvider` seam consumed by `AssistantToolSuspendNotice`), so the
resume omits `planMode` and the rebuilt runtime unlocks the mutation tools;
REJECT keeps plan mode on so the model can revise.

**Cross-reload hydration:** in-session resume works today; cross-reload resume
waits on the separate `listSuspendedRuns` feature (the data part is transient).
`AssistantToolResumeAction`'s fields are all recoverable from
`listSuspendedRuns().runs[].toolCalls[]`, so nothing here blocks it.

Paired tests: packages/agent/src/__tests__/mastra-tool-suspend-resume.integration.spec.ts
(real Agent + real PGlite: suspend→approve, reject-with-feedback, askUser
free-text + multi-select, no-storage fail-safe omit + resume-throws, plan-mode
drops edit / keeps submitPlan); plan-mode-tool-gate.spec.ts; the streaming +
data-part-continuity + default-instructions plan-mode specs; the desktop
assistant-server resume-dispatch tests; and the UI suspend-notice tests.

When changing this flow, update this section and the paired tests.

---
