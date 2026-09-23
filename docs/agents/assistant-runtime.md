# Assistant Runtime: Resilience, Permissions, Hooks, Plan Mode

> Read before changing the assistant tool/stream chain, tool approval, lifecycle
> hooks, or plan-mode/suspension. Rules here are true now; the record behind each
> is in `assistant-runtime/<topic>.md`.

## Existing-runtime conversation panels

- `AssistantConversationPanel` binds `ChatThreadUI` to a supplied public
  assistant-ui runtime. Opening or closing a visible panel invokes no model and
  cancels no host-owned run. Main runtime construction is unchanged.
- Give every pane its own runtime provider, error boundary and composer input
  identity; callbacks and `threadKey` name the same conversation.
- Size a child provider's error row so it reserves its own height inside the
  bounded flex column; the transcript and composer take the rest. An error never
  pushes the composer below the pane.
- Host integration limits and the paired runtime/browser tests live in
  `assistant-subagents.md`.

## Native suspension completion

- Await Mastra's public `getFullOutput()` on the initial, approval-resume and
  suspended-tool-resume legs before publishing a terminal pause or completion.
  Native pause parts can precede durable snapshot storage, so an immediately
  submitted decision must find the snapshot and runtime disposal must not race
  its writer.
- Keep an already-mapped terminal error on a provider error part instead of
  rethrowing it through the completion accessor. A synthetic steered step-finish
  skips the join and aborts without consuming later native work.
- Fail the stream on a failed native snapshot write rather than exposing an
  unresumable decision.
- **A pause part does not end the leg's read.** `streamAttemptChunks` reads to
  native close. Withhold each pause's decision-exposing chunks
  (`isPauseNoticeChunk`) and publish them together behind the completion join;
  the leg then ends ONCE with a `tool-calls` finish (`resolveLegPart` strips the
  per-pause finish, `concludeClosedStream` emits the leg's).
- A resumed leg whose sibling calls stay suspended closes with no pause part and
  a `getFullOutput()` that rejects; `readNativeStreamStatus` reads the
  synchronous `suspended` status, skips the join, and ends as the pause it is.
- Exit rules for withheld notices, each drained where published so no exit
  repeats one: a rejected completion join DISCARDS them; an explicit root Stop
  drops them; any other later failure in the leg and a genuinely missing finish
  PUBLISH them ahead of the failure or synthetic ending.
- Scoped chunks never nest at this seam: a child leg withholds its own children's
  notices in its own loop, and the continuation layer wraps only published
  chunks.
- Keep every notice actionable across legs in the renderer and lock the buttons
  while a leg streams (`actionLockedByRun`).

Settled: a pause part does not end the leg's read (2026-09-14). Evidence:
`assistant-runtime/pause-part-does-not-end-leg.md`.
Guard: `packages/agent/src/__tests__/specialist-fanout.integration.spec.ts`,
`packages/agent/src/__tests__/resumed-worker-context.integration.spec.ts`.

## ASSISTANT RESILIENCE (CRITICAL)

The assistant tool→stream chain never freezes the thread. Four layers are LIVE:
the renderer safety net, the per-tool guard, the stream inactivity watchdog, and
the Mastra error-processor layer.

### Renderer safety net

- `packages/assistant-ui/src/assistant-panel-error-boundary.tsx` wraps
  `ChatThreadUI` inside `AssistantRuntimeProvider`, so reset preserves the
  runtime. The data-stream adapter surfaces transport errors via `onError` and
  rethrow; it never swallows them.
- Render a run rejected before any stream part as a visible error block:
  `AssistantMessage` mounts `AssistantMessageError` (ErrorPrimitive) for a
  zero-part message. Put the styling on the error-conditional `Message`, never on
  the always-rendered `Root`.
- The adapter owns a 30-second combined watchdog over asynchronous auth-header
  and request-body preparation before `fetch`, passing an internal abort signal
  through the body-preparation seam. Stop aborts that work immediately; expiry
  throws `AssistantRequestPreparationTimeoutError` through the same zero-part
  error path. A prepared run resolving after Stop or expiry is terminally
  completed as cancelled/failed and never becomes the active fetch body. Invalid
  watchdog values throw; they never disable the bound.
- Run built-in local model warmup in a separate pre-watchdog phase (it can
  include a visible multi-file download). Stop detaches the assistant run from
  the warmup immediately while the shared renderer-host download continues with
  visible broadcast progress. Auth headers, request persistence and request-body
  construction share the bounded watchdog for every provider, local included.
- Read the optional desktop assistant transport through `getAssistantBridge()`
  from `@brainstrike/assistant-contract`, which owns the `window.assistant`
  shape, returns no capability on web/SSR, and reports a malformed bridge at most
  once per renderer process. Do not recreate local bridge interfaces, unchecked
  double casts, or web stubs.

### Per-tool guard

- `applyToolGuards` (`packages/agent/src/tools/guard-tool-execution.ts`) wraps the
  combined Mastra tool map in `createMastraAgentRuntime`'s tool pipeline
  (`packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts`) after local and
  MCP tools are sanitized and discovered.
- Resolve tool timeouts and throws to structured `GuardedToolError` payloads and
  surface them as FAILED tool events, never successful completions. Delegated
  `tool-result` parts use the same display projection and canonical guarded-error
  classification as root results; native `isError` alone cannot classify a
  guarded failure.
- Keep a redacted `tool_failed` message for a generic exception (it may carry host
  paths or secrets). A trusted `ToolInputError` keeps its bounded,
  model-correctable message as `tool_input_invalid`; only application-owned
  validation code constructs that error.
- **The budget is PER CALL, not one flat ceiling.** A native tool declares
  `executionBudget: { defaultMs, maxMs }` on its `defineNativeTool()` definition
  (validated at definition time).
  `packages/agent/src/tools/resolve-tool-guard-budget.ts` is the SINGLE place the
  `{ grantedMs, guardMs }` arithmetic lives. A tool that declares no budget keeps
  the flat `BRAINSTRIKE_TOOL_TIMEOUT_MS` default.
- Grant a declared budget to LOCAL tools only: `tool-pipeline.ts`'s `budgetFor`
  matches on the SANITIZED local tool id, never on name equality, so a
  third-party MCP tool named like a native one cannot inherit its budget. Every
  MCP tool keeps the flat default until BST-1779 extends declared budgets to MCP.
- State the GRANTED budget in `formatToolTimeoutMessage`, never the guard window,
  and offer the larger-timeout remedy ONLY when `grantedMs < declaredMaxMs`. Tell
  a call already at the declared max to split the work instead. Units: seconds in
  prose; the one parameter VALUE is labelled `ms`.
- **`resolveGuardedToolSignal` is mandatory for any tool that owns a process or a
  network request** (`packages/agent/src/tools/tool-guard-deadline.ts`). The guard
  stops the WAIT, not the work, so fold the guard deadline into the tool's own
  signal. It returns the execution signal BY IDENTITY when there is no deadline,
  because `retainRawMcpCallToolResult` keys on that identity.
  `manageCommandSession` deliberately does not fold it in — a session outlives any
  one guarded call.
- **The guard also CANCELS the work it gave up on.** It publishes a deadline
  `AbortSignal` and aborts it BEFORE resolving `tool_timeout`. The seam is keyed
  by TOOL-CALL ID through the single `readToolCallId` reader, never by execution-
  context identity. Registration returns a release the guard runs in its
  `finally`. The MCP runtime client folds the deadline into its `tools/call`
  signal without replacing `context.abortSignal`, so the SDK sends
  `notifications/cancelled`. A call with no tool-call id publishes nothing and
  keeps the pre-guard behaviour. The id is PROVIDER data: the later registration
  wins and the collision is LOGGED at `error`, never thrown.

Settled: the budget is per call; the guard cancels its abandoned work; the
keying is by tool-call id. Evidence: `assistant-runtime/tool-guard-budgets.md`.
Guard: `packages/agent/src/__tests__/mcp-tool-guard-cancellation.integration.spec.ts`
(real spawned stdio child).

### Stream inactivity watchdog

- `packages/agent/src/stream/with-inactivity-timeout.ts` (`withInactivityTimeout`,
  `StreamStalledError`) wraps the raw Mastra iterator in `streamAttemptChunks`.
- The window is PHASE-AWARE across four phases: `awaiting-output`, `reasoning`,
  `streaming`, and `tool-executing`. Keep them separate — see the config list
  below. A stall ends the ATTEMPT, not the turn. Only an unrecoverable stall emits
  a visible assistant message, a terminal `run.failed` event, and an error finish.
- **Only a GUARDED call may enter `tool-executing` — an ALLOW-list, not a
  deny-list.** `hasExecutionGuardBehindToolCall` (`agent-streaming.ts`) tests a
  tool name against `runtime.toolNameMap`'s KEYS, exactly the set that went
  through `applyToolGuards`. Anything not in it defaults to `false` and stays on
  the tight window. Provider-executed tools, subagent delegation tools and
  Mastra-injected memory tools are deliberately never in the set and keep riding
  the ordinary provider-silence windows.
- Track the phase by REFERENCE COUNT on `toolCallId` so parallel calls hold it
  open until the last settles, and let it OVERRIDE the current provider phase.
  `tool-call` is `started`; `tool-result`, `tool-error`, `tool-output-denied`,
  `tool-call-approval` and `tool-call-suspended` are `settled` — approval and
  suspension settle deliberately, because the call is waiting on a HUMAN.
  Scaffolding (`start`, `step-start`) CLEARS its own producer's in-flight set.
- **Classify a DELEGATED child's calls through the envelope.** UNWRAP a
  `tool-output` whose `toolName` starts with `SUBAGENT_DELEGATION_TOOL_PREFIX`
  and is not itself `providerExecuted` — POSITIVE identification, never "not in
  the guarded set". Apply the same allow-list to the nested part, recursing for a
  grandchild under a fixed unwrap bound.
- **Each BACKGROUND task is its own producer LANE** (`createMastraStreamPartRouter`):
  its own phase and in-flight set, read inside the task's envelope, closed by
  its terminal or suspension. Lifecycle events and host rows move no phase. Wait
  on the WIDEST open lane; a call in flight in ANY lane reports `tool-executing`.
- **Seed a resumed, approval-approved call into the phase.** Mastra never replays
  a suspended step's `tool-call` part, so `collectResumedGuardedToolCallIds`
  passes the resumed call plus its siblings — filtered through the same
  `hasExecutionGuardBehindToolCall` predicate — as `initialToolCallIds`. Gate the
  scaffolding clear on `hasSeenProviderOutput` so a seeded id survives leading
  scaffolding.
- A `tool-executing` stall is TERMINAL: `isRecoverableStall` (`turn-attempts.ts`)
  refuses recovery with `tool-still-executing`, because a continuation could
  launch a SECOND execution of a tool that may still be alive.
- Every GUARD window is below `toolExecutingMs` by construction, so a guard that
  answers is never pre-empted. Tool-lifecycle HOOKS are NOT covered: they compose
  outside the guard and are capped only individually. Keep
  `resolveStalledVisibleMessage`'s wording honest about that; do not add an
  aggregate hook cap or a new env knob without a measured case.
- **An EMPTY MODEL RESPONSE rides the same attempt rails.** A terminal `finish`
  on a turn the model contributed nothing to — no text/reasoning delta carrying a
  non-whitespace character and no tool-lifecycle part, across every attempt
  (`ToolLifecycleState.sawModelContribution`; resume legs initialize it true) —
  throws `EmptyModelResponseError` from the mapper's `finish` case. Do NOT
  re-classify an abnormal finish reason: it already fails the run with its own
  truth (`COMPLETED_FINISH_REASONS`, shared with `makeTerminalRunEvent`).
- `withToolCallInputTimeout` applies its own, much wider
  `BRAINSTRIKE_TOOL_CALL_INPUT_MS` window as an absolute deadline from the first
  streamed tool-input marker to its matching input end. `tool-call-delta` renders
  progress but never extends that deadline. Keep the two windows DECOUPLED. Expiry
  uses `tool_call_input_streaming_timeout` and aborts before an incomplete call
  can execute.
- Every initial, approval-resume and suspended-tool-resume stream owns an internal
  AbortController linked to the caller's signal. The watchdog rejects with
  `StreamStalledError` FIRST, then aborts that controller, so provider work cannot
  outlive the terminal stream and the timeout is not misclassified as a user
  cancellation. Teardown also aborts before disposal. For the built-in local
  provider the signal crosses `LlmHostChatModel → LocalLlmHostClient →
  LlmHostManager` and sends the hidden renderer's cancel command.
- On watchdog expiry or caller Stop for a memory-backed turn, the abort seam
  (`mastra/aborted-turn-persistence.ts`) persists the user input, every assistant
  message with partial text RETAINED, and only COMPLETED tool invocations, appends
  `[Assistant turn aborted before completion.]`, and AWAITS the save before
  runtime disposal. Incomplete tool calls are the one exclusion, so Stop cannot
  resurrect execution next turn. Ordinary completion still uses Mastra's finish
  writer only; teardown never performs a second normal write.
- Delegated children's abort snapshots follow `assistant-subagents.md` § Cancelled
  child transcript durability, joined before attempt replacement and disposal.

Settled: the phase boundary is provider output, not the first part; a running
tool is never measured against a provider-silence window; Mastra's
`tool-execution-start`/`-end` chunks are not the boundary. Evidence:
`assistant-runtime/stream-watchdog-phases.md`.
Guard: `packages/agent/src/__tests__/mastra-stream-first-output.integration.spec.ts`,
`packages/agent/src/__tests__/mastra-stream-watchdogs.integration.spec.ts`,
`packages/agent/src/mastra/__tests__/mastra-background-watchdog-lanes.spec.ts`.

### Mastra error-processor layer

- `packages/agent/src/mastra/error-processors.ts` is wired into `new Agent`
  (`agent-runtime.ts`) plus `buildToolLoopOptions`
  (`runtime-assembly/stream-options.ts`). It adopts three `@mastra/core`
  built-ins that recover on EMITTED provider/API errors — disjoint from the guard
  (tool-execute failures) and the watchdog (silent stalls), so nothing is
  double-wrapped.
- **StreamErrorRetryProcessor** retries transient mid-stream errors with capped
  exponential backoff, sets `retryUnknownErrors: true`, surfaces known-terminal
  authorization failures (401/403 or `invalid_api_key`-class codes, walked
  through the cause chain) immediately with NO retry, and pins `maxRetryAfterMs`
  to the same ceiling as the backoff cap so neither our wait nor a provider
  `Retry-After` can stall past it. The wait is abort-aware.
- **ERROR-PROCESSOR ORDER IS LOAD-BEARING.** The stack is [PrefillErrorHandler,
  ProviderHistoryCompat, StreamErrorRetryProcessor]: Mastra's ProcessorRunner
  returns at the FIRST processor requesting a retry, so the fixup processors must
  see the error before the unknown-error retry.
- **PrefillErrorHandler** recovers reloaded-thread assistant-prefill rejections;
  **ProviderHistoryCompat** handles cross-provider `mastra_messages` reuse.
- Placement: the two `processAPIError`-only processors plus ProviderHistoryCompat's
  REACTIVE rules go on the Agent-config `errorProcessors` seam.
  ProviderHistoryCompat's PREEMPTIVE `processLLMRequest` rules (strip foreign
  reasoning — the ONLY place that incompatibility is handled) fire only from
  `inputProcessors`, so a SECOND instance is composed into the per-call
  `inputProcessors` array alongside the TokenLimiter, composing rather than
  clobbering.
- Keep `maxProcessorRetries` pinned (`ASSISTANT_MAX_PROCESSOR_RETRIES = 3`): any
  `errorProcessors` flips Mastra's implicit default to 10.
- EXCLUDE the whole layer for the built-in local provider; the hidden llm-host
  owns its own engine-fault recovery.

### Provider errors, tripwires and finish reasons

- Classify every provider/model error at the single stream-mapper choke point. No
  provider-specific fetch wrapper or retry-attempt instrumentation participates.
- The terminal `run.failed` event carries one namespaced `metadata.runError`
  object with exactly `code`, optional `message`, `causeChain`, `httpStatus`,
  `providerRequestId`, `responseHeaders`. When the code is off the stable
  allowlist, classify by provider evidence:
  `mastra_agent_stream_provider_error` when the bounded cause walk found an
  `httpStatus`, `providerRequestId`, allowlisted `responseHeaders` or an AI SDK
  api-call marker, and `mastra_agent_stream_local_error` when it found none. A
  local runtime fault must never wear the provider label, nor the reverse. Emit at
  most four bounded cause strings; end every truncated string with
  `… [truncated]`.
- Response headers are a literal, case-normalized allowlist limited to rate-limit,
  `Retry-After` and provider request-id variants. Request/response bodies,
  arbitrary `data` or provider metadata, request headers, URLs, credentials and
  retry-attempt payloads never enter the event. `readProviderRunError` /
  `isProviderRunError` are the strict consumer boundary; downstream integrations
  do not hand-parse event metadata.
- Terminate content-policy tripwires through their own
  `mastra_agent_stream_tripwire` diagnostic; they never carry the provider
  `metadata.runError` envelope. Read the canonical
  `{type:'tripwire', payload:{reason,retry?,metadata?,processorId?}}` payload.
  Sanitize arbitrary metadata by value shape before persistence or logging, cap
  the visible/durable/logged reason at the shared 600-character provider-error
  limit, enumerate malformed fields in `metadata.tripwire.malformedFields`, and
  produce an explicit visible compatibility error for a missing reason rather than
  the bare word "tripwire". Remove the tagged legacy `tripwireReason` reader only
  alongside a Mastra compatibility-baseline change and its regression test.
- The provider-error termination log is the durable correlation choke point: copy
  `runId`, `threadId`, `resourceId` from `runtimeData.memory` and `rootId` from
  the server-validated `runtimeData.boundWorkspaceRootId` into the structured
  logger context argument. Never use logger bindings, ambient async context,
  `mainRootId`, or an inferred-root fallback; an absent identity stays absent.
- Hosted agent loops default to 100 model steps with no explicit lower limit. The
  Output & Limits UI describes that finite default truthfully. Output-limit
  finishes are terminal failures: `finishReason: length` emits `run.failed`, an
  error finish, and a failed durable run outcome.
- **EVERY error finish is a failed durable outcome, not just `length`.**
  `handleFinish` sets `terminalFailureText` for an `'error'` finish WITHOUT
  emitting a visible message, taking the text from the preceding `run.failed`
  event's **`detail`** and falling back to `ERROR_FINISH_FALLBACK_TEXT`. Do not
  make `getAbnormalFinishMessage` return a string for `'error'` — that
  reintroduces the duplicate visible message. `tool-calls` and `stop` remain
  `completed`. `makeRunFailedChunk` carries the detail and stays a separate helper
  so a positional slip cannot write a timestamp into the detail field.
- **A provider-evidenced HTTP 401 is a REJECTED CREDENTIAL and the visible detail
  says so**, with the remedy keyed by the run provider's registry `authType`
  (`resolveProviderError`, `mastra-chunk-decoding.ts`). Adding a registry
  `authType` is a compile error here until it picks a remedy. Guidance comes FIRST
  so the clamp can only shorten the provider's own text. 401 is the ONE
  wrong-credential status, mirroring the Settings "Test connection" classifier.
  The `runError` envelope is unchanged; only the detail changes.
- **Finish-reason absence is distinct from a raw unsupported value.**
  `readFinishReason` / `resolveFinishReason` preserve a missing, empty or
  non-string field as the internal `'absent'` sentinel; the AI SDK's literal
  `'unknown'` also remains completed. Only a non-empty raw value outside the
  SDK/Brainstrike union becomes `'unrecognized'`, emits `run.failed`, surfaces the
  explicit message, and persists `thread_runs` as failed. Map `absent` to the
  wire's completed `unknown` and `unrecognized` to the terminal `error` before
  data-stream serialization. Intermediate steps start as `absent`. Never infer
  provider failure from the AI SDK `unknown` value.

Settled: the provider/local split is evidence-based; the 401 remedy is keyed by
`authType`; an error finish is a failed durable outcome. Evidence:
`assistant-runtime/error-processors-and-run-errors.md`.
Guard: `packages/agent/src/__tests__/mastra-error-processors.spec.ts`,
`packages/agent/src/mastra/__tests__/mastra-chunk-decoding.spec.ts`,
`packages/agent/src/__tests__/mastra-stream-termination.spec.ts`.

### Raw/model tool-output split

- `createMastraAgentRuntime` composes tools in this order (the stage sequence
  lives in `runtime-assembly/tool-pipeline.ts`): `sanitize/discover → timeout
  guard → lifecycle hooks → plan/permission/suspend gates → provider-native swap
  → artifact settlement → model-output projection → Agent`.
- The unregistered MCP Apps path captures its admission capability immediately
  after the plan/permission/suspend gates. Admission returns an opaque one-use
  executor bound to the exact post-gate tool entry and server/tool identity; the
  Apps preparer has no separate invocation, guard or hook injection seam. The host
  authority creates a generation-bound preparation id and requires its paired
  release callback to settle before a denied or cancelled call completes. A tool
  omitted by any ordinary gate is absent and fails visibly. Replaying a bound
  executor fails visibly.
- Project through Mastra's native `toModelOutput`, so the mapping observes the
  post-hook execution result without replacing it. A discriminated internal
  carrier takes PostToolUse context to `toModelOutput`; Mastra's official
  display/transcript transforms unwrap it so live consumers and the durable
  transcript retain the exact domain result.
- Generated/default projections use the 2000-token / 8000-serialized-character
  ceiling. Purpose-built domain projectors MUST self-fit complete output within
  the run's context-window-scaled default and fail loudly on overflow; the central
  seam never truncates an opaque page after its continuation was computed. Guarded
  failures bypass custom projectors.
- Strip successful PostToolUse metadata before projection, then append its context
  centrally without reordering content and fit it into the remaining final
  envelope. Only hook context may be truncated at that composition stage. The
  `skill` activation exception keeps its complete instruction budget plus a
  dedicated bounded hook allowance and structural reserve.
- Invoke a reused parent-owned tool under a save/restore active-budget context for
  the synchronous custom-projector call, so a pinned child producer fits the
  child's resolved tier. Every desktop custom projector is synchronous and the
  context is restored before any returned Promise can be observed.
- Never shape-guess `{toolCallId,input,output}` as adapter metadata — that exact
  object is valid domain evidence. A future direct AI SDK adapter belongs at a
  separately typed boundary.
- A purpose-built projector that emits a recognizable canonical envelope MUST
  accept its own envelope idempotently, because Mastra may replay a stored
  `providerMetadata.mastra.modelOutput` through it. Validate stored/settled replay
  against the fixed ceiling tier and fresh projections against the per-run tier;
  never reinterpret arbitrary lookalike domain objects.
- `ModelOutputProjectionObserver` receives `(toolName, output)` at the final
  projection seam. `RunTokenDiagnostics` retains one privacy-safe per-call sample
  (tool id, serialized model-facing character count, booleans only) and emits one
  internal `tool-call-telemetry` chunk before the terminal finish; a run without
  the desktop run-persistence capability discards it before renderer
  serialization. Recognize generic truncation only from a final
  `{type:'json', value:{truncated:true}}` projection; attach zero-match,
  request-offset and typed truncation metadata in a private WeakMap so no
  projected-text parsing or user search data enters telemetry.
- At run end the same instance may emit one `token-estimate-calibration` chunk.
  Emit it whenever there is something new to report — a measured tool-output
  projection, a `promptBreakdown` to source a baseline from, or both — and skip it
  only when neither is available. Both resume iterators compute `promptBreakdown`
  from the resumed runtime's own breakdown with `messages: []`. The
  `model_visible_projection_count > 0` ratio-eligibility gate lives in the
  `estimator-calibration.sql` lens, not the writer.
- Pre-request conversation compaction reads the latest thread-scoped calibration
  row whose `prompt_baseline_tokens` is NOT NULL and triggers on
  `previousPromptBaseline + conversationMessageTokens >= 0.90 * inputBudget`. The
  deterministic message-side target is
  `max(1024, 0.70 * inputBudget - previousPromptBaseline)`.
- Run that lookup CONCURRENTLY with the unprojected-message load (`Promise.all`),
  never sequenced after it. A missing row uses baseline 0 at `debug` under
  `conversation_compaction_baseline_unavailable`; a failed read or a
  corrupt/out-of-range value also falls back to 0 but at `warn` under its own
  distinct code.
- When the baseline alone is at or above the 70% target, recency pruning and the
  deterministic path toward the 1024-token floor STILL run; only the AGENTIC
  summarizer is skipped, under `conversation_compaction_baseline_exceeds_target`,
  latched once per thread per process. `createContextOverflowRecovery` is a
  separate path and stays enabled.
- With a trusted `toolOutputArtifactStore`, settlement-wrap the final native/MCP
  tool map after policy/provider transforms and before `toModelOutput`. Fully
  retain non-media results above 12,000 UTF-8 bytes before an artifact envelope
  reaches display/transcript. MCP settlement also consults the generic model
  projector before retaining an otherwise-inline result: compare the actual
  bounded value with complete source text including JSON escaping and the domain
  reserve, and settle on any loss. No second size constant approximates the model
  projection.
- Store the complete raw output before publishing a recovery page; storage
  failures fail visibly. Runtime settlement requires an explicit reader resolver
  that resolves exactly ONE eligible reader from the canonical name map before
  storage; zero or multiple matches fail visibly without writing an artifact.
- MCP Apps retain their complete marker, origin and ordinary result in
  display/transcript output; only the ordinary result is serialized for model
  artifact recovery. Apps media takes the inline media path. Keep the eligible
  artifact reader on the core discovery surface so recovery never requires a
  search call.
- `brainstrike.webExtract` uses the smaller of 2400 characters and the run's
  resolved domain-projection character budget. With no durable store, an oversized
  extract produces an explicit model-output-unavailable projection; it never
  silently clips source text.
- Keep the original in-process result and authenticated PostToolUse context in a
  module-private WeakMap carrier, away from public persistence. After settlement,
  bypass any domain projector and project a bounded initial-page view that omits
  the redundant artifact reference and carries one concrete reader/cursor action,
  recomputing its cursor if the preview must shrink. Public-shape guessing is
  forbidden. Storage failure, a missing tool-call id, incoherent returned metadata
  or output above the 16 MiB settlement cap throws visibly.
- Exclude the `skill` tool (its instruction payload cannot be paged) and MCP
  image/audio `content` arrays (they stay inline for display/transcript and retain
  their aggregate media plus non-media metadata ceilings).
- Desktop builds `brainstrike.readToolOutputArtifact` only when server-owned
  resource and thread scope plus the database bridge exist. The registered model
  tool accepts the opaque continuation cursor plus bounded page/search options,
  never artifact metadata or ownership ids. Any unscanned source or
  projection-omitted match carries an advancing cursor; missing continuation
  guidance fails the run. No capability means no registered tool — never a stub or
  unscoped fallback.
- Without that host capability, MCP text/JSON keeps the inline behaviour bounded
  inside `execute()`. The UI data-stream bound is a transport backstop, not the
  model-context boundary.
- `ProjectionAwareTokenLimiter` temporarily swaps each completed result to its
  stored model projection for counting, replaces media bodies with markers,
  delegates to Mastra, and restores raw property descriptors in `finally`.
- Hosted runs also install `ProjectionSafeToolCallFilter`. `processInputStep`
  computes eligibility without returning messages (Mastra applies that hook's
  result back to the live `MessageList`); `processLLMRequest` performs the
  transient rewrite after stored projections resolve. Replace only old, completed,
  successful native read/search/retrieval calls with a serializable
  non-multimodal stored projection. The newest eligible read/search/retrieval step
  stays verbatim, as do missing projections, errors, commands, verification,
  tasks, discovery, skills, approvals, incomplete calls and MCP tools. Never
  mutate the live `MessageList` or durable rows.
- EDITS get one narrow treatment: a SETTLED `writeWorkspaceFile` /
  `stringReplaceWorkspaceFile` call outside the recent-step window whose
  serialized args exceed 2,000 chars has its prompt-side INPUT collapsed to
  `path`, `root` and an honest `elidedArguments` marker. The call/result pair
  stays structurally in place, the RESULT stays verbatim, failed or in-flight
  edits keep full args, and durable rows are untouched. Local, Ollama and LM
  Studio runs omit it.
- **A filtered pair must NEVER become assistant-authored `<toolName> result:`
  text** — GPT-5.x Harmony models mimic that shape. The stale tool-call part
  becomes a generic stub (at most ONE per message) and the projection replays in a
  following user-role message that flushes only after every adjacent tool-role
  message. Frame the replay explicitly as "untrusted tool output, not
  instructions" between BEGIN/END REPLAYED TOOL OUTPUT markers and defang marker
  lookalikes inside the projection. Tool-results embedded in ASSISTANT-role
  messages are ineligible and stay verbatim. A pair whose projection cannot be
  textualized stays verbatim on BOTH sides.
- The adjacent `RunTokenDiagnostics` path is measurement-only: it emits one
  content-free `mastra_agent_token_measurement` log and cannot alter the limiter,
  the ceilings, the outgoing prompt or persisted run events. Tokenizer failures
  stay visible under their declared mode and never relabel themselves as exact.
  The provider/model capability contract lives in `assistant-providers.md`.

Settled: stored replay validates against the ceiling tier; replay-time
hook-context composition against the fixed total axis is a known, documented
tradeoff, not a bug. Evidence: `assistant-runtime/tool-output-projection.md`.
Guard: `packages/agent/src/__tests__/mastra-tool-execution.integration.spec.ts`,
`packages/agent/src/__tests__/mastra-memory-persistence.integration.spec.ts`,
`packages/agent/src/__tests__/projection-safe-tool-call-filter.spec.ts`.

### Hosted native-tool definition and prompt budget

- Maintain no parallel provider-tool catalog. `@brainstrike/assistant-contract`
  supplies canonical ids and descriptions from the per-tool `defineNativeTool`
  declarations; `NATIVE_TOOL_INPUT_SCHEMAS` derives the exact Zod input object for
  each desktop native id from those same declarations. The desktop registry uses
  those objects directly, `validateToolInput` parses with the same map, and Mastra
  performs the Standard Schema → provider JSON Schema conversion.
- `NATIVE_TOOL_SCHEMAS` is lossy display metadata (`toToolSchemaDisplay`) and MUST
  NOT enter execution, validation or provider registration.
- Guard the hosted surface at both sides of Mastra's conversion boundary: the
  authored full-registry red baseline fits within 7,900 `o200k_base` tokens, and
  the live actual Mastra/OpenRouter core surface plus resolved instructions fit
  within 5,000. Enable a representative workspace skill in the fixture — a
  registry measured without `workspaceSkills` is an undercount. The authored guard
  is not evidence for the provider payload.
- The per-call input-processor order is SkillsProcessor → ToolSearchProcessor →
  ProjectionSafeToolCallFilter → ToolProjectionRewriteProcessor →
  ProviderHistoryCompat → OpenAIToolSearchHistoryCompat →
  OpenAIDuplicateItemCompat → ProjectionAwareTokenLimiter. The OpenAI-only
  compatibility seams are absent for every other provider; token limiting is
  always last.
- OpenAIDuplicateItemCompat canonicalizes duplicated OpenAI item references at the
  transient boundary without trading one 400 for another: reasoning/text ids keep
  their newest occurrence; a tool call and its output are kept as the newest
  COMPLETE pair; trailing reasoning in an edited message is swept; emptied
  messages are removed. Within-message repeats are untouched and durable history
  is never mutated. It runs after the other compat rewrites.
- Initial streams, approval resumes and suspending-tool resumes reuse the same
  discovery and history-filter processor instances, so same-process approval
  executors stay available while persisted discovery results provide restart
  reconstruction.
- Default instructions state cross-tool routing and non-negotiable invariants
  once; canonical descriptions and schemas carry per-tool mechanics. See
  `docs/agents/workspace-context.md` for the instruction invariants that cannot be
  compacted away.

Evidence: `assistant-runtime/native-tool-prompt-budget.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`
(real desktop registry + real hosted runtime; an isolated description, schema
estimate or hand-built provider payload is not sufficient evidence).

> **LIVE validation requirement:** A prior attempt wired the guard + watchdog into
> the live path and BROKE real Mastra tool calling (hosted-provider tools silently
> stopped executing) while mocked tests stayed green. Future changes to these
> layers MUST preserve coverage that runs the actual Mastra agent loop end to end
> with real tool `execute`, not only mocked stream parts. The current proofs live
> in `packages/agent/src/__tests__/mastra-tool-execution.integration.spec.ts` and
> `mastra-error-processors.spec.ts`.

## MCP TASK STATUS AND RESTART CONTROLS

- `McpTaskStatusCard` is a controlled, browser-safe status surface, not a tool
  result card. It takes the bounded `McpTaskPresentation` contract plus one
  injected controller port; it neither imports the agent runtime nor reconstructs
  Tasks authority in the renderer. Recover and Cancel submit the complete opaque
  handle unchanged.
- The agent-owned controller revalidates protocol, capability, server/resource,
  principal and authority epoch before and after the existing
  repository/lifecycle/interaction authority runs.
- Keep the card truthful while actions are pending: recovery does not switch to
  live and cancellation does not show `cancelled` until the controller returns an
  observed state. Actions are single-flight by complete opaque authority handle;
  an authority-epoch or other handle replacement fences the stale outcome.
- Render stable diagnostics as a focused alert and move focus on success to the
  live status summary (a polite status region). Never render the identity; use
  fixed copy for unexpected authority errors rather than exposing paths or
  credentials.
- The component is exported for opt-in composition only. Host registration and
  advertisement of Tasks are governed by `docs/agents/assistant-providers.md`.

### TOOL-PATH WIRING (BST-1566)

The agent runtime's MCP tool path is production-wired for a created task
(`packages/agent/src/mastra/mcp-task-tool-result.ts`, consumed by `executeMcpTool`
in `mcp-runtime-client.ts`).

- **Capability, not environment.** Thread `mcpTaskTracking` exactly like
  `toolOutputArtifactStore`: runtime option → `composeRuntimeToolMap` →
  `createMcpRuntimeClient`, surviving `toAiSdkStyleStream`'s `optionsOverride`
  Pick. Only a trusted host composes it; web and host-less runs leave it absent
  and every MCP call stays synchronous.
- **Detection covers both wire shapes** — the bare `resultType: 'task'` result and
  the client extension registry's neutral envelope, unwrapped by
  `readRegisteredExtensionResult` (never re-implement the unwrap). Both parse
  through `parseMcpCreateTaskResult`; a malformed task throws and is never
  coerced. Detection runs before raw-result retention and the `isError` branch.
- **NO SILENT FALLBACK.** A task result on a runtime without `mcpTaskTracking`
  throws. The task is never dropped and never returned as raw state.
- **Identity.** `track()` receives `configuredServerId = server.name`, which IS
  the host authority snapshot's `configuredServerId`; `toolName` is the unprefixed
  MCP tool name.
- **App-originated calls return the wire task.** When the Apps admission executor
  marked the call for raw retention, hand the task to `track()` so the host owns
  it, then return the canonical `CreateTaskResult` unchanged WITHOUT awaiting
  settlement. This branch runs before the ordinary settlement branch; a
  tracking-less host still throws.
- **Bounded settlement.** After `track()`, await `awaitSettlement` with
  `timeoutMs = min(45_000, floor(0.75 × toolTimeoutMs))`
  (`resolveMcpTaskSettlementTimeoutMs`), so the wait is capped under the guard
  ceiling that is not observable from inside `execute`. A ceiling too small to
  hold any wait throws at runtime construction. Timeout is not an error: resolve
  `{ settled: false, reason: 'timeout', task }` and return the live presentation.
- **Persisted marker vs model projection.** The RAW domain result is
  `createMcpTaskToolInvocationResult(presentation)` (`{ kind: 'mcp-task', task }`).
  The MODEL-visible output goes through `toModelOutput`:
  `projectMcpTaskToolModelOutput` returns the bounded context projection for the
  marker and `undefined` for every other result. The projection never carries the
  control handle or raw task state and is tightened to the run's
  `domainModelResultCharBudget`.

Evidence: `assistant-runtime/mcp-task-tool-path.md`.
Guard: `packages/agent/src/__tests__/mcp-task-tool-result.spec.ts`, the "MCP task
results" block in `packages/agent/src/__tests__/mcp-runtime-client.spec.ts`.

### TOOL-PATH WIRING (BST-1572)

The ordinary model-initiated MCP tool path persists the renderer-owned Apps mount
marker when the executing tool definition advertises `_meta.ui.resourceUri`
(`packages/agent/src/mastra/mcp-app-tool-result.ts`).

- **Strict definition detection.** A definition with no own `_meta.ui` member is
  an ordinary MCP tool. Parse a present `_meta.ui` with `parseMcpAppToolMeta`
  BEFORE `tools/call`; invalid keys, shapes, visibility, size or a non-`ui://`
  resource URI throw visibly before the remote tool can execute. A valid `ui`
  object without `resourceUri` remains an ordinary result.
- **Ordinary calls only.** The Apps admission executor's `retainRawMcpCallToolResult`
  early return stays ahead of Apps marker construction; the marker is built only
  on the ordinary model-initiated path.
- **Ordering and ordinary result.** Created Tasks settle to their task marker
  first (except app-originated raw-retention calls). For non-task calls keep the
  raw successful `CallToolResult` when there is no `structuredContent` or when
  media is present; otherwise use `structuredContent`. Canonical `isError: true`
  throws before any Apps marker exists.
- **Persisted marker and identity.** `createMcpAppToolResult` uses
  `serverId = server.name`, the unprefixed `toolName`, the strict `ui://`
  `resourceUri` and `mimeType: 'text/html;profile=mcp-app'`. Hook
  display/transcript transforms and bounded artifact settlement preserve this raw
  domain marker exactly as they do the Tasks marker.
- **Apps metadata never reaches the model.** `projectMcpAppOrTaskToolModelOutput`
  composes the Tasks projector with the Apps marker reader; the central
  `toModelOutput` seam unwraps `result` before the custom projector and before
  generic fallback. Definitions with neither Tasks capability nor `_meta.ui`
  retain no custom projector.

Evidence: `assistant-runtime/mcp-app-tool-path.md`.
Guard: the "MCP Apps tool results" block in
`packages/agent/src/__tests__/mcp-runtime-client.spec.ts`,
`packages/agent/src/__tests__/mcp-app-tool-call.spec.ts`.

### ATTEMPTS VS TURNS

A turn may span several provider ATTEMPTS. `runTurnAttempts` (`turn-attempts.ts`)
owns the turn; `streamAttemptChunks` (`agent-streaming.ts`) owns one attempt and
PROPAGATES a watchdog error instead of deciding the turn's fate. `runtime.dispose()`
lives in the turn's `finally` with exactly one owner across all three legs.

- **A stall ends the attempt.** Continue the turn with a fresh `agent.stream`
  carrying the original request plus everything the stalled attempt produced, read
  from Mastra's in-memory `messageList` on the stream result. Bounded by
  `BRAINSTRIKE_STREAM_STALL_ATTEMPTS`.
- Recover from the MESSAGE LIST, not memory: it is complete and synchronous, and
  re-sending the original request stays non-duplicative because Mastra's
  `saveMessages` upserts by message id.
- **`readProducedMessages()` returning `undefined` vs `[]` is SAFETY-CRITICAL.**
  `[]` means the attempt produced nothing, so continuing re-runs nothing.
  `undefined` means we could not tell, and continuing would re-execute every
  completed tool. A turn that cannot prove what it produced does NOT resume.
  CORROBORATE an empty list against `terminalToolCallStates`: `produced.length ===
  0` while tools demonstrably ran is a contradiction and also refuses recovery.
- **Five refusals, all terminal:** user cancel, budget exhausted, unreadable
  produced messages, produced messages contradicting completed tools, and
  `ToolCallInputStreamingTimeoutError`. Recovery covers `StreamStalledError` only.
- **Recovery is never silent.** Emit `run.stalled` per stall and `run.resumed` per
  continuation, both carrying attempt/budget and the stall's FULL breadcrumb
  (phase, parts-seen, `lastPartType`). A recovered stall's `run.stalled` is its
  only durable record, so it must carry the whole breadcrumb. A refused stall's
  `run.stalled` names the refusal.
- **Per-attempt state, EXCEPT billing.** Build `ToolLifecycleState` per attempt.
  Latency and in-flight lifecycle are per attempt; BILLING is per TURN.
  `stepBilledCostUsd` / `stepCount` / the billed-cost flags carry directly; TOKENS
  ride separate `carried*` fields because Mastra's finish usage is cumulative over
  ONE stream. Context sizes never accumulate.
- **A replaced attempt SETTLES what it started.** Drain both
  `makeCancelledDelegationRunEventChunks` AND `makePendingToolOutputRunEventChunks`
  before discarding the attempt — the same pair the terminal path drains.
- **One turn reports one `run.started`.** `withoutDuplicateRunStarted` drops the
  continuation's re-emitted `start`; `run.resumed` marks the new attempt.
- **A continuation that cannot be CONSTRUCTED terminates like everything else.**
  `handleStreamFailure` already disposes the runtime and rethrows, so the turn must
  not dispose again. The turn yields the same visible-text + `run.failed` +
  error-finish triple instead of throwing mid-stream.
- **Only the INITIAL leg recovers.** Approval- and suspend-resume consume a
  one-shot approval/snapshot, so they run the same turn runner with
  `maxAttempts: 1`.
- **Construction failures REJECT the returned promise** — the first attempt is
  built eagerly, before the generator is returned, so the renderer renders a
  transport rejection as an error block.
- **Construction errors retain cleanup failures.** Attempt runtime disposal once;
  if disposal also fails, carry both in an `AggregateError` cause and report
  incomplete cleanup explicitly. An original `MastraAgentError` retains its code
  and context; successful cleanup rethrows it unchanged.

Settled: recover from the message list; `undefined` never resumes; billing is per
turn. Evidence: `assistant-runtime/stall-recovery.md`.
Guard: `packages/agent/src/__tests__/mastra-stall-recovery.integration.spec.ts`
(every recovery case asserts the TOOL-EXECUTION COUNT),
`packages/agent/src/__tests__/mastra-streaming.spec.ts`.

Config lives in `packages/agent/src/config/resilience-config.ts` and parses
strictly — a malformed value THROWS. Read the file for defaults rather than
restating them here.

- `BRAINSTRIKE_TOOL_TIMEOUT_MS` is the FALLBACK per-tool guard budget, applying
  only to a tool with no declared `executionBudget`.
- `BRAINSTRIKE_STREAM_INACTIVITY_MS` is the tolerated gap once the provider is
  demonstrably ANSWERING.
- `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS` is the budget for the provider's first
  output, **per step, not per stream**.
- `BRAINSTRIKE_STREAM_REASONING_GAP_MS` is the tolerated gap between REASONING
  parts. A reasoning delta is not an answer: it shares the first-output budget
  because it asks the first-output question. The phase moves BOTH ways.
- `BRAINSTRIKE_STREAM_STALL_ATTEMPTS` is provider attempts per turn before a
  stall becomes terminal; `1` disables recovery.
- `BRAINSTRIKE_TOOL_CALL_INPUT_MS` is the maximum wall-clock time for one
  incomplete streamed tool input; argument deltas do not reset it.
- `BRAINSTRIKE_APPROVAL_STALE_MS` is the advisory age after which a REDISCOVERED
  suspended approval is flagged `stale`. Deliberately decoupled from the stream
  and tool windows; advisory only — both buttons stay enabled, never an
  auto-decline.
- `toolExecutingMs` is DERIVED, never configured: `resolveToolExecutingMs` sizes
  it from `MAX_NATIVE_TOOL_EXECUTION_BUDGET_MS`, which is itself derived from the
  native tool catalog. Never restate either number by hand.
- Enforce `<=` invariants only against EXPLICITLY configured values: stream
  inactivity <= tool-call input budget, <= first-output window, <= reasoning-gap
  window. An unset window widens to the inactivity window rather than throwing.
- Own the reasoning part set in `MASTRA_REASONING_PART_KINDS`
  (`agent-streaming.ts`), typed against Mastra's own `ChunkType['type']` union so
  a rename fails to COMPILE. CONTENT enters the reasoning phase; block bookkeeping
  markers only PRESERVE the phase already in effect.
- `MASTRA_SCAFFOLDING_PART_TYPES` (`start`, `step-start`) is a CLOSED list: a new
  Mastra provider part type defaults to "this is output", never to "this is free".
- A local-runtime inactivity termination includes the normalized provider and
  selected model in both the structured error log and the visible run failure.
  Never include bearer tokens; never silently restart or unload the external
  server. The timeout aborts the exact active provider request.
- The stall diagnostic and durable `run.failed` metadata carry `phase`,
  `partsSeen` (scaffolding included) and `lastPartType` — the last part the caller
  could NAME, leaving the previous name in place for an undescribable part. The
  visible text differs by phase. `describePart` supplies the Mastra part type from
  the call site; the timer module assumes no shape.

Settled: the first-output and inactivity windows stay decoupled (BST-839); the
phase boundary is provider output; a reasoning delta is not an answer. Evidence:
`assistant-runtime/resilience-config-rationale.md`.

Stream part continuity and tool-call args ordering:

- Run-event data parts (`aui-data`) CLOSE the active text/reasoning append in
  assistant-stream's accumulator, so `DataStreamMapper` DEFERS run events arriving
  mid text/reasoning and flushes them at the next boundary (tool start, approval,
  finish, error, stream end). Never drop them, never emit them mid-part.
- The mapper's four obligations are unchanged and deliberately more conservative
  than the pinned decoder requires: (a) defer aui-data parts while `openArgsCallId`
  is set, flushing after that call's `9`; (b) close an open args stream — emitting
  its `9` with accumulated args — before text/reasoning deltas, error/finish
  frames and approval/suspend notices; (c) prefer DEFERRAL over premature
  flushing; (d) close the window EAGERLY when a tool start already carries the
  complete input, so the window never spans tool EXECUTION.
- (b) stays load-bearing because `closeOpenToolCallArgs()` closes the argsText
  with no `9`; (d) stays load-bearing for LATENCY. Whether the args-specific half
  of (a)/(c) may be relaxed needs its own ticket and evidence — not a dependency
  bump.
- assistant-stream is pinned by the workspace catalog (`pnpm-workspace.yaml`),
  currently 0.3.41; read the pin rather than a version named in prose.

Evidence: `assistant-runtime/args-stream-ordering.md`.
Guard: `packages/agent/src/__tests__/data-stream-text-continuity.spec.ts`
(the BST-962 describe block and its `expectDecoderSafeArgsStream` sweep).

Completion, title generation and replay:

- The renderer's data-stream runtime defers assistant-stream's decoded
  `message-finish` until decoder flush, so an immediate next turn cannot abort a
  still-draining text controller. Aborted runs propagate the authoritative abort
  reason without surfacing cancellation teardown as a new assistant error; server
  subscriptions detach without double-closing their stream controller.
- Desktop assistant execution is owned by the main-process data-stream session,
  not one renderer HTTP response. A response close detaches only that
  subscription; the source continues to terminal state and stays replayable for
  the session retention window. User Stop is the distinct authoritative cancel
  path (`POST /assistant/cancel` with the validated run id). Do not infer user
  intent from navigation, renderer reload, or a dropped socket.
- `streamAttemptChunks` starts `Agent.generateTitleFromUserMessage` before
  yielding the terminal finish, and the generator's `finally` AWAITS that started
  task before aborting the internal controller or shutting down the per-run Mastra
  instance. The wait happens after the finish reaches the UI. Approval/suspend
  terminal parts and memory-free runs never start the task.
- Each desktop response exposes an opaque absolute replay cursor in
  `X-Brainstrike-Assistant-Event-Id` and the durable message identity in
  `X-Brainstrike-Assistant-Message-Id`. While the run is active the renderer
  stores only `{assistantMessageId, eventId, runId}` in thread-scoped
  `sessionStorage`, then reconnects after hydration with `GET /assistant/resume`
  plus `Last-Event-ID`; it never composes a second model request.
- Replay reuses the durable assistant message ID and its persisted parent rather
  than appending a duplicate. Remove the hydrated durable leaf before replay,
  reconcile the history append to the durable ID, and map the temporary local ID
  back through the public thread `export`/`import` API after assistant-ui's
  `runEnd`. Do not patch assistant-ui internals to add a message-ID input. A
  missing durable leaf, or a leaf with descendants, is a visible replay error,
  never a guessed parent.
- Give transient replay failures at most two automatic retries; a missing or
  expired session is a visible 404 that clears the stale renderer record.
  Terminal completion, failure or explicit Stop clears the record. Resolve the
  endpoint base from the assistant runtime API (`getAuth()`/`getUrl()`), never the
  legacy optional `window.assistant.url` field alone.

Evidence: `assistant-runtime/title-generation-and-replay.md`.

### ACTIVITY GROUPS

The assistant message renders its parts through `MessagePrimitive.GroupedParts`
(`packages/assistant-ui/src/assistant-activity-parts.tsx`) with
`groupAssistantActivityPart` (`assistant-activity-grouping.ts`) as the grouper.
The library's legacy `components.ChainOfThought` path is gone and must not return.

- Grouping: `reasoning` / `tool-call` join the activity group;
  `brainstrike.run-event` is group-transparent EXCEPT `isAlwaysVisibleRunEvent`
  kinds, which stay standalone so a collapsed group can never hide a failed or
  cancelled run, a skipped MCP server, or a pending approval; shell-output,
  context-breakdown and child-run-usage are transparent; tool-approval /
  tool-suspend cards, `text` and unknown data parts are standalone, because a
  pause is a real boundary.
- MCP-app tool calls stay inside the group: Brainstrike detects apps by RESULT
  shape only, and a call must not change groups when its result lands.
- A `group-activity` node holding only transparent data parts renders its children
  bare — no chrome, no `assistant-activity-group` test id.
- Pass `indicator="no-text"` to `GroupedParts` and drop the slot exactly when the
  TRAILING group holds an activity part (`trailingGroupHasActivity`). `"never"`
  blanks the bubble from Send until the first part arrives; suppressing on "any
  activity part anywhere" darkens the window where the slot is the turn's only
  live affordance.
- Chronology: each contiguous group renders at its own position. Never hoist later
  parts into an earlier group or suppress later groups.
- `ActivityGroup`'s `isActivityActive` is true when the group's own status is
  `running`; OR any of the group's ACTIVITY parts is `requires-action` (read the
  activity parts, never the raw `GroupPart.status`, which mirrors the group's LAST
  member); OR the message is still running, this group holds its last part, and
  the group's own status has not resolved to `incomplete`. Only the trailing group
  gets that last treatment.
- Derive the `Stopped` / `Activity failed` headline from the group's ACTIVITY
  parts, never from a transparent data member. Incomplete group status is
  authoritative (cancelled → Stopped, other reasons → Activity failed). A
  completed call with the canonical `isError` flag counts once into `· N failed`
  and never turns the group itself failed.
- Render live reasoning text directly from `useMessagePartReasoning`, never
  through the text-part renderer. Each reasoning part carries its own disclosure
  (open while streaming, collapsed once settled, a manual toggle sticks).
  Reasoning-only groups omit the step count.
- Correlate tool durations and shell output by call id across the message; each
  group's elapsed fallback uses only its own tool events. The turn-wide task list
  renders once, in the group holding the message's first activity part.
- **COLLAPSED BY DEFAULT at ALL times** — `ActivityTrace`'s `expanded` derivation
  is `userExpanded ?? false`, never `?? isActive`. An explicit user toggle sticks
  for the life of the mounted trace.
- `ActivityTrace` (`activity-trace.tsx`) owns the MARKUP only: the phase and every
  string derived from it live in `activity-trace-labels.ts`, and its two hooks in
  `use-activity-trace-clock.ts` / `use-label-enter-class.ts`. A `.tsx` file in this
  package exports components and nothing else, or Vite's Fast Refresh loses the
  boundary.
- The header is two rows: a status row (glyph, label, elapsed) and, only while
  active, a fixed-height one-line detail row (`bs-trace-detail`) entirely removed
  from the DOM once the group finishes — never a zero-height placeholder.
- Live label precedence in `summarizeActivity`'s `liveLabel`: `Waiting for
  approval` > `<Verb-ing> <target>` > `Thinking` > `Working`. The detail line names
  only the current running tool's target and carries no label of its own.
  `toolStepState` maps ANY `requires-action` status to `waiting`.
- The elapsed clock (`useElapsedMs`, gated by `isActive && !waiting`) pauses while
  the run is blocked on the user. `ActivitySummary.waiting` is the single source
  for both consumers and is NARROWER than the label: it requires a gated step AND
  no tool step still running. The badge stays visible but frozen, so the header's
  height never shifts.
- Scope that pause precisely: only the LIVE clock pauses, only while mounted. The
  reload-surviving value is `runEventsSpanMs`, which DOES include waiting time;
  within a session `useElapsedMs` re-anchors from whichever is larger. Nothing
  subtracts wait time from a persisted duration.
- At rest the headline is `restingLabel`: unique DONE-verb phrases in
  first-occurrence order, capped at three. Only verbs flagged `countsFiles`
  (`activity-verbs.ts`) carry a distinct-target file count, deduped on the
  untruncated `targetKey`. The flag is a property of the VERB, never its family.
- The meta reads `· Worked for Ns · N steps · N failed`, each segment carrying its
  own `·` and omitted when zero; `Stopped after Ns` continues its own headline as
  one phrase. When `Stopped after Ns` or `Activity failed` wins, demote
  `summary.verbs` — NOT `summary.resting` — into a `· <verb summary>` meta
  segment, so a `Worked`/`Thought` placeholder can never be demoted.
- `counts.failed` / `data-failed-steps` / `· N failed` count tool steps in state
  `failed` ONLY: a cancelled call is neither failed nor part of the verb summary.
- Bound the headline and live label on one line through
  `.bs-activity-summary-label` / `.bs-activity-live-label` in `overrides.css`, and
  keep the row's flex line stylesheet-owned. Why: the browser test lane has no
  Tailwind utilities, so a `truncate` class leaves the invariant unverified.
- `message.metadata.custom.brainstrikeActivitySummary` overrides the resting
  headline of a FINISHED group only: a non-empty post-trim string used verbatim,
  validated AND rendered trimmed; a non-string or blank value is ignored, never
  coerced. It never displaces a `Stopped` / `Activity failed` headline and never
  demotes into the meta slot. No producer writes this key today.
- Keep the layout fixed-height: the status row is `min-height: 2rem` and the phase
  glyph sits in a `1rem` box regardless of its contents.
- The live-label region carries `aria-live="off"` plus a visually hidden
  `aria-live="polite"` phrase that flips only on phase change. That live region is
  a SIBLING of the disclosure button, never a child — a button's children are
  presentational per ARIA and several screen readers prune the subtree. The
  button's name stays `Expand activity` / `Collapse activity` with
  `aria-describedby` pointing at the summary row.
- `.bs-trace-collapse` animates the OPEN direction only; the body also carries the
  `hidden` attribute that e2e and role-based queries rely on — do not remove it.
- Every verb lives in `activity-verbs.ts`'s `TOOL_VERBS`, total over
  `NATIVE_TOOL_IDS` and enforced by the `Record<NativeToolId, ActivityVerb>` type,
  so a tool added to the catalog without a verb fails to compile. Non-native names
  fall through `verbForTool`: delegation reads `Delegating to <persona>`, a dotted
  non-`brainstrike.` name reads `Calling server.tool`, anything else reads
  `Using <name>` rather than guessing.
- Test ids and data attributes are unchanged: `assistant-activity-group`,
  `assistant-activity-summary`, `assistant-activity-body`,
  `assistant-activity-working`, `assistant-activity-failed-count`, `data-active`,
  `data-failed`, `data-failed-steps`, `data-state`.

Evidence: `assistant-runtime/activity-grouping.md`,
`assistant-runtime/activity-trace-header.md`.
Guard: `packages/assistant-ui/src/__tests__/assistant-activity-grouping.test.ts`,
`packages/assistant-ui/src/__tests__/activity-verbs.test.ts`.

L1 step rows and L2 bodies (`activity-step-row.tsx` / `activity-trace-model.ts`):

- Each entry in `deriveActivitySteps`'s part-order list renders one
  `StepRowHeader` inside `.bs-step-list`: family icon · verb in tense · target
  chip · timing slot · state glyph · chevron.
- The ACTIVE tense covers `running` AND `waiting` (`ACTIVE_TENSE_STATES`): a call
  paused at its approval gate is in flight, and the glyph is what says why the
  step is standing still. Only `done`, `failed` and `cancelled` read the done
  tense.
- The target chip falls back to the TOOL ID when the args name no primary arg;
  `targetTitle` stays the untruncated primary arg, never the id. The timing slot
  renders only when the caller supplies timing.
- The row IS the card's own header: `ToolFallback`, `SubagentExecutionCard` and
  `TaskListToolCard` render it in place of a second header.
- `RowShell` splits into two forms. A card with something to expand renders a real
  `<button aria-controls aria-expanded aria-label>` whose accessible name CONTAINS
  its visible label (WCAG 2.5.3): verb and target lead, the affordance trails as a
  clause. The affordance wording (`Expand details` / `Collapse details`) is the
  e2e contract, matched as a SUBSTRING. Drop `aria-describedby` on a
  content-named row — content already in the name must not also be a description.
- `nameFromContent={false}` is the one opt-out, used by the reasoning row, whose
  `label` already names the step (`Show thinking` / `Hide thinking`). The prop
  defaults to the ACCESSIBLE behaviour so a later row is compliant by default.
- `aria-expanded` is always present; emit `aria-controls` ONLY while the element
  it names is mounted. A row whose body stays in the DOM opts back in with
  `controlsAlwaysMounted` — only the reasoning row does.
- A card with nothing to expand renders the non-interactive form: a
  `<div role="group" aria-labelledby>` with no chevron and no `aria-expanded`.
- Put the raw tool id in visually hidden text OUTSIDE the row's named content
  span, plus the row's own `title` (the e2e text contract). `trailing` — the
  result-summary chip, resolved-root chip and the subagent `· N tool calls` count
  — renders in that same OUTSIDE position, right after the content span.
- The interactive row's three a11y surfaces are disjoint: NAME is
  `<verb> <target>, <affordance>` from `contentAccessibleName`; DESCRIPTION is the
  raw tool id via `title` (HTML-AAM) and only that; TRAILING content sits in
  neither, staying reachable in browse mode.
- State glyphs are named, never colour-only: `STEP_STATE_LABELS`
  (`activity-step-tokens.ts`) is the total `role="img"`/`aria-label` map over
  `StepGlyphState`.
- ONE function derives a step's state, `toolStepStateFor`
  (`activity-trace-model.ts`), consumed by the trace headline, `ToolFallback`,
  `SubagentExecutionCard` and `TaskListToolCard`, so a step can never read two
  states on two surfaces. Both refinements on a generic `done` live INSIDE it
  (`settledResultOverride`, `runPythonStepState`); the only outside refinement is
  `resolveDelegationState`'s `no-answer`.
- `Waiting for approval` is a LIVE pause only: map `status.type ===
  'requires-action'` to `waiting` and nothing else. A resultless call on a settled
  message falls through to `settledResultOverride` and reads `Completed` on every
  surface — never a renderer guess.
- `readResultError` is the ONE reader of "does this result state an error" and
  "what does it say". It reads the success discriminator FIRST: an `ok: true`
  result stays `done` however its `error` member is shaped. Otherwise it
  recognises a non-empty `error` string, an `ok: false` envelope whose
  `error.message` explains it, or a result-level `isError: true`. The part-level
  `isError` flag is a separate branch supplying only the generic message.
  Ordering hazard: this branch runs BEFORE `settledResultOverride`, so a
  tool-specific reading can never soften a result that states an error.
- Exactly one live mark renders per running row: the state glyph.
  `ToolRunTiming` passes `showMark={false}`, and the reasoning row keeps its own
  indicator pair. Only the group's LAST running tool row shimmers
  (`deriveStepMeta` → `ActivityStepMetaProvider` → `useIsLastRunningStep`, which
  answers `true` outside any provider so a standalone running card still shimmers).
- Rows reveal with `bs-trace-reveal` and a positional `:nth-child` stagger capped
  at 5. The `:nth-child` rules set `--bs-stagger` on the list's DIRECT children
  (the wrappers) and the row reads it by INHERITANCE, so `.bs-trace-reveal` must
  default through `var(--bs-stagger, 0)` and never declare the property itself.
- A subagent delegation is a step whose verb names the PERSONA; `STEP_VERB`
  (`subagent-execution-card.tsx`) is total over `StepGlyphState`.
  `TaskListToolCard` uses `family="tasks"` with its own verb pair.
- `CheckpointRevertButton` is a SIBLING of the row inside `.bs-step-row-line`,
  never nested inside its `<button>`. It hides only for `running`/`failed`; a
  CANCELLED edit keeps its revert control, since a captured checkpoint means the
  mutation landed.
- `ToolFallback` (`tool-fallback.tsx`) is the composition ROOT only: the row is
  `ToolFallbackRow`, everything below it is `ToolFallbackBody`, and the pure
  derivations are `tool-fallback-state.ts`. `@brainstrike/assistant-ui/tool-fallback`
  stays the subpath `mcp-app-host-ui` imports, exporting only `ToolFallback`.
- Detail level maps to row behaviour via `resolveToolDisplayPolicy`: `compact`
  hides the details expander and result-summary chip; `standard` shows both
  collapsed; `developer` auto-opens the body and adds raw I/O.
  `SubagentExecutionCard`'s `· N tool calls` chip reads the SAME
  `policy.showResultSummary` gate, but its `expanded` is its own `useState`. The
  `in <root>` chip is NEVER gated by detail level.
- Only `developer` shows run-event rows inside the trace. Those rows are direct
  children of `.bs-step-list`, CONSUME `:nth-child` slots but carry no
  `.bs-trace-reveal`; `.bs-step-list`'s row rhythm makes an exception for them —
  see `ui-conventions.md`'s "Step rows" paragraph for the geometry.

Evidence: `assistant-runtime/activity-step-rows.md`.
Guard: `packages/assistant-ui/src/__tests__/activity-step-row.test.tsx`,
`packages/assistant-ui/src/__tests__/tool-fallback-a11y.test.tsx`.

HYDRATION LIVENESS (do not relitigate):

- Every animated "still happening" indicator carries `data-live="true"`, and a
  reloaded thread renders NONE unless a pause is genuinely pending.
- Part-derived status is safe by construction (hydrated messages are `complete`).
  Run-event rows are the hazard: a `running` row whose owning message has settled
  resolves to the renderer-only `'interrupted'` status, never persisted, unless a
  `brainstrike.tool-approval` / `brainstrike.tool-suspend` data part for the same
  `toolCallId` exists in the thread.
- Leave an ABSENT message status alone: liveness is never guessed. Subagent child
  rows follow the same rule.

Evidence: `assistant-runtime/hydration-liveness.md`.
Guard: `packages/assistant-ui/src/__tests__/assistant-hydration-liveness.test.tsx`.

### Renderer stream-insulation boundary

- `insulateAssistantStreamPipeline` (`packages/assistant-ui/src/stream-insulation.ts`)
  makes late-enqueue states STRUCTURALLY unreachable instead of racing them: the
  pipeline reads a guarded byte source that translates an expected transport abort
  into a clean EOF, and the consumer reads through a cancellation firewall.
  Cancelling the run cancels the byte source, never the pipeline, which drains to
  its natural close in the background.
- Because an insulated abort ends in clean EOF, `run()` re-throws the
  authoritative abort reason after the loop. An aborted run must never fabricate a
  successful finish.
- Completion wins only after the buffered terminal `complete` message has already
  been yielded, and that decision reads the flush-time flag surfaced by
  `deferMessageFinishUntilFlush`, NEVER the accumulated message's status —
  `AssistantMessageAccumulator.flush()` fabricates a terminal status for any
  stream that ends while running.
- Abort-gate the usage and context-breakdown taps so a draining stream cannot
  report late usage. Real faults stay loud: pre-cancellation pipeline/transport
  errors propagate to the consumer; post-cancellation non-abort drain failures log
  with diagnostic context.
- Do NOT re-route the decoded pipeline around this boundary or pass raw
  `response.body` into the decoder directly. Remove the boundary only after
  consuming an assistant-stream release containing the upstream fix AND re-proving
  the browser sweeps green without it. `patchedDependencies` are banned — see
  `ci-quality.md`.

Evidence: `assistant-runtime/stream-insulation.md`.
Guard: `packages/assistant-ui/src/__tests__/stream-insulation.test.ts`,
`packages/assistant-ui/src/__tests__/data-stream-runtime-cancellation.browser.test.ts`.

Live shell output (`executeCommand` streaming):

- `executeCommand` streams subprocess stdout/stderr incrementally through
  `writer.custom({ type: SHELL_OUTPUT_STREAM_PART_TYPE, … })`
  (`packages/agent/src/mastra/shell-output-stream.ts`), which places the slice on
  the fullStream VERBATIM — deliberately NOT `writer.write`, which wraps it as a
  `tool-output` part that collides with subagent delegation and masquerades as a
  successful tool result.
- `processMastraStreamPart` maps that part to a transient `shell-output`
  StreamChunk and `DataStreamMapper.handleShellOutput` emits it as a
  `SHELL_OUTPUT_DATA_NAME` aui-data part, under the same text-part deferral.
- It is NOT a run-event kind ON PURPOSE: run-event metadata is redaction-sanitized
  (which strips `output`/`text`), so live slices stay TRANSIENT and absent on
  reload. The FINAL captured output persists as the tool result.
- A COMBINED streaming cap (`MAX_STREAMED_OUTPUT_BYTES`, separate from the capture
  cap) emits one truncation notice and stops streaming; teardown and capture
  continue unchanged.
- Accept both writer shapes: Mastra hands a plain tool OBJECT the raw
  `outputWriter` fn plus top-level `toolCallId`, and a `createTool` instance
  `writer.custom` plus `agent.toolCallId`.
- The renderer accumulates slices per toolCallId INCREMENTALLY
  (`createShellOutputAccumulator` + `ShellOutputProvider`), O(new parts) per
  update, keeping record identity stable when no shell slice arrived. Do NOT
  replace it with a full rescan (`collectShellOutputs` is the pure/batch variant):
  the rebuild is quadratic and its fresh record identity re-renders every tool
  card in the turn. Same rule for `ToolDurationProvider`.
- `background:true` on the one-shot tool is not the persistence mechanism.
- `resolveCommandCwd` throws `ToolInputError` (never a plain `Error`) for a
  nonexistent cwd and for one resolving outside the workspace root, so the guard
  surfaces the actionable message as `tool_input_invalid`. The same typing applies
  to `resolveWorkspaceRoot`'s qualifier failures.

Evidence: `assistant-runtime/shell-output-streaming.md`.
Guard: the streaming case in
`packages/agent/src/__tests__/mastra-tool-execution.integration.spec.ts`, the
`runExecuteCommand — cwd containment` cases in
`apps/desktop/src/__tests__/assistant-server/execute-command-tool.integration.test.ts`.

Persistent command sessions (`apps/desktop/src/assistant-server/command-session-manager.ts`)
are the desktop-main source of truth for commands that must outlive one tool call.
They do NOT replace `executeCommand`, which stays the bounded, wait-for-exit path.

- A session belongs to one DB-backed workspace `rootId`; every
  list/get/read/write/stop/remove operation requires that same root, and a
  cross-root lookup is indistinguishable from an unknown id.
- `start()` resolves and realpaths the requested cwd inside that root, then
  returns immediately after a real `node-pty` spawn. Unsupported roots, escaping
  or nonexistent cwd, startup failure, exited writes and invalid cursors surface
  typed errors. There is no cwd or cursor fallback.
- Combined PTY output is memory-only and capped, retained in head-evicted,
  fixed-size adaptive blocks that stay one byte per code unit for Latin-1 output
  and upgrade to UTF-16LE only when wider code units enter. Copy tiny PTY events
  into bounded blocks rather than retaining individual references; never rebuild
  the full buffer after it reaches the cap; decode only the requested retained
  suffix; copy an oversized event's retained suffix so a V8 sliced string cannot
  pin the discarded parent.
- Reads use absolute cursors; `-1` attaches at the live tail without replay. Apply
  the requested UTF-16 page limit while decoding, before joining the page, and
  back the page cursor off a high surrogate rather than splitting a pair. An
  evicted cursor returns the retained page with explicit `hasMore`,
  `truncatedBeforeCursor` and `bufferStartCursor`; a cursor beyond the produced
  output throws.
- Model-facing inventory and reads are producer-paged below a UTF-8 result ceiling
  deliberately under the durable artifact-settlement threshold. List continuation
  uses `offset`/`nextOffset`; read continuation advances `nextCursor` only through
  emitted UTF-16 code units and exposes `availableEndCursor` plus
  `remainingUtf16CodeUnits`. A page never splits a surrogate pair. The canonical
  session-tool ids are registered as non-durable outputs, so artifact settlement
  skips them even when a lifecycle hook wraps a result.
- Running/exited state is typed; the newest exited sessions per root remain
  readable and older ones are evicted. Command text, cwd, environment and raw
  output are never logged or persisted.
- Tree reaping walks descendants before killing the PTY leader, applies a POSIX
  process-group backstop, and waits for the PTY exit event. Reaping is idempotent
  across abort/stop/remove/dispose races. Bulk disposal settles every PTY and logs
  any missing exit acknowledgement. Root disconnect reaps by the durable DB id
  returned from the path-keyed disconnect update, never a divergent adapter id;
  factory reset and graceful shutdown dispose all sessions.
- Hosted desktop models receive read-risk `inspectCommandSessions` and
  execute-risk `manageCommandSession` through the ordinary native registry. The
  latter is omitted in plan mode and follows the normal ask/deny gates. Both own a
  target-aware transcript transform replacing commands, cwd, written data,
  streamed input deltas, PTY output and guarded error messages with allowlisted
  metadata before PGlite persistence, while the live display and current model
  step retain the bounded domain result. The built-in local provider omits both;
  web never constructs the desktop registry. Do not widen `executeCommand` in
  place.

Evidence: `assistant-runtime/command-sessions.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/command-session-manager.test.ts`,
`command-session-manager.integration.test.ts`, the command-session cases in
`assistant-tools-read.integration.test.ts`.

Parallel tool calls:

- Mastra executes a step's tool calls concurrently and forces sequential execution
  when the run-wide `requireToolApproval` is set (ANY truthy value) or any active
  tool carries the per-tool `requireApproval` flag or a suspend schema.
- The permission engine marks `'ask'` tools with the PER-TOOL flag in its FUNCTION
  form (`approval-gate.ts`), which Mastra converts to `requireApproval: true` plus
  a per-call `needsApprovalFn`. Only the ask tool suspends; allowed tools still
  run, and a run with no ask tools stays parallel.
- NEVER synthesize a run-wide predicate on the initial leg — it serialized every
  step of every run with an ask tool.
- The approval-resume path sets the run-wide `requireToolApproval`, so the ROOT's
  resumed step is always sequential. DELEGATED CHILDREN get no run-wide gate, so
  their mode comes from the CALLED tools' flags alone.
- Because a parallel foreach resume re-raises the step's approval for every
  allowed sibling, both approval entry points pass `approvalResumeLeg: true` and
  `resolveChildToolCallConcurrency` builds that leg's children with
  `toolCallConcurrency.limit = 1`. BLAST RADIUS: that option is run-level, so the
  WHOLE resumed leg runs child tool calls sequentially until the leg ends.
- The data-stream mapper and UI key all per-call state by toolCallId and handle
  interleaving.

Settled: do not relitigate by re-flagging the approved tool — that re-prompts its
next call and recreates the loop the grant ended (2026-09-13). Evidence:
`assistant-runtime/parallel-tool-calls.md`.
Guard: `packages/agent/src/mastra/__tests__/build-persona-subagents.spec.ts`,
`packages/agent/src/__tests__/worker-delegation.integration.spec.ts`.

## WHERE THE MASTRA STREAMING SPECS LIVE

Five files share ONE fake-Mastra harness
(`packages/agent/src/__tests__/fixtures/mastra-stream-harness.ts`):

| Spec | Pins |
| --- | --- |
| `mastra-tool-lifecycle.spec.ts` | `mastra/tool-lifecycle-processors.ts` |
| `mastra-tool-approval-chunks.spec.ts` | `mastra/tool-approval-chunks.ts` **paired with** `streamMastraToolApprovalAction` / `streamMastraToolResumeAction` — a pause that cannot be resumed is a bug in the PAIR |
| `mastra-stream-termination.spec.ts` | `mastra/stream-termination.ts` plus the `run.finished`-vs-`run.failed` finish-reason policy |
| `mastra-stream-watchdogs.integration.spec.ts` | the watchdogs through real elapsed time; the suffix keeps these wall-clock cases in the uncached integration lane |
| `mastra-streaming.spec.ts` | what no single module owns: the async-iterator contract, the unknown-chunk diagnostic, token measurement, cross-step usage/cost accumulation, steering, observational-memory chunks, everything reached through `createMastraAgentRuntime` |
| `openai-duplicate-item-compat.spec.ts` + `openai-reasoning-item-replay.integration.spec.ts` | `mastra/openai-duplicate-item-compat.ts` — unit keep-newest/drop-stale semantics through the real serializer, integration over real PGlite with the double-persisted history shape |

- **These are integration specs, not unit specs — deliberately.** They drive
  `streamMastraAgent` over a fake Mastra stream because the mappers are reachable
  only through the R6 dispatch and the ORDERING they produce is a property of the
  dispatch loop. Contrast `packages/agent/src/mastra/__tests__/mastra-chunk-decoding.spec.ts`,
  which CAN import its subject because those decoders are pure.
- Put a new case in the file whose module owns the behaviour; add a file only when
  a new module seam appears. `mastra/stream-run-event-chunks.ts` has no dedicated
  spec on purpose — every module-seam spec exercises it.
- Mocked dependencies do not by themselves make a watchdog case cache-safe. A
  watchdog test using deterministic time, or whose verdict does not depend on
  scheduler progress, belongs in the cacheable unit lane. Do not narrow the
  BST-839 case's 10x per-gap headroom merely to shorten the integration lane.

Evidence: `assistant-runtime/streaming-spec-layout.md`.

## THREAD SCROLLING (STICK-TO-BOTTOM + JUMP-TO-LATEST)

- Scroll position is owned by the REPO's follow engine
  (`packages/assistant-ui/src/thread-scroll-follow.tsx`), never by panel state and
  never by @assistant-ui. The tier-1 scroller is a PLAIN div wired to
  `ThreadScrollFollow` (one engine per panel via `ThreadScrollFollowProvider`).
- A thread pinned at the bottom follows streaming growth; the moment the user
  scrolls up, `isAtBottom` flips false and the engine stops writing `scrollTop`.
  Re-engaging is an explicit user act.
- `ThreadPrimitive.Viewport` must not return. The engine is a parity port of the
  library's algorithm with a STABLE observer lifecycle — attached once per scroller
  element, never re-created by renders — and that stability IS the fix.
- Detect content growth by `MutationObserver`, measure immediately, then verify in
  one coalesced `requestAnimationFrame`. Mutation delivery can precede Chromium's
  final layout and a scroller `ResizeObserver` does not reliably observe
  scroll-height-only growth. Pointer, wheel and touch intent plus detach cancel a
  pending frame.
- The scroller, message list, button and engine are one owned module pair —
  `assistant-thread-messages.tsx` + `thread-scroll-follow.tsx`, re-exported from
  `assistant-ui-panel.tsx`. The panel only composes them.
- `ThreadMessageNavigationContext` supplies explicit message navigation, scoped to
  one conversation. `ThreadMessagesRegion` waits for loaded history, resolves raw
  native IDs through the mapper's source-ID metadata, and focuses the message
  root. Static navigation calls `scrollToMessage` (which disengages following);
  virtual navigation uses the TanStack instance's `scrollToIndex`. Both use an
  instant opening position and `focus({ preventScroll: true })`. A mounted-range
  observer waits for an offscreen virtual row; no timer or polling loop.
- **Jump-to-latest** is the follow engine's button: DISABLED while at bottom,
  scroll + re-engage when clicked, hidden via `:disabled { opacity: 0 }` so there
  is no layout shift. It mounts inside `ThreadScrollRegion` as a SIBLING of the
  scroller.
- **No explicit `behavior` on explicit scrolls** — an explicit option bypasses CSS
  `scroll-behavior` and therefore the global `prefers-reduced-motion` override.
  Streaming growth follow is the exception and uses `'instant'`.
- **`overflow-anchor: none` is SCOPED to the pinned state** via `data-pinned`.
  Scrolled up, native anchoring is the ONLY thing holding the reader's text still
  when content ABOVE the fold resizes. Do not simplify this to a blanket rule.
- **No jump on attach or run start.** The ONE navigation jump is the thread SWITCH
  (`switchKeyRef` → `jumpToBottomInstant()`), which requires a `threadKey` prop and
  never routes through the explicit-request listeners.
- There is deliberately NO collapsed-history affordance: every message renders.
  Which messages MOUNT is the render tier's business.
- **Follow-up queue dispatch re-pins explicitly when the thread was pinned.** The
  dispatch captures `getIsAtBottom()` BEFORE the flush and fires `scrollToBottom`
  after appending; a reader who scrolled up is never yanked. Do not remove this as
  redundant with the engine's resize re-stick — that path loses the clamp-ordering
  race.
- **A `scroll` event the engine itself authored never disengages follow.** A
  `measure` write claims the `scrollTop` it MOVED to (`unechoedWriteTop`) and the
  listener swallows that one echo. Two rules follow: **authorship is the
  discriminator, not movement** (events coalesce, so a user round trip arrives as
  ONE net-zero event that must still disengage), and **`lastScrollTop` is the last
  position `handleScroll` PROCESSED**, not the position before the current event.
- Two placement rules keep the claim honest: make it in `measure` and NOT in
  `write`, because only `measure` performs the synchronous `handleScroll` that
  justifies swallowing an echo — the explicit-request writes never judge, so their
  echo is the ONLY thing that can re-pin the thread. And claim only a write that
  MOVED the position; a no-op write dispatches no event, so its claim would linger.

Evidence: `assistant-runtime/thread-scroll-follow.md`.
Guard: `packages/assistant-ui/src/__tests__/assistant-scroll-to-bottom.browser.test.tsx`,
`follow-up-queue-repin.browser.test.tsx`, the BST-896 case in
`assistant-ui-panel-architecture.test.ts`.

### Render tiers

`ThreadMessagesRegion` picks one of two renderers by message count and publishes
the choice as `data-thread-render-tier` on the viewport — tier selection is
observable, never silent. The threshold is `THREAD_VIRTUALIZATION_THRESHOLD`
(`assistant-thread-messages.tsx`).

- **Tier 1 — `static`.** Every message is a real DOM row from
  `ThreadPrimitive.Messages`; off-screen rows are cheap via
  `content-visibility: auto` + `contain-intrinsic-size`, which keeps find-in-page,
  selection, screen readers and anchor links working — that is why it is the
  DEFAULT. Containment is NEVER applied to the last row; the streaming message is
  always last and the message root carries no "running" attribute, so
  `:not(:last-child)` IS the streaming exclusion.
- **Tier 2 — `virtual`.** An end-anchored TanStack virtualizer
  (`anchorTo: 'end'`, `followOnAppend`, `getItemKey` = message id,
  `measureElement`) driven by `unstable_useThreadMessageIds` +
  `ThreadPrimitive.Unstable_MessageById`. Mounted rows are bounded by the
  viewport, not by thread length.
- **One scroll owner per tier.** On tier 2 the virtualizer writes `scrollTop`, so
  every library-driven scroll is off. Never run the library's stick-to-bottom hook
  and the virtualizer on one container.
- **`overflow-anchor: none` is UNCONDITIONAL on tier 2**, independent of
  `data-pinned`, because the virtualizer corrects `scrollTop` in every state.
- **Measurement corrections are immediate**: tier 2 overrides the static
  viewport's `scroll-behavior: smooth` with `auto`. Explicit user jumps still use
  the virtualizer's smooth option unless reduced motion is enabled.
- **Native scroll completion**: enable the virtualizer's `useScrollendEvent`. Its
  timer-based reset reports a stale cached offset and can drop the end pin; native
  `scrollend` reads the current offset. Keep this on the public API; do not add
  another scroll writer or a longer reset delay.
- **Virtual layout ownership.** React Virtual's `directDomUpdates` owns container
  size and per-item row transforms; React sets only the static absolute-position
  base. Keep the ref composed with list-offset measurement and the mode constant
  across tier switches.
- **End affordance subscription.** Vendor notifications coalesce by visible range
  and `isScrolling` — that is not an end-state subscription. Wrap the exported
  `observeElementOffset`, call the vendor callback first, then publish `isAtEnd()`,
  and also publish from `onChange` after vendor layout writes. The wrapper
  delegates observer setup and cleanup unchanged and never writes scroll position.
- **Clamped compensation belongs to the vendor.** Keep the React Virtual /
  Virtual Core patch floor; do not add a second scroll writer or weaken the
  true-bottom assertion.
- **Browser interaction admission.** Observe native `scrollend` before simulating
  an independent scroll-away gesture. One animation frame is not a completion
  signal. Synthetic scroll plus event delivery belongs in React `act`. This is
  test synchronization, not a production delay.
- **Opening position.** `scrollToBottomOnInitialize` / `scrollToBottomOnRunStart`
  stay `false` in both tiers. Entering the virtual tier anchors to the newest
  message with `behavior: 'instant'`, but only when the reader was not already
  scrolled up. The anchor re-arms on `threadKey` change or a drop back to static.
- **Pinnedness at the switch is RECORDED, never measured.** The anchor effect runs
  after the renderer swap, so the viewport is sized by ESTIMATES. Record the static
  tier's own `isAtBottom` while it is still the truth and read it back on the
  swap. Testing consequence: a test that scrolls up then crosses the threshold
  must wait for the LIBRARY to disengage — the jump button rendering enabled — not
  for `viewport.scrollTop`.
- **`aria-live` forks per tier.** Tier 1's only insertions are new messages, so
  the viewport stays `aria-live="polite"`. Tier 2 mounts and unmounts rows as the
  user SCROLLS, so it is `off` there until a dedicated new-message live region
  exists.
- **Reduced motion, tier 2.** The no-explicit-`behavior` rule is a tier-1 rule.
  The virtualizer's behavior argument drives its scroll state machine, so it must
  be explicit and the jump button checks `prefers-reduced-motion` itself.
- **One control, one chrome.** Class, icon, label and test id are declared once;
  only the behaviour differs. The button takes plain `{ atEnd, jumpToEnd }` values,
  never the virtualizer.
- **Message markup never forks.** Both tiers render the SAME components map; the
  tier decides which messages mount, never how they render. CSS keyed off "direct
  child of the viewport" must account for tier 2's `.bs-virtual-message` wrapper.
- **Row spacing must live inside the measured box.** `measureElement` measures the
  border box, so margins on a row and the virtualizer's `paddingEnd` are invisible
  to it. Tier 2 puts inter-message spacing and the trailing gap on the row wrapper
  as padding.

Evidence: `assistant-runtime/render-tiers.md`.
Guard: `packages/assistant-ui/src/__tests__/assistant-thread-virtualization.browser.test.tsx`,
the BST-897 case in `assistant-ui-panel-architecture.test.ts`.

## IN-FLIGHT TOOL CARD PROGRESS

`ToolFallback`'s running row reads its label from what assistant-stream already
delivers. The pure label lives in `packages/assistant-ui/src/tool-call-progress.ts`;
the hooks in `use-tool-call-progress.ts`.

- **The signal is the accumulator's `state`, NOT `status.isArgsComplete`.**
  `AssistantMessageAccumulator` stamps `state: 'partial-call'`, flips it to
  `'call'` on `tool-call-args-text-finish` and to `'result'` with the result, while
  writing `status: { type: 'running', isArgsComplete: false }` once and never
  flipping it. `state` is undeclared on the public `ToolCallMessagePart`, so
  `readToolCallArgsState` narrows it off the props rather than casting.
- **Fallback is silence, not a claim.** An absent or unrecognised `state`, or a
  `partial-call` part that has received zero bytes, reads as plain `Running`.
  "Receiving input" is asserted only once bytes have arrived.
- **Elapsed comes from `part.timing`**, ticking once per second while running via
  `useToolCallElapsedMs`. No timing means no timer — never a fabricated clock.
- **Byte count is incremental** (`useIncrementalUtf8ByteLength`): the accumulator
  only appends, so encode only the new suffix per delta.
- Re-derive this section and its contract test together.

Evidence: `assistant-runtime/tool-card-progress.md`.
Guard: `packages/assistant-ui/src/__tests__/tool-call-args-state.contract.test.ts`
(drives the INSTALLED accumulator through part-start → delta → args-finish →
result; a dependency bump that renames `state`, starts flipping
`isArgsComplete`, or drops `timing` fails there).

## POST-EDIT LSP DIAGNOSTICS (report R2 Phase A)

After a successful workspace edit a language server runs over the edited file and
its diagnostics are attached to the tool result. Desktop-only (needs child
processes + fs; web omits it — capability-gated, no `isElectron()`).

- **Bespoke, not the core primitive.** `apps/desktop/src/assistant-server/lsp-diagnostics.ts`
  lifts the WIRE PROTOCOL (`vscode-jsonrpc` + `vscode-languageserver-protocol`),
  not Mastra's Workspace/sandbox LSP class.
- **Bundled flagship server**, TypeScript/JavaScript only. Follow the
  package-scoped forwarding dependency from the TypeScript 6 compatibility wrapper
  to the real `tsserver.js`; never assume the server sits next to the wrapper's
  `lib/typescript.js`. All three reliability steps are required: spawn `cli.mjs`
  through `process.execPath` + `ELECTRON_RUN_AS_NODE=1`; pin
  `initializationOptions.tsserver.path` to the bundled `tsserver.js`; advertise
  the `textDocument.publishDiagnostics` client capability. Diagnostics land as two
  pushes (`[]` then the real set), so a settle window is mandatory.
- Agent-facing diagnostics therefore come from TypeScript 6 while build and
  type-check gates run native TypeScript 7. Keep the cross-major control (the full
  compiler parity sweep plus the real-subprocess LSP integration's WebGPU surface
  check) while the LSP stays on TypeScript 6. The desktop manifest lists the
  compatibility implementation as a production dependency and unpacks it
  explicitly; the root owns the same alias so `.vscode/settings.json` can point
  `typescript.tsdk` at it.
- **`lspInspect`** is a read-risk native tool taking `{path, line (1-based),
  match}`. Prefer a markerless single identifier; if it repeats on the line, use a
  unique fragment with exactly one `<<<` cursor marker. Anchor the identifier or
  marker-stripped fragment against the REAL line text read through the checked
  reader. A markerless identifier missing from the line returns up to five actual
  candidate line numbers for an explicit retry; it never jumps lines itself.
  Missing and ambiguous matches refuse. Returns up to four groups — hover, the
  line's diagnostics, definition locations and implementations — reusing the
  pooled connection and per-file diagnose lock, each query independently bounded
  and never throwing.
- **An unanswered inspect query is never an empty one.** `queryHover` /
  `queryLocations` return a `QueryOutcome`, and `withTimeout`'s fallback is the
  `QUERY_TIMED_OUT` sentinel symbol, never `null`. Every leg that did not answer
  lands in `LspInspectionResult.queryFailures` as
  `{query, reason:'timeout'|'error', message}`, where `query` names the RESULT
  FIELD it fills and `message` says what is UNKNOWN and what not to conclude.
  Bound and collapse `detail` AT THE PRODUCER.
- Four invariants: a partial failure NEVER flips `available` to false; failures
  log at `logger.warn` so they are visible at the default level;
  `| unanswered=<queries>` goes in the projection HEADER, the only unconditional,
  self-bounding line; the `query_unanswered:` detail lines sit in a
  PRIORITY-ORDERED but itself fit-aware prelude above the droppable result lines.
  Do not make any prelude line unconditional, do not reintroduce a bare
  `catch { return []; }`, and do not give `withTimeout` a fallback a real answer
  could equal.
- **Diagnostics settlement is RETURNED, never inferred from the map.**
  `waitForDiagnostics` resolves to a `DiagnosticsWait` — `{settled:true,
  diagnostics}` only for a non-empty publish or an empty one that survived the
  FULL settle window — and both `diagnose`/`getEditDiagnostics` and `inspect` read
  that value. Re-adding a `hasPublishedFor` map probe is a regression: the map is
  mutable and shared, so a post-hoc `has()` reports a never-settled leg as
  ANSWERED.
- **Pool + lifecycle.** One pooled server child per workspace `rootId`. All
  acquisition goes through `acquireLspServer`, which registers the pool entry in
  the same synchronous frame as the miss check. Do not inline `pool.get`/`pool.set`
  at call sites. Every server MUST be torn down: `disposeLspServers()` is wired
  into both the factory-reset `runtimes[]` and graceful shutdown;
  `evictLspServersForRoot(rootId)` fires from the `fs:removeRoot` IPC handler.
  Disposal awaits the child's actual exit, not merely `child.kill()`.
- **No silent fallbacks.** An unresolvable server, unsupported language or
  diagnostics timeout resolves to an honest result the caller attaches — never a
  throw that would fail the already-applied edit. Unsupported languages OMIT the
  `lsp` field entirely; a supported language whose server is unavailable attaches
  `{available:false, message}`. Diagnostics are self-bounded because
  `lsp.diagnostics` is NESTED and the transport budget guard cannot rescue an
  oversized blob.
- **Scope.** Wired into `write` + `stringReplace` only; `rename` is deliberately
  excluded (content unchanged). Diagnostics run OUTSIDE the per-file write lock.

Evidence: `assistant-runtime/lsp-diagnostics.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/lsp-diagnostics.integration.test.ts`
(real subprocess; the no-orphan proof),
`lsp-inspect-query-failures.test.ts`, the post-edit cases in
`assistant-tools-multiroot-and-gating.integration.test.ts`.

## LOOP GUARDS

The desktop assistant server applies three thread-scoped, main-process-memory
guards plus one stateless guard so an agent stops reconfirming evidence it
already has. This is a desktop native-tool capability boundary: web constructs
none of these tools, and no network round trip or persistent store participates.

- **Repeated identical calls — `grepSearch`/`globWorkspace` ONLY.**
  `withRepeatedCallGuard` (`apps/desktop/src/assistant-server/tool-call-loop-guards.ts`)
  tracks stable, recursively key-sorted arguments per `(threadScope, toolId)`.
  Calls one and two run normally, call three runs and stamps a warning, call four
  is REFUSED without calling `run`. Different arguments reset only that tool's
  streak; another tool's call never resets it. `readWorkspaceFile` deliberately
  does NOT use this mechanism — an args-only streak cannot know the file changed.
- **The streak only advances on a call that PRODUCES a result.**
  `peekRepeatedToolCall` never mutates the observable streak;
  `commitRepeatedToolCall` runs only after `run` resolves, so a transient error is
  never committed.
- **The warning is its own field, never folded into `hint`.** Stamp
  `result.loopGuardWarning` by MUTATING IN PLACE, never a spread into a new object
  — the WeakMap-keyed telemetry is tagged onto the SAME object. Both projectors
  render it as an unconditional `warning:` line.
- **Unchanged file-read windows.** `checkUnchangedReadWindow` keys a fresh
  `readWorkspaceFile` request by root, normalized path, requested
  `startLine`/`endLine`, the EFFECTIVE `maxChars`, and observed mtime. First read
  returns content, second returns `dedup: true` with `UNCHANGED_READ_STUB_MESSAGE`,
  third returns the same non-throwing hard refusal. An mtime change resets the
  window. A request with `cursor` is a continuation and MUST NEVER enter this
  guard.
- Check it only AFTER a page is built and only when `selected.result.truncated ===
  false`. Stubbing a truncated page would discard the only `nextCursor` and
  misreport `truncated`; recording before page-fitting would prime the model's
  corrected retry to look like a repeat.
- **Repeated string-replace failures.** `recordEditFailure` counts only
  consecutive `StringReplaceError` failures whose reason is `ambiguous` or
  `not_found`, keyed by thread, root and normalized path. On failure three and
  later, APPEND `EDIT_FAILURE_HINT_MESSAGE` to the fuzzy matcher's own message
  rather than replacing it. `no_op` never increments. A successful
  `stringReplaceWorkspaceFile` OR `writeWorkspaceFile` to the same path resets.
- **One shared scope authority.** Every mechanism receives
  `threadScope = readStateScope(runtimeData)` from `workspace-file-staleness.ts`;
  no tool derives a second thread key. This deliberately shares identity with the
  read-before-write mtime tracker.
- **Refusal is data, NEVER an execution error.** `buildRepeatedCallRefusalResult`
  returns `{ok:false, refused:true, error}`. For grep/glob it intentionally lacks
  `outputMode`, so the parsers reject it with `ToolProjectionInputRejectedError`
  and `projectExistingModelOutput` emits the generic bounded projection. Other
  projector errors still fail loudly.
- **The unguarded read caller is load-bearing.** `workspace-context-tools.ts` calls
  `runReadWorkspaceFile` directly for bulk context and MUST see no loop guard: the
  three-argument overload stays exactly `Promise<ReadWorkspaceFileResult>`.
- **Dedup still records knowledge.** Before an unchanged-read stub or refusal
  returns, call `recordKnownFileMtime` with the loop guard's scope and the file's
  canonical path/mtime, or the next write-staleness decision is corrupt.
- **Ephemeral, not factory-reset state — and bounded.** The maps are process-local.
  `resetToolCallLoopGuards` serves test isolation and one production caller (after
  a stale-read projection rewrite batch commits). This MUST NOT be wired into
  factory reset. Each per-thread map holds at most `MAX_KEYS_PER_THREAD_SCOPE`
  keys with delete-then-set LRU-on-write; one shared activity tracker holds at
  most `MAX_TRACKED_THREAD_SCOPES` scopes, and overflow evicts the
  least-recently-active scope from every store.
- Every write path promotes its scope through `getOrCreateScopeMap` and the read
  path promotes through the same shared `touchThreadScope`. The read-path touch is
  required because a refused call returns before commit. It changes only LRU
  bookkeeping; peeking still never advances the observable streak.

Evidence: `assistant-runtime/loop-guards.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/tool-call-loop-guards.test.ts`,
`loop-guard-projection-round-trip.test.ts`, `assistant-tools-read.integration.test.ts`,
`string-replace-workspace-file-live-loop.test.ts`.

## GUTTER-PREFIX WRITE GUARD (BST-1202)

`readWorkspaceFile` renders model-visible pages with an unpadded `${line}: `
prefix; `gutter-prefix-guard.ts` conservatively identifies that display form
before it can be pasted back onto disk.

- Refusal requires ALL of: at least three lines matching the exact `^\d+: ` shape;
  those numbers forming a monotonic NON-DECREASING run (an exact adjacent repeat
  is tolerated, a decrease is not) with a TIGHT SPAN (`max - min < 2 * count`);
  and the run's smallest number being greater than 1. Do not broaden the prefix
  shape.
- The tight-span bound does the discriminating work: it tolerates a single deleted
  line and the repeated boundary number a page split re-emits, while rejecting two
  unrelated reads pasted back to back and non-sequential content that merely
  starts with digits.
- **Known coverage boundary — deliberate.** A page-1 paste is NEVER refused:
  legitimate 1-based numeric-key content is textually IDENTICAL to it. Blocking
  the legitimate write is strictly worse than missing this paste shape. Do not
  relax the `first > 1` requirement.
- The guard applies only to `writeWorkspaceFile.content` and
  `stringReplaceWorkspaceFile.newStr`. It deliberately does not inspect `oldStr`.
- In `runWriteWorkspaceFile` the `MAX_WRITE_WORKSPACE_FILE_BYTES` size check runs
  BEFORE the guard, so an over-limit payload never pays for the guard's
  `split('\n')`.
- This is a fourth, independent, STATELESS mechanism: no thread scope, no Map, no
  participation in the loop-guard bounds. A match throws `ToolInputError` before
  locks, disk I/O or `recordEditFailure`, so a gutter refusal consumes zero
  edit-failure streak slots.
- An out-of-safe-integer captured number disqualifies only that ONE line — it is
  skipped, never a reason to abort the whole check, so it cannot defeat the guard.

Evidence: `assistant-runtime/gutter-prefix-guard.md`.
Guard: `apps/desktop/src/__tests__/assistant-server/gutter-prefix-guard.test.ts`.

## PERMISSION ENGINE (TOOL APPROVAL)

Scope note: MCP elicitation is a SEPARATE consent channel. Approval and
suspension ride the assistant stream and render as thread cards; elicitation is
host-scoped over IPC to an app-wide modal. Neither channel resumes or approves the
other — see `docs/agents/assistant-providers.md`.

- **Renderer execution boundary.** Production desktop main does not import or
  register `ipc-tools.ts`, the visible preload exposes no `tools.execute`, and
  desktop Settings supplies no playground execution callback. The `window.tools`
  bridge is selection-event-only, so renderer code — the renderer-hosted local LLM
  adapter included — cannot invoke native, assistant, shell or MCP tools directly.
  Local tool definitions are omitted when no executor is present. There is no
  compatibility fallback that reconstructs approval state or accepts a
  renderer-supplied workspace path. `ipc-tools.ts` is retained only as an
  unregistered legacy unit harness and throws before handler registration unless
  `NODE_ENV === 'test'`.
- Mutation tools PROMPT for per-call approval by default. The permission policy
  store (`packages/app-state/src/stores/permission-policy-store.ts`) defaults to
  `enforce: true` with `{read:allow, mcp:allow, edit:ask, execute:ask}`. A user
  may turn `enforce` off, set a category to `allow`, or grant a session category.
  Resolve its platform storage through a local deferred state-storage proxy so an
  optimized chunk-evaluation cycle cannot make Zustand omit the `persist` API; a
  later hydration retries and genuine adapter failures remain visible.

Flow (desktop assistant server → agent runtime):

1. **ONE producer, at request-composition time.** `prepareRequestData`
   (`packages/app-shell/src/hooks/use-assistant-request-lifecycle.ts`) reads the
   LIVE store and sets `permissionPolicyRequest` UNCONDITIONALLY — the snapshot
   when the transport is `permissionEnforceable` and `enforce` is on, otherwise
   `undefined`, which `JSON.stringify` drops. That fresh read closes the
   grant→resume race. `buildAssistantRequestData` deliberately does NOT carry the
   field, and `assistant-ui-panel-wrapper.tsx` deliberately does NOT subscribe to
   the store during render. The unconditional write must NOT become a conditional
   spread: it has to clobber a stale snapshot inherited from `requestData`.
   `resolveRequestPermissionPolicy` builds the trusted snapshot with a
   SERVER-built `riskByTool`; the client never classifies tool risk.
   WIRE SHAPE: read the VALUE, never presence — `resolveRequestPermissionPolicy`
   treats an absent key and an explicit `undefined` identically.
2. `filterToolsByPermissionWithMetadata` (`mastra/permission-tool-gate.ts`) gates
   the tool map BEFORE the immutable `Agent` is built: `'deny'` omits, `'allow'`
   keeps unchanged, `'ask'` keeps unchanged and records in `askToolIds`/`askTools`.
   The composition site then clones every kept ask tool through
   `applyLiveApprovalGate` with the FUNCTION form of Mastra's PER-TOOL
   `requireApproval`, evaluated on every call against the runtime's live gate.
   Never a static `true` — Mastra copies that boolean once per stream call, so a
   remembered session grant could never lift it.
   SUSPENDING tools take the same function-form clone; the framework's
   pre-execution approval is Gate A and the tool's own `suspend()` pause is Gate B,
   kept resumable by the `approved: true` rider.
   `resolveSelfApprovalDecision` is still injected at the composition root, now
   ONLY for the direct-invocation guard.
3. PER-TOOL, not global: allowed `read`/`mcp` tools in the same run still run
   free, and a tool a remembered session grant allows runs free from its next call
   on. Do NOT force run-wide `requireToolApproval`. `resolveAskToolsForRun` only
   decides whether ask tools may STAY: WITH Mastra workflow storage they stay;
   WITHOUT storage they are fail-safe OMITTED.
4. The approval UI and resume chain runs `makeApprovalRequiredChunks` →
   `tool-approval-required` chunk → `DataStreamMapper.handleToolApprovalRequired`
   → `TOOL_APPROVAL_DATA_NAME` data part → `assistant-tool-approval-notice.tsx`.
   Approve executes, decline skips. Live and rediscovered approvals share the
   component.

Previews and grants:

- `brainstrike.executeCommand` renders a selectable, whitespace-preserving command
  block plus working directory, workspace root and timeout. Its local guard
  mirrors the strict agent schema including unknown-key rejection; malformed
  arguments show the visible preview error and unmodified raw arguments, never a
  guessed command. `runSkillScript` uses a semantic preview naming the activated
  skill and skill-relative script; it never presents or accepts a model-supplied
  absolute skill path.
- `brainstrike.runPython` renders the code plus always-rendered fact rows from a
  server-computed `executionContext`, forwarded in THREE places: stamped in
  `makeApprovalRequiredChunks`, spread through the mapper's field-by-field
  rebuild, and RECOMPUTED on rediscovery in `status-endpoints.ts`. Fail-safe: args
  that fail strict narrowing or an absent/invalid context keep Approve/Decline but
  SUPPRESS the grant buttons with a visible reason. Copy rule: an empty
  `allowRead` under `defaultReadAccess: 'permissive'` renders "most files on this
  computer", NEVER "can't read your files". On the settled result surface, killed
  ≠ completed ≠ didn't-run, non-zero exit is an amber finish, cancelled never
  renders as success or empty, truncation is a per-stream note, and structurally
  narrowed numbers must be safe integers before the purpose-built surface renders.
- The built-in local provider admits a call only after its arguments parse as a
  root JSON object; a `local_tool_call_arguments_invalid` generation ends visibly
  with typed `run.failed` metadata before Mastra can create a snapshot. Valid
  arguments are canonicalized before suspension, so notice, snapshot, resumed card
  and execution share one value.
- Offer GRANT actions only when a `ToolApprovalGrantProvider` is mounted above the
  notice AND the approval carries a valid `riskCategory`. "Always allow <tool>"
  persists a per-tool override; "Allow <category> this session" is session-lived;
  the overflow "Allow all tools this session" grants ALL FOUR categories in ONE
  atomic store `set()`. SETTLED: the blanket action is four category grants, NOT a
  session-yolo flag — per-tool DENY still beats it and Settings lists each granted
  category individually revocable.
- All grant actions record the grant FIRST, then approve the pending call through
  the normal resume. The grant takes effect on the SAME resumed leg because
  `prepareRequestData` reads the posture fresh. The same holds for a DELEGATED
  child's pause: the child's snapshot contributes only its denies.
- **PARKED SIBLINGS.** A session grant is a policy change, so the approval leg
  resumes, in the SAME leg, every parked BACKGROUND sibling whose pending leaf the
  runtime's fresh snapshot now allows (`findGrantedBackgroundApprovals`). Walk each
  sibling from its DISPATCH address through the binding's `resolveParkedInvocation`,
  because no leaf identity exists yet and `resolveToolAction` refuses a bare
  address by design. Record a policy answer through `recordToolActionAnswers`
  directly as `consumed` under the leg; a policy answer never takes a claim (the
  ledger permits ONE `claimed` row per root).
- **ALL OR NONE.** Every answer a leg records at once is ONE host transaction
  naming each leaf at most once. A refused answer records nothing, so the user's
  own pause stays answerable.
- **ALREADY ANSWERED OR STOPPED IS NOT A REFUSAL.** Discovery skips a parked
  sibling the write would refuse for a reason of its own:
  `readUnanswerableToolActionLeaves` names `'answered'` (the leaf carries a durable
  decision — states ENUMERATED in the read, not "any row") and `'stopped'` (the
  leaf's thread chain carries a cancellation request for this turn). Both writes
  and this read build the stopped predicate from ONE `stoppedSubtreeExists`
  fragment, so the skip can be neither narrower nor broader than the write.
  ROOT-WIDE admission failure stays fatal for the whole write, as does a leaf
  answered or stopped in the window between that read and the write.
- **DECISIONS DURING A RUN.** The installed assistant-ui runtime CANCELS the
  in-flight run when a message is appended, so every decision goes through
  `submitDecisionOrQueue` (`decision-dispatch.ts`): idle thread → append; running
  thread → the host's LIVE transport (`POST /assistant/decide`, applied INSIDE the
  running leg); only on 404 or a host with none → the follow-up queue, dispatched
  one per run end. It reports `'delivered' | 'queued' | 'sent'`; a transport
  rejection propagates so the card unlocks and shows `Decision not sent: <reason>`
  inline. BOTH notices report it, and for a synchronous `thread().append` throw.
  `append` returns `void` and rethrows anything but `MessageNotSentError`, so
  neither notice wraps it in a promise; a failed resumed run is observed through
  thread state.
- Both notices clear `sendError` when a new submit starts, and a spent message
  never outlives its context: the approval notice DERIVES the alert from the
  run-outcome key (which names the DECISION by index, not `action`/`state`), and
  the typed-resume notice clears on the `pending`/`completed` transition.
- The leg streams one `tool-approval-answered` chunk per sibling, shipped as the
  `brainstrike.tool-approval-answered` data part; the notice scans for a part with
  its own identity key and locks as "Allowed by session grant". Neither request
  nor answer part is stored with the message, so after a reload only a leaf
  rediscovery still finds suspended gets a card back. A mid-run reload replays the
  session buffer, answers included. A one-shot Approve changes no policy, so the
  ask set still holds the tool and siblings stay parked.
- The root card for BACKGROUND children exists only because the leg's publish seam
  synthesizes it (`withRootPauseNotices`); the parent-level pause Mastra writes on
  a still-open dispatching turn is dropped as a second delivery.
- The delegated notice NAMES its child — persona label plus the root's prompt
  (`describeDelegationOwner`). Both the name and the host answer come from ONE
  incremental thread index (`answered-approvals-index.tsx`), never a per-card
  selector walking every message part on every store update, which stalls the
  renderer during a fan-out. The main process logs `renderer_unresponsive` /
  `renderer_responsive_again` with timing so a hang is durable evidence.
- **SWARM-AWARE PRESENTATION.** The thread shows ONE full approval card per risk
  category while a decision is pending; every already-answered approval and every
  pending approval BEHIND its category's card renders as a one-line row
  (`approval-row.tsx`) whose expanded body is the full card. A row for a durable
  `decisionState` ALSO renders its recovery status under the collapsed line, and
  the embedded card omits it — that status is safety information with no control
  beside it, so it must be readable without opening the row. Pending-since and
  stale lines stay in the card beside the actionable controls. The choice is pure
  (`approval-presentation.ts`) and the rank is computed ONCE per thread change by
  `ApprovalRanksProvider` from the SAME incremental index.
- Delegation identity is a colour rail hashed from the delegation call id, one
  rail per ancestor edge plus a depth indent — NOT DOM re-parenting: approval
  parts stay standalone in the assistant message. Both forms carry
  `data-testid="assistant-tool-approval-notice"` and
  `data-approval-presentation="card|row"`; `approval-delegation-owner` names the
  persona chain. The notice file is a chooser; `use-approval-notice-state.ts` owns
  outcome/lock/submit logic and `approval-preview.tsx` the structured previews.
- **OPTIMISTIC LOCK.** The lock a click takes is STAMPED with the run outcome it
  was taken in (`ApprovalRunOutcomeKey`) and DERIVED during render, never adjusted
  in an effect. It holds while the thread still reads that outcome and is spent as
  soon as the outcome moves on. The key must be an IDENTITY, not a value: testing
  `state !== 'retryable'` drops the lock a RETRY click just took, and keying on
  `{action, state}` alone RESURRECTS a spent lock, so `resolveApprovalRunOutcome`
  also reports `decisionIndex`.
- **APPROVALS STRIP.** `approval-queue-strip.tsx` sits at the composer and lists
  PENDING approvals per risk category from the same ranks provider. "Allow
  <category> this session" records the grant FIRST then submits ONE approve —
  byte-identical to the card's button — and the runtime answers the siblings. It
  never submits N decisions. Capability-gated like the card: no provider → counts
  only. Non-policy `tool:*` buckets are never listed. Its label ends "…for the N
  waiting approvals" on purpose, because the live verifier selects a CARD's grant
  by `[aria-label$="for this session"]`.
- **CHILD VIEWS READ THE ROOT'S ANSWERS.** The host publishes
  `tool-approval-answered` on the ROOT leg only, so a child view reads its owning
  root's answers BY IDENTITY (`getToolActionIdentityKey`): the delegated
  conversation root publishes its registered runtime thread, `ChildView` passes it
  as `ownerThread`, and `AnsweredApprovalsProvider` indexes the owner's messages
  incrementally beside its own and folds in ONLY their answers. Requests,
  delegation prompts and user decisions stay the view's own. No second writer and
  no second delivery. A genuinely pending child card keeps its buttons; a child
  view with no registered owning runtime reads no root answers.
- An OpenRouter approval pause terminates its transport leg with zero-token usage
  and no claimed cost; approval resume emits the deferred step finish before later
  steps, so terminal aggregation records the exact total.
- Settings > Permissions lists per-tool overrides and active session grants, each
  individually revocable plus "Revoke all". The chunk carries an optional
  `riskCategory`/`policyDecision` so the notice can name the reason. The mapper
  correlates Mastra's transient tool error emitted before a deliberate `suspend()`
  and suppresses only that call's false failure fallback.
- Before either approval decision applies, the resume adapter reads Mastra's
  storage-backed `listSuspendedRuns()` snapshot and exact-matches both `runId` and
  `toolCallId`. That durable snapshot is the authority for the original tool name
  and arguments; the resumed stream is seeded with that exact invocation. A
  missing snapshot, tool name or argument payload fails visibly before
  approve/decline executes — never invent `{}` or trust the client action.
- Runtime reconstruction preserves the execute-backed `brainstrike.webSearch`
  implementation only when that exact call is being resumed; resuming a different
  tool keeps provider-native search available.
- `streamMastraToolApprovalAction` passes `requireToolApproval: true` because the
  resume API needs it, and `resolveRequireToolApproval` substitutes the runtime's
  live predicate so allowed tools keep running. The canonical Mastra internal ids
  (`internal-approval-exempt-tools.ts`) stay exempt, as do the SELF-APPROVING
  suspending tools — but ONLY from the ASK-SET half, because re-gating one there
  creates an approval loop that can never complete. The EXPLICIT GLOBAL posture
  still gates them.
- `streamMastraToolResumeAction` verifies via `assertResumedCallIsSuspendPause`
  that the targeted call is suspended on a PLAIN `suspend()` pause; a generic
  resume payload must never answer an approval pause, mirroring
  `readResumedApprovalToolCall`'s requirement in the other direction.
- An EMPTY `askTools` on the resumed leg is AMBIGUOUS and is disambiguated by
  `permissionEnforced`, NOT by `askTools.size`: enforced-but-nothing-asked is an
  all-allowed posture that gates NOTHING, while not-enforced plus a caller-set
  run-wide `requireToolApproval` keeps gating every non-internal tool. Per-tool
  DENY wins in both cases; a non-empty `askTools` always gates exactly the ask set.

Settled: one producer for the policy snapshot; the function-form per-tool gate;
parked siblings are answered in the same leg; already-answered or stopped is not a
refusal; the optimistic lock key is an identity. Evidence:
`assistant-runtime/permission-gate-wiring.md`,
`assistant-runtime/approval-ui-and-grants.md`.
Guard: `packages/agent/src/__tests__/permission-policy-request.spec.ts`,
`packages/agent/src/__tests__/background-worker-policy.integration.spec.ts`,
`packages/agent/src/__tests__/data-stream-approval-answered.spec.ts`,
`packages/assistant-ui/src/__tests__/assistant-tool-approval-notice-panel.test.tsx`,
`approval-presentation.test.ts`, `approval-row.test.tsx`,
`approval-queue-strip.test.tsx`, `child-view-owner-approval-answers.test.tsx`,
`apps/desktop/src/__tests__/main/tools-ipc-main-wiring.test.ts`,
`apps/desktop/src/__tests__/assistant-server/delegated-runtime.integration.test.ts`
(the whole flow through the REAL desktop host, ledger and background store — the
proof every host-boundary change must carry).

THE PAUSE IS ALSO A DURABLE ROW:

- Every approval pause writes a `tool.approval.requested` run event carrying the
  paused call's `toolCallId`, so a LIST-WIDE "which threads are waiting on me?"
  can be answered in SQL. Its consumer is the Threads panel's "needs you"
  projection.
- RESOLUTION IS DERIVED AND RUN-AGNOSTIC. Nothing marks the row answered; a pause
  is resolved by the LATER existence of `tool.started` / `tool.completed` /
  `tool.failed` / `tool.resume.unsupported` for the SAME `metadata->>'toolCallId'`.
  PAIRING is on that id and never on `run_id`. The SQL, the `tool.started`
  ordering guard and the producer shapes that make it load-bearing are specified
  once in `docs/agents/assistant-persistence.md` § THREAD GROUPS — do not restate
  the rule here. Two earlier restatements each drifted.
- IT DELIBERATELY IGNORES `thread_runs.status`: a leg that pauses finishes
  `tool-calls`, recorded as `completed`, so a `status = 'running'` join would make
  the projection permanently empty. The startup run-reap does not gate it either.
- AN ABANDONED PAUSE STAYS LIT (known). Only an outcome event for that
  `toolCallId` clears the glyph. Lighting it is the safe direction, but it is a
  real dead end, not a design intent to defend.

APPROVAL ACTION MESSAGES ARE BOOKKEEPING, NOT CONVERSATION:

- Clicking a decision appends a user message whose `metadata.custom` +
  `runConfig.custom` carry the action with an echo text. Approval actions are a
  strict wire object: exactly the own keys `action`, `runId`, `toolCallId` and
  optional `toolName`/`hostRunId`, each non-empty and bounded by the shared
  approval-transport constants. Suspend resume actions mirror that contract for
  `resumeData`, `runId`, `toolCallId` and optional `toolName`/`hostRunId`. Extra
  own or inherited fields, blank identifiers and oversized identifiers are
  malformed.
- `runId` is the NATIVE Mastra run the resume routes address; `hostRunId` is the
  DURABLE host leg copied from the pause. The two are never interchangeable — see
  the DURABLE-PARENT INVARIANT in `assistant-persistence.md`.
- Every Desktop and Hosted Web boundary parses BOTH continuation kinds before
  dispatch: a malformed action returns `invalid_tool_approval_action` /
  `invalid_tool_resume_action` HTTP 400, and two valid actions return
  `conflicting_tool_continuation_actions` / 400.
- Hosted Web has no tool registry or durable workflow store: both the Vercel
  Preview function and Vite dev/preview return `tool_approval_unavailable` /
  `tool_resume_unavailable` HTTP 409, identically, so a long-lived dev process
  cannot advertise behaviour that fails on another instance. Deployable Vercel
  wrappers fail closed outside Preview as `production_auth_required`. Hosted Web
  rejects every non-empty `Last-Event-ID` with `stream_resume_unavailable` / 409
  after enforcing the body-size bound. Normal Web turns run without workflow
  storage, so approval/suspending tools stay fail-safe omitted.
- Before any Vite dev/preview assistant route reaches those contracts, its
  developer-key boundary requires a loopback TCP peer, a loopback `Host`,
  same-origin browser provenance (permitting no-`Origin` loopback CLI calls) and
  `application/json` on POST. Boundary failures are typed 403/415 responses that
  drain the request and never fall through to Vite. Vercel entrypoints use their
  separate deployment boundary.
- The panel renders the action message as a compact outcome chip
  (`approval-action-chip.tsx`), never a prompt bubble. The recognizers are STRICT;
  an unrecognized or malformed marker falls through to the ordinary bubble —
  content is never hidden behind a guessed chip.
- The shared transport excludes action messages (BOTH keys, via the single
  recognizer `approval-action-message.ts`) from EVERY outbound payload BEFORE
  `selectTransportMessagesForMastraMemory`. Action legs themselves ship
  `messages: []`. The transport recognizer uses the SAME strict guards as the chip:
  a record-but-structurally-invalid marker is NOT an action, so the transport
  keeps it on the wire rather than silently dropping a user-visible prompt.
- Mastra never persists the echo, so it is absent after reload; restart-safe
  rediscovery owns the post-restart UI.

Evidence: `assistant-runtime/approval-durable-row.md`.
Guard: `packages/assistant-ui/src/__tests__/data-stream-runtime.test.ts`,
`packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`
("never persists an approval action echo").

NAME-FORM CONTRACT (the rediscovery live bug class):

- Mastra registers tools under SANITIZED ids and its stream parts and suspended-run
  snapshots carry that registered id. Every CLIENT-FACING approval surface is keyed
  by the ORIGINAL dotted name.
- `askTools` stays SINGLE-keyed by sanitized id — dual-keying would inflate
  `askTools.size` and corrupt the empty-ask-set posture check.
  `resolveAskToolMetadata(askTools, name)` resolves metadata under EITHER form:
  `get(name)` first, else a scan over `meta.originalName`.
- The emitted chunk's `toolName` is always the ORIGINAL name, resolved as
  `sanitizedNameMap?.get(raw) ?? denormalizeNativeToolName(raw)` — the SAME
  MAP-WINS order as `resolveDiscoveredApprovalToolName`, `listSuspendedMastraRuns`
  and `ProjectionSafeToolCallFilter`. The runtime `toolNameMap` is AUTHORITATIVE
  (it is the only layer that can bridge MCP names); the static native reverse map
  is only the fallback for a route whose runtime registered no natives.
- **ORDER IS LOAD-BEARING; do not simplify it to
  `denormalizeNativeToolName(map.get(raw) ?? raw)`.** `sanitizeTools` records
  `map.set(uniqueName, name)` UNCONDITIONALLY including the identity case, so
  denormalizing a successful hit would rewrite an authoritative original and submit
  the wrong id to per-tool grant handling. `makeUnsupportedApprovalChunks` resolves
  identically.
- A policy-driven pause whose tool resolves under NEITHER form still surfaces the
  pause but omits `riskCategory`/`policyDecision` (never fabricated) and logs
  `mastra_agent_approval_metadata_unresolved` at error.
- `listSuspendedMastraRuns` maps each discovered `toolCall.toolName` back through
  the discovery runtime's `toolNameMap` first, else the static native reverse map,
  else passes the registered id through with
  `mastra_agent_suspended_tool_name_unmapped`. The desktop route then warns
  `assistant_suspended_approval_risk_unresolved` when a rediscovered approval has
  no risk category — honest degradation: no reason line, no grant buttons.
- KNOWN DISPLAY GAP (documented follow-up, NOT a bug): on the KEYLESS discovery
  route an MCP tool falls through BOTH maps, because MCP sanitization is not safely
  reversible, so a rediscovered MCP approval displays its sanitized id.
  Display-only: MCP is absent from the native risk map, so grant actions are
  correctly absent anyway and the pause still surfaces for approve/decline.
- Store migration (enforce-on is a SECURITY fix): v2 adopts the secure default
  `true` for ANY pre-v2 slice, because a pre-v2 `false` is indistinguishable from
  an opt-out. Only a v2+ persisted boolean is honored verbatim. The store also
  sanitizes every current-version hydration through the shared persist merge:
  malformed `enforce`/`yolo` take secure defaults, invalid policy and override
  entries are dropped, and persisted action-shaped keys or `sessionGrants` never
  enter live state.
- Web's in-renderer LocalRuntimeChat never reaches `streamMastraAgent`, so ask
  tools are fail-safe-omitted there.

Evidence: `assistant-runtime/tool-name-form-contract.md`.
Guard: the four name-form cases in
`packages/agent/src/__tests__/mastra-tool-approval-chunks.spec.ts`, the dotted-id
cases in `mastra-suspended-runs-discovery.integration.spec.ts`.

Restart-safe rediscovery — a run suspended for approval OR by a tool's `suspend()`
survives a desktop restart or renderer reload, but the LIVE notice (a
never-persisted stream data part) does not:

- On thread open the desktop history adapter rediscovers both pause kinds and
  re-surfaces working notices, REUSING the already restart-safe, stateless resume
  seams untouched. The old "non-approval pauses are tolerated + skipped" behaviour
  is GONE, and with it the silent stranding path.
- `listSuspendedMastraRuns` (`mastra/suspended-run-discovery.ts`) wraps
  `agent.listSuspendedRuns`, rebuilds a FRESH runtime, and returns
  `{ approvals, suspends }` with `toolName` mapped back to the ORIGINAL dotted
  form and suspends carrying the `suspendPayload` recovered from the durable
  snapshot. Only a call missing its ids is tolerated and skipped. Discovery is
  CONTEXT-FREE and KEYLESS: the stable agent id is provider-independent, so listing
  constructs a keyless agent with no provider or apiKey and no inference. Desktop
  constructs the paired PGlite memory/storage with observational memory and
  semantic recall DISABLED for this request, or an enabled configuration could
  resolve a provider key and violate the keyless contract.
- `GET /assistant/suspended-runs` recomputes `riskCategory`, stamps `stale` against
  `BRAINSTRIKE_APPROVAL_STALE_MS`, and flags a suspend whose tool has no
  `hasRegisteredSuspendResumeUi` with `resumeSupported: false` plus a loud warning
  — never a silent drop. Missing thread ctx → 400; no storage → 503. `suspends` is
  ADDITIVE in the response.
- `createSuspendedRunDiscovery` is desktop-capability-gated (web omits it, no
  `isElectron()`). `appendSuspendedPauseMessages` appends one synthetic trailing
  assistant message per pause, interleaved oldest-first, identical to the live
  mapper's output. Staleness is display-only via the SHARED
  `RediscoveredPauseLines`: a muted "Pending since <relative>" line always, an
  amber advisory when `stale`, controls enabled, NO auto-decline or auto-answer.
- **Corrupt snapshot rows.** Every TARGETED snapshot read in `PgliteWorkflowsStore`
  THROWS on a snapshot that is not an object or lacks `context` — the malformed row
  is the answer the caller asked for. `listWorkflowRuns` is the ONE deliberate
  exception: it returns the intact rows, because throwing for the page would make
  EVERY pending approval undiscoverable. Each excluded row is logged at ERROR with
  `mastra_workflow_snapshot_malformed`, eagerly flushed into
  `brainstrike_diagnostic_events`. Do not downgrade it, and do not make listing
  throw.
- The ERROR record is emitted ONCE PER RUN PER PROCESS
  (`PgliteWorkflowsStore#reportedMalformedRuns`), because a corrupt row is
  permanent while the listing runs on every reload and every approval. Repeats
  carry no information and suppressed repeats still emit a `debug` record.
- `total` and `runs.length` may legitimately disagree: `total` is AUTHORITATIVE for
  what matches the filter IN STORAGE and must not shrink as corrupt rows are
  excluded; the invariant is `runs.length <= total`. The corruption signal is the
  ERROR diagnostic, not the arithmetic.
- Desktop request initialization validates `enabledNativeToolIds` against the
  shared desktop catalog before constructing a stream; a stale or unknown id
  returns `invalid_enabled_native_tool_ids` at stage `native_tool_preferences` with
  a safe id or fingerprint and a correlation id, never silently dropped.
  Workspace-root enrichment has its own `workspace_root_resolution` stage: a
  persisted binding whose root is no longer live returns
  `bound_workspace_root_unavailable` with HTTP 409, while unrelated resolution
  faults keep the redacted correlation-id 502.
- Catalogued tools intentionally unavailable for the active provider are a
  capability omission, debug-logged separately, never mislabeled unknown. An
  unavailable admitted model or tool returns the same actionable HTTP 409 as a
  rejected persisted profile, including approval and question resume; it is never
  rewrapped as a generic 502. Other initialization failures return only a safe
  stage plus a correlation id.

Settled: keyless, context-free discovery; listing tolerates corrupt rows while
targeted reads throw; the ERROR is once per run per process; `total` stays
authoritative. Evidence: `assistant-runtime/restart-safe-rediscovery.md`.
Guard: `packages/agent/src/__tests__/mastra-suspended-runs-discovery.integration.spec.ts`,
`mastra-tool-approval-suspend.integration.spec.ts`,
`mastra-tool-suspend-resume.integration.spec.ts`.

NOTE: the per-tool approval gate is SEPARATE from tool SUSPENSION — see PLAN MODE
& TOOL SUSPENSION below. Approval pauses BEFORE a tool runs; suspension pauses
DURING a tool's `execute` via `suspend()`. `run_python`'s Gate B network
escalation is the third registered suspending tool: per-call, argument-aware and
structurally ungrantable — the escalation card requires every named domain
individually ticked, renders deny primary and autofocused, and has no grant
surface at all. `submitPlan`/`askUser` are classified `riskCategory:'read'` so the
permission engine never stacks an approval prompt on top of their own suspend.

## WORKSPACE-ROOT AUTHORIZATION

- Desktop workspace tools authorize filesystem access ONLY from
  `RuntimeData.workspaceRoots`, populated server-side from live path-backed rows in
  the `roots` table.
- `workspaceRootPath`, `mainRootPath` and related renderer fields are selection or
  ordering hints; they never synthesize an authorized root.
- A successful empty DB query records `workspaceRoots: []`. A failed query leaves
  the inventory absent and root resolution fails closed and visibly, never falling
  back to a renderer-provided absolute path.
- Focused selection and Tapestry reads must match exactly one entry in that same
  authoritative inventory.

## TOOL-LIFECYCLE HOOKS (Claude-Code-style)

User-authored shell commands that run at lifecycle events and, for blocking
events, can refuse to proceed. **Desktop-only by construction** — web constructs
NO hook runner (capability-gated, no `isElectron()` checks).

- Seven events, three blocking (`PreToolUse`, `Stop`, `UserPromptSubmit`). A hook
  is `{ type:'command', command, matcher?:{tool_name}, timeout?, description? }`.
  It receives a secret-redacted JSON payload on **stdin** and returns optional JSON
  on **stdout** (`{decision, reason, additionalContext}`); its **exit code** is
  authoritative: `2` = hard block on a blocking event, other non-zero =
  warn-and-continue, `0` = ok. Per-hook timeout → SIGKILL.
- **Insertion points (do not move).** `applyToolHooks`
  (`packages/agent/src/tools/hook-tool-wrap.ts`) is a SIBLING of `applyToolGuards`,
  composed OUTSIDE the guard and BEFORE the permission gate:
  `combinedTools → applyToolGuards → applyToolHooks → plan-mode → permission gate`.
  Permission runs downstream of `execute`, so **hooks REFINE, never widen**: a
  PreToolUse hook can BLOCK a permitted tool but can never allow a denied or ask
  tool. A block returns `HookBlockedToolError` (`tool_blocked_by_hook`, recognized
  by `isGuardedToolError`) and renders as a FAILED tool event.
- PostToolUse `additionalContext` is capped and carried beside the original result
  in an explicitly discriminated internal envelope. The reserved JSON shape is NOT
  sufficient proof of provenance: every consumer also requires membership in a
  private in-memory WeakSet registered only after a successful PostToolUse hook, so
  a result that copies the reserved field is ordinary visible domain evidence.
  Losing provenance through cloning or serialization fails closed as visible data.
  Mastra's target-aware transforms restore the exact domain result before the live
  UI and persistence boundary; the trusted envelope is never a public or durable
  result. A tool returning `undefined` while PostToolUse requests context fails
  visibly rather than dropping the guidance or substituting a placeholder. A
  hook-runner FAULT is allow-on-fault.
- `UserPromptSubmit`/`Stop` run in `packages/assistant-service/src/stream-init.ts`.
  A UserPromptSubmit block short-circuits the turn with a visible message +
  `run.failed` and NEVER invokes the model; `additionalContext` prepends a `system`
  message. The blocked branch returns an `ok:true` stream carrying
  `terminalStatus:'failed'`, so `runAssistantTurn`
  (`packages/assistant-service/src/run-turn.ts`) persists `thread_runs` as failed.
- **Stop is NOTIFY-ONLY in v1** and is the only phase that may report a Task Ledger
  run verdict. `withStopHook` MUST run BEFORE the `message-finish` chunk is
  yielded, not only in its `finally`: the live consumer stops pulling the instant
  the mapper emits `finish`. `finally` still fires Stop for streams that end
  without a finish chunk. SessionStart/SessionEnd/Notification are implemented but
  UNWIRED in v1.
- **Timeout invariant (honest ceiling — no summed guarantee).** There is NO
  enforced `pre + tool + post` sum ceiling. `config.ts` rejects any hook whose
  `timeout >= resolveToolTimeoutMs()`, and every hook is SIGKILLed at its own
  timeout; a per-tool declared `executionBudget` does not widen that ceiling.
  `PreToolUse`/`PostToolUse` run INSIDE the `tool-executing` phase and are bounded
  by the per-hook SIGKILL plus the derived backstop, not by an aggregate cap.
  `UserPromptSubmit` and `Stop` gate a user-visible boundary with the watchdog
  DISARMED, so each carries its OWN aggregate bound applied by `runHooksForEvent`:
  the in-flight hook is SIGKILLed at the remaining budget and the rest are skipped
  with a loud warning. `UserPromptSubmit` also enforces the bound at config load
  (a `HookConfigError` disables the phase when the combined declared timeout
  reaches the ceiling); v1 has no config-load check for Stop, whose runtime cap is
  authoritative.
- **Malformed config = disable-with-visible-error, NOT throw-at-load.**
  `loadHooksConfig` returns `{hooks, errors, sources}`; a malformed or untrusted
  file contributes ZERO hooks and records a `HookConfigError` surfaced on THREE
  channels (`logger.error`, a `hook.notice(failed)` run event, the settings
  banner). Never throw at load — that bricks every run over a typo and hands a
  malicious repo a DoS.
- **Security spine.** Global hooks (`~/.brainstrike/hooks.json`) run without
  approval. PROJECT hooks (`<root>/.brainstrike/hooks.json`) run ONLY after a
  per-root approval pinned to the file's SHA-256, recorded in the persisted,
  factory-reset-registered trust store. The renderer only ATTESTS approved hashes;
  the server independently RE-READS and RE-HASHES disk and runs a root's hooks only
  when `sha256(disk) === approvedSha256`. The hash is over RAW file BYTES, and the
  approve-time review hashes those same bytes — never a utf8-decoded string. Trust
  and parse come from ONE read (no read-vs-hash TOCTOU window). A project config's
  descriptor is accepted only after a nonblocking open proves it a regular file
  within the size bound, and its initially observed bytes are the only bytes read.
  Keyed by durable `rootId`, never raw path.
- Redact stdin payloads before spawn, mirroring the logger redact key set.
  `createCredentialIsolatedChildEnvironment` removes every provider and Tavily
  credential name before hooks and non-interactive command/skill children spawn —
  required even for SHA-256-approved hooks, because approval authorizes the
  reviewed command, not ambient disclosure. Interactive terminal/command-session
  PTYs and the LSP child still inherit the full parent environment.
- Merge order is global-first, then roots in mounted order; each loaded hook is
  tagged with its source `cwd`/`rootId` (global hooks' cwd = the MAIN root — see
  "WORKSPACE ROOT IDENTITY" in `docs/agents/workspace-context.md`).
- Thread `RuntimeData.hookRunner` as trusted, agent-only, never serialized, plus
  `RuntimeData.hookTrustRequest` on the wire. The server STRIPS any
  client-supplied `hookRunner` and injects the server-built one.
- **Run-verdict protocol.** A Stop hook may label the run's outcome by printing ONE
  JSON line: `{"brainstrikeRunVerdict":{"verdict":…,"detail":…}}`. Hook stdout is
  UNTRUSTED repo data, so `hooks/run-verdict.ts` parses strictly:
  Stop-only by construction (`captureRunVerdict` is set solely by
  `HookManager.runStop`); a bounded trailing-stdout scan whose window drops a
  partial first line; the LAST valid line wins within a hook and the LAST hook with
  a valid verdict wins across the phase; malformed JSON, unknown verdicts, a
  non-string or oversized `detail`, or any extra key is ignored with a CONTENT-FREE
  warning surfaced as a `hook.notice`. A bad line never fails the hook flow or the
  run. This scan is separate from the decision protocol.
- `withStopHook` hands Stop hooks a bounded TAIL of the RUN's assistant text, with
  a `\n` inserted at step boundaries so line-anchored graders never see step N's
  tail glued onto step N+1. The trim is amortized, omitted when the stream produced
  no text, and never grows unbounded.
- Persistence: `withStopHook` AWAITS the threaded `onRunVerdict` IN FRONT of the
  `message-finish` yield, so the label lands before the post-stream `thread_runs`
  status write. `recordDesktopAssistantHookRunOutcome` upserts via the desktop DB
  handle and derives thread/resource ids from the runs row; a missing runs row
  THROWS. It is byte-consistent with the repository's `recordRunOutcome` PLUS the
  SQL precedence guard `source <> 'user'`: a hook label NEVER overwrites an
  explicit user verdict, while a later user verdict still replaces a hook label.
  Allow-on-fault: a failed verdict write is a loudly logged lost label, never a
  lost finish. Run-event kinds: `hook.blocked`, `hook.notice`.
- **Trust is keyed by the DB `roots.id`, NOT the adapter rootId (SECURITY).** They
  are separate identity domains. The review IPC runs in MAIN, CONTAINMENT-checks
  the reviewed realpath against mounted DB roots (`resolveDbRootForPath`; an
  arbitrary or symlink-escaping path is refused) and returns the resolved
  `dbRootId`, which the panel keys status/approve/revoke by.
  `buildHookTrustRequest` is SCOPED to currently-mounted DB ids and attests NOTHING
  until resolved or if the resolver is absent (fail closed).
- The disconnect-severs property is SERVER-ENFORCED: `fs:removeRoot` asks
  `WorkspaceRootRegistry` to remove the mount and converge the DB to the complete
  remaining mounted-path set, with the persisted registry write first and a DB
  failure rolling it back before the IPC rejects. Every server-side consumer of
  `loadWorkspaceRootsFromDatabase` serves only `status='live'` rows.
  `reconcileRoots` restores `status='live'` on remount by path-matching the KEPT
  row, so disconnect ≠ delete.
- CONVERGENCE: `WorkspaceRootRegistry` serializes add, restore, preference and
  disconnect transitions. `rootsList` is its persisted mount inventory; only
  successfully mounted, persisted presentation paths are supplied to
  `markRootsDisconnectedExcept`. An EMPTY mounted set is meaningful and demotes
  every comparable path-backed row. Web FSA rows stay outside this comparison.
- Restore never guesses: malformed `rootsList` JSON or shape THROWS before DB
  convergence; a missing or transiently unmountable folder stays persisted, is
  returned as `permissionState:'unknown'`, and is excluded from the mounted DB
  authorization set. Boot-time DB convergence is allow-on-fault with an ERROR log;
  explicit disconnect is fail-closed with storage rollback.
- Renderer state is a projection: `removeRootDirectory` awaits the authoritative
  IPC transition and changes no renderer state when it rejects. `lastFolderPath` is
  only a preference for an already-persisted, mounted root.
- The trust store bumped to v2: pre-v2 adapter-keyed approvals are DROPPED at
  migration. Factory reset clears the store unchanged.
- Settings surface: `hooks-settings-section.tsx` per-root
  trusted/untrusted/changed/parse-error plus approve/revoke, via the
  `hooks:getProjectHooksForReview` IPC and the capability-gated `window.hooks`
  preload bridge. LIVE mounted roots come from the file-explorer store, reactive to
  mount/unmount with no restart. Each row's review is fetched independently; a
  transport-level failure for one root renders THAT row `Unavailable`, never a
  stale or empty "no hooks" lie.
- **Deferred:** SessionStart/SessionEnd/Notification wiring; Stop auto-continue;
  full hooks.json editor UI; rendering fetched `content` in-panel; a refetch on
  approve/revoke/refocus; the `<userData>` vs home-dotfile decision.

Evidence: `assistant-runtime/hook-events-and-timeouts.md`,
`assistant-runtime/hook-config-and-trust.md`,
`assistant-runtime/hook-run-verdict.md`,
`assistant-runtime/hook-settings-and-root-identity.md`.
Guard: the hook cases in
`packages/agent/src/__tests__/mastra-tool-execution.integration.spec.ts` (real
Agent + real `applyToolHooks`, no stream mocks),
`apps/desktop/src/__tests__/assistant-server/hooks/run-verdict.test.ts`,
`hooks/server-composition.integration.test.ts`,
`apps/desktop/src/__tests__/assistant-server/hook-run-outcome.integration.test.ts`,
`apps/desktop/src/__tests__/assistant-server/workspace-roots.integration.test.ts`.

## SYSTEM-INSTRUCTION COMPOSITION

`composeRuntimeInstructions` (`agent-runtime.ts`) assembles what the model
receives in two halves that `composeCacheAwareInstructions` keeps apart:
**`stableText`** (the resolved instructions, the CURRENT-DATE note, the
context-budget note — cached) and **`volatileText`** (the task-list note, re-sent
each turn, never cached).

- **THE DATE IS COMPOSED OUTSIDE THE PROVIDER BRANCH.** Join
  `buildCurrentDateNote` into `stableText` alongside the budget note; do NOT
  thread it into `buildDefaultInstructions`. There are three instruction paths —
  the hosted default, `buildLocalDefaultInstructions`, and a caller-supplied
  override — and only the first takes options, so injecting there leaves the other
  two shipping dateless prompts.
- **DATE ONLY, and LOCAL.** A clock time would invalidate the cached prefix every
  turn; a date moves at most once a day. The day is the user's, not UTC:
  `toISOString()` would state tomorrow's date to anyone east of UTC in their early
  morning. Format is `en-CA` (whose short date IS ISO 8601) plus the weekday name.
- The clock is INJECTED (`composeRuntimeInstructions({ now })`) so the composed
  instructions stay a pure function of their inputs.

Settled: a model with no date substitutes its training cutoff or a guess, and an
observed run wrote a fabricated date into durable working memory. Evidence:
`assistant-runtime/system-instruction-date.md`.
Guard: the frozen-time case that drives `createMastraAgentRuntime` and asserts the
date reaches `config.instructions` (asserting `buildCurrentDateNote` directly
would prove only that it renders a date it was handed).

## RUN-CREATION SEAM: WHAT MAY COMPOSE AROUND IT

`useAssistantRequestLifecycle.prepareRequestData` is the single place a run comes
into existence in the renderer: it calls `createAssistantThreadRunPromise` →
`repository.createThreadRun`, the SOLE runId minting site
(`docs/agents/assistant-persistence.md`).

- Features that act "when a run starts" COMPOSE AROUND that callback in
  `assistant-ui-panel-wrapper.tsx`. Never add a second producer; never grow the
  lifecycle hook a feature-specific branch.
- **It fires for EVERY run, not every user message.** Anything that must
  distinguish "the human sent something" needs a SECOND signal:
  `AssistantUiPanel`'s `onThreadRunStart`, the composer form's `onSubmitCapture`.
- **Neither signal is sufficient alone** — Enter on an EMPTY composer fires
  `onThreadRunStart` and sends nothing. The conjunction (a submit FOLLOWED by a run
  creation) is the only honest reading.
- Conversation Rewind finalization is the first consumer:
  `markUserAuthoredSend` arms a read-and-cleared flag and the wrapper consumes it
  after the run row exists.
- **A composed effect MUST NOT be awaited by the send.** `finalizeAfterRunCreated`
  returns `void` deliberately: a cleanup the user did not ask for may never delay
  or fail the send. Report failures (log + toast); never swallow them and never let
  one reach the composer.
- **An abort that lands after run creation is not a send.** Re-check
  `abortSignal.aborted` before firing a composed effect; the arming flag stays set
  and the retry that actually sends fires it.

Evidence: `assistant-runtime/run-creation-seam.md`.
Guard: `packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-rewind-finalization.test.tsx`,
`packages/app-shell/src/changes/__tests__/use-rewind-finalization.test.ts`.

## PLAN MODE & TOOL SUSPENSION (ask-user / submit-plan)

Two SUSPENDING native tools pause the run DURING execution and resume with
arbitrary data, on a NEW transport that PARALLELS the approval transport rather
than overloading it. Built on Mastra tool `suspend()`/`suspendSchema`/
`resumeSchema` plus `agent.resumeStream(resumeData, {runId, toolCallId})`; the
supported `@mastra/core` range lives in `packages/agent/package.json` and the
version ceiling in `mastra-boundary.md`.

- **`submitPlan`** takes a structured plan INLINE (`{title, overview, steps[],
  risks?, verification?}`), `suspend()`s with it, and returns `{status, feedback?}`.
  Resume vocab is the builtin-compatible `{action:'approved'|'rejected', feedback?}`.
- **`askUser`** takes `{question, options?, selectionMode?}` and resumes with the
  `{answer: string | string[]}` ENVELOPE — an object so the `approved: true` rider
  can attach when askUser is ask-gated. It still accepts the LEGACY bare
  `string | string[]` so pre-migration runs stay resumable; multi-select joins with
  ", ".
- The renderer structurally narrows both tools' `suspendPayload` before displaying
  or resuming it. An absent payload retains the generic actionable fallback. Core
  plan terms and the question/options must be readable; one unreadable decision
  term makes the decision unapprovable, while unreadable advisory fields are simply
  omitted. A present non-array option list, an unknown `selectionMode`, or a
  selection mode without readable options likewise makes the question unanswerable
  rather than silently changing its interaction mode.
- An unreadable core payload renders a diagnostic failed alert with a scrollable
  bounded raw-payload view; the same bounded serialization is logged once per
  run/tool-call identity across remounts, through a capped process-local identity
  cache with deterministic oldest-entry eviction. The user may safely reject an
  unreadable plan, never approve it. A readable question whose choice controls
  drift stays an explicit failed alert offering a clearly-labelled free-text
  answer; if the question itself is unreadable its alert cannot be dismissed or
  answered.

**Transport table (parallel to approval):**

| Layer | Approval | Suspend |
|---|---|---|
| Stream chunk | `tool-approval-required` | `tool-suspend-required` |
| Data part | `brainstrike.tool-approval` | `brainstrike.tool-suspend` |
| Run-config key | `brainstrikeToolApproval` | `brainstrikeToolSuspend` |
| Resume action | `AssistantToolApprovalAction` | `AssistantToolResumeAction` |
| Server fn | `streamMastraToolApprovalAction` | `streamMastraToolResumeAction` |
| Mastra call | `approveToolCall`/`declineToolCall` | `resumeStream(resumeData,{runId,toolCallId})` |
| UI renderer | `AssistantToolApprovalNotice` | `AssistantToolSuspendNotice` |

Contract types and guards live in
`@brainstrike/assistant-contract/tool-suspend`; `readToolResumeRunConfigAction`
returns `{invalid:true}` on a malformed action, surfaced as a 400, never coerced.

- `makeToolSuspendRequiredChunks` turns Mastra's `tool-call-suspended` into a
  resumable `tool-suspend-required` chunk plus a tool-calls finish, and STOPS at
  the pause. A native OpenRouter pause finish has zero tokens and no billed-cost
  field; resume emits the deferred step finish before continuing. A malformed pause
  (missing toolCallId/runId) still falls back to the unsupported termination so it
  fails visibly.
- **Unknown resume schemas are REJECTED VISIBLY and NON-TERMINALLY.** Only tools in
  `REGISTERED_SUSPEND_RESUME_TOOL_IDS` have a registered typed suspension UI. A
  well-formed pause from any OTHER tool still becomes a `tool-suspend-required`
  chunk, but `makeUnregisteredSuspendResumeNoticeChunk` PREPENDS a durable
  `tool.resume.unsupported` run event and a coded `logger.error`. The tool-defined
  `suspendPayload` is deliberately EXCLUDED from that durable metadata — run-event
  metadata is allowlist-by-denial, not a content channel.
- **Its OWN run-event kind, never `tool.failed`.** `tool.failed` is consumed as a
  METRIC in three places that each enumerate kinds explicitly, so the new kind is
  excluded from all three by construction: the run-ledger aggregation SQL would
  double-count the call, `collectToolDurations` would invent a duration, and
  `getMatchingFailedKind` would resolve the `tool.started` row to `failed` when the
  tool IS still suspended. No tool ran and none failed: this is a CLIENT CAPABILITY
  MISMATCH.
- **No `tool.failed` is emitted upstream either — verified against the live loop.**
  A real `suspend()` emits no `tool-error` at all; the observed durable sequence is
  `run.started` → `run.step.started` → `tool.started` → `tool.resume.unsupported` →
  `tool-suspend-required`. The mapper's line deleting the suspended call's
  `pendingToolErrorTexts` entry stays as defence in depth; it is NOT evidence of
  current behaviour.
- **Tool-call args-stream discipline.** The decoder THROWS in strict mode on a
  duplicate tool-call id or on a `c`/`a` naming an id it never saw, and some
  providers emit trailing `tool-call-delta` parts after the complete call and after
  the result. `data-stream-mapper.ts` therefore (1) emits the `c` args-delta frame
  only while `toolState` exists AND `argsEmitted` is false, and (2) tracks
  `settledToolCallIds` so a late progress event for a settled call is dropped
  instead of auto-starting a duplicate `b`. Guard (1) is MORE valuable since the
  decoder downgraded its failure to a one-shot warning, because silently discarded
  args are still a correctness bug and now a quiet one.
- Mastra's dynamic `data-om-*` chunks are handled by prefix: `-failed` variants map
  to a durable `memory.observation.failed` run event; other OM bookkeeping is
  deliberately silent and never trips the unrecognized-chunk warning.
- **Durable AND always visible.** The `brainstrike.tool-suspend` data part is
  transient, so the run event is what survives a reload, rehydrated as a run-event
  data part; `tool.resume.unsupported` is in `isAlwaysVisibleRunEvent` so it renders
  at the DEFAULT detail level.
- `isAlwaysVisibleRunEvent` alone is NOT sufficient — settled, do not relitigate by
  reverting the exemption. It only selects which component renders the row; both
  paths then consult the render plan, whose first suppression rule hides ANY
  `tool.*` event whose `toolCallId` has a `tool-call` part in the thread, and
  `handleToolSuspendRequired` GUARANTEES that part exists. Both functions therefore
  skip card suppression for always-visible kinds. The rule still applies to every
  other `tool.*` row. Any test covering this MUST put the mapper's `tool-call` part
  in the mock thread — a fixture with only the run-event part passes vacuously.
- `kind` is a plain `text` column, so the new kind needs no migration — but the
  read-path `requireRunEventKind` throws on an unknown kind, so DOWNGRADING to a
  build predating this enum entry fails that thread's entire run-event hydration.
  The constraint is one-directional and only bites on rollback.
- **The tool card is SETTLED.** `handleToolSuspendRequired` emits a `tool-call`
  part so the pause has a card. For a registered tool the missing result is correct;
  for an unregistered one nothing ever will be, so the chunk carries
  `resumeSupported: false` and the mapper emits a terminal `toolCallResult` with
  `isError: true`. It is deliberately NOT recorded in `pendingToolErrorTexts`.
- **The APPROVAL DECLINE is the second terminal under that same rule.** It arrives
  as its own `'declined'` tool-event status and `handleToolDeclined` settles the
  call (`toolCallResult` + `settledToolCallIds`) while recording NOTHING in
  `pendingToolErrorTexts` and setting no `isError`. The frame carries the shared
  `DeclinedToolCallResult` envelope, which `settledResultOverride` reads to render
  the muted `stopped` treatment. The two terminals differ only in what they say
  about the RUN: this one is over, the resume-unsupported one is still suspended.
- Neither is the `makeUnsupportedApprovalChunks` idiom (`run.failed` + error
  finish), because **Mastra persists the suspended workflow snapshot BEFORE the
  stream part is mapped** — terminating the client stream removes nothing and a
  durable `run.failed` would be false. Leaving the run suspended is INTENDED.
  `makeUnsupportedApprovalChunks` stays terminal only because a MALFORMED pause is
  genuinely unrecoverable.
- `UnsupportedSuspendNotice` is the matching renderer surface: no guessed typed
  action, but a `role="alert"` card saying the pause cannot be answered by this
  build, with a Dismiss control. Its copy claims nothing about server-side state,
  because it must also be true under version skew.
- `AssistantToolSuspendNotice` dispatches through a total
  `Record<RegisteredSuspendResumeToolId, …>`, so adding an id without a typed branch
  is a COMPILE error, and `SUSPENDING_NATIVE_TOOL_IDS` is DERIVED from the same
  registry. The REVERSE drift (a tool that can `suspend()` with no registered
  resume UI) has no compile-time guard, so the scan script sweeps source
  RECURSIVELY, comment-stripped, on the loose `\bsuspendSchema\b` token in two
  scopes: the two declaration roots drive an exact match against
  `REGISTERED_SUSPENDING_TOOL_MODULES`, and a repo-wide `apps` + `packages` sweep
  must equal that set plus an explicit `ACKNOWLEDGED_NON_DECLARING_MODULES` list.
  Every scan root is asserted to exist and be non-empty, because
  `walkTypeScriptFiles` swallows a missing directory. Known limitation:
  `stripComments` has no string-literal awareness. It lives in `test:scripts`
  rather than a package spec because a package-scoped vitest reading a foreign
  package's source is an unhashed turbo input.
- **Resume** (`streamMastraToolResumeAction`) REQUIRES Mastra workflow storage
  (throws without it), calls `resumeStream`, threads
  `withRuntimeDerivedStreamOptions` so the rebuilt Agent keeps its native tools, and
  does NOT pass `requireToolApproval`. It is stateless, holding no in-memory runId.
- **Storage fail-safe** (`resolveSuspendToolsForRun`, `plan-mode-tool-gate.ts`): a
  tool that can `suspend()` — detected structurally by an own `suspendSchema` — is
  FAIL-SAFE omitted when there is no storage to resume it.
- **Plan mode** is opt-in per request (`runtimeData.planMode`), sent only when the
  persisted composer toggle is on and the transport is the desktop data-stream one.
  `filterToolsForPlanMode` runs BEFORE the permission gate and keeps risk ∈ {read,
  mcp}, omitting every edit/execute tool.
- **A suspend schema is NOT an admission ticket.** Suspending tools survive on
  their risk classification alone; an unclassified tool falls to `mcp`, which plan
  mode keeps. `manageTaskList` (`riskCategory:'read'`) DELIBERATELY stays available
  — it is thread bookkeeping, not workspace mutation.
- `buildDefaultInstructions(toolNameMap, {planMode})` prepends a PLAN-MODE block.
  THREE-SIDED local gating: the filter, the instruction block and the runtime
  `planModeActive` guard all check `normalizedProvider !== 'local'`, and the
  composer toggle is HIDDEN for the `'local'` provider rather than silently
  no-opping.
- **Approve exits plan mode:** approving a submitted plan clears the persisted
  toggle BEFORE the resume request is composed (via the `PlanModeExitProvider`
  seam), so the resume omits `planMode` and the rebuilt runtime unlocks the
  mutation tools. REJECT keeps plan mode on so the model can revise.

Evidence: `assistant-runtime/suspending-tools.md`,
`assistant-runtime/unregistered-suspend-resume.md`,
`assistant-runtime/suspending-tool-registry-scan.md`,
`assistant-runtime/plan-mode-gating.md`.
Guard: `packages/agent/src/__tests__/mastra-tool-suspend-resume.integration.spec.ts`
(real Agent + real PGlite), the unregistered-resume and sanitized-id cases in
`mastra-tool-approval-chunks.spec.ts`, the settle-the-card cases in
`data-stream-session.spec.ts`,
`packages/agent/src/mastra/__tests__/plan-mode-tool-gate.spec.ts`,
`scripts/__tests__/suspending-tool-registry-contract.test.mjs`.

---

### Complete tool arguments at the decoder boundary

`DataStreamMapper.finishToolArgs` is the shared argument-completion boundary. For
the catalog-pinned assistant-stream decoder, `b` creates the tool part, `c`
appends its argument text, and `9` closes that existing argument stream without
reading `9.args`.

- Emit complete non-streaming input as a `c` BEFORE `9`; never emit already
  streamed JSON twice. All existing close paths use this helper and retain their
  data/text deferral ordering. This applies to parent and delegated frames through
  the same encoder.
- When complete input arrives after a partial prefix, give the append-only
  argument stream only the missing suffix before closure.
- Defined empty objects and arrays are complete inputs too; absence is distinct
  from an empty container. Incoming argument deltas supersede an earlier empty
  start placeholder, and a later terminal's explicit empty input remains
  authoritative. Native `tool-error` mapping forwards its optional complete args to
  this boundary.
- Ignore JSON whitespace outside strings for prefix matching, but require the
  actual concatenated text to parse — whitespace can terminate a numeric token.
  Already complete equivalent JSON may use different whitespace, key order or
  escape spelling; compare canonical keys in CODEPOINT order, never locale
  collation.
- A complete input that cannot extend the partial prefix, or disagrees with an
  already complete input, FAILS VISIBLY instead of appending a second JSON object
  or claiming parity. The input closes exactly once before the error reaches the
  session, which emits its ordinary error and error-finish frames while retaining
  preceding text. This includes incompatible partial escape spellings; no earlier
  bytes are rewritten.
- Without authoritative complete input, an aborted partial stream retains its
  existing partial-input behaviour. This is not a general JSON repair algorithm.
- `9.args` remains part of the existing complete-call wire contract; the extra
  delta is what started calls need in the installed decoder. Native persistence
  reads neither frame. `completeArgsStream` remains a separate bookkeeping and
  data-flush boundary and must still run after input closure.

Evidence: `assistant-runtime/decoder-argument-completion.md`.
Guard: the real-decoder regressions in
`packages/agent/src/__tests__/data-stream-tool-input.spec.ts` (direct input, late
complete input, streamed input, and approval with and without an open input
stream).

### Scoped child tool-event chronology

- The shared live encoder creates a tool part BEFORE publishing its `tool.started`
  data. Hydration uses the scoped event's existing native message and tool-call
  ids to preserve that boundary even when earlier text or reasoning carries the
  same millisecond timestamp. It mints no ordering timestamps and does not change
  the event journal.
- Cancelled missing tool parts retain their paired event history.
- Hydration deduplicates tool calls within ONE assistant group, preserving
  progressive snapshots without removing a same-id tool in a later turn or a
  regenerated sibling. Native message assignment precedes tool anchoring, and a
  trailing tool releases its lifecycle queue through the normal final flush.
- Scoped tool completion or failure cannot precede its persisted tool part when
  the loaded journal has no start event. The tool boundary is only a LOWER BOUND
  for terminals: their timestamps still preserve text streamed while the tool was
  running.
- Never change content order or fabricate missing parts for a terminal-only or
  mixed-legacy journal.

Guard: the real desktop parity fixture, which compares every lifecycle data part
in order alongside text/reasoning/input/result before and after native memory
reconstruction (`apps/desktop/src/__tests__/assistant-server/delegated-stream-parity.integration.test.ts`),
plus the paired hydration regressions for reused native tool ids across turns.
Full resumed-message and receiver/replay parity remains BST-1719 work.

### Renderer child conversation receiver

`BrainstrikeDataStreamRuntimeAdapter` consumes scoped envelopes when the
`onDelegatedConversation` consumer is supplied; the panel and the stable runtime
hook forward the current callback.

- Each native invocation owns ONE installed `DataStreamDecoder` and
  `AssistantMessageAccumulator`. Changing the observed native message id does not
  replace that decoder or lose an open tool input. Descendant envelopes use the
  same receiver recursively.
- Decode child tools from host results; never execute them against the parent's
  client tool registry.
- Updates are ephemeral FULL SNAPSHOTS carrying the immutable native invocation
  coordinates and the latest observed native message id. Consumers replace state
  for that invocation on replay. Native memory remains the only transcript writer:
  this layer adds no store, migration, endpoint, synthetic native identity or
  parent-model budget change. Parent part indices and existing auxiliary data stay
  intact; child text never becomes parent text.
- A receiver lifetime starts at the matching native opening frame. Full session
  replay builds fresh decoders and replaces snapshots with no new model POST. An
  unseeded suffix or mismatched opening identity FAILS VISIBLY rather than
  presenting an incomplete prefix as a complete transcript.
- Normal child error frames stay in that child. A missing child terminal produces
  an incomplete child snapshot and fails the parent transport visibly. The response
  owner settles every child pipeline even when an upstream fault bypasses stream
  flush. Cancellation gates callbacks and drains vendor tool substreams through
  normal closure, preserving the stream-insulation contract. No sleeps, retries or
  timeout changes establish these lifecycle guarantees.
- Receiver completion uses the same `deferMessageFinishUntilFlush` transform as the
  parent; both final part streams and descendant receivers settle before a complete
  snapshot is published. Producer failures and cancellations still emit their
  required `d` finish frame — an error frame alone is a truncated stream, not a
  valid child terminal. Cleanup preserves the primary
  transport/envelope/abort failure and logs secondary settlement failures once.
- Consumer presence selects receiver installation at run start; an installed
  receiver reads the latest committed callback on each update, including callback
  replacement during an active run.
- Within a child receiver the FIRST observed failure remains authoritative across
  observer, decoder, writer-close and descendant settlement errors.

Evidence: `assistant-runtime/child-conversation-receiver.md`.
Guard: the public adapter tests (concurrent children sharing tool ids, changed
observed message ids with partial arguments, recursive descendants, replay
replacement, malformed openings, partial updates, transport failure, abort), and
the desktop native parity fixture, which drives the public replay adapter directly
with the real host response rather than extracting child frames by hand.

### Child response completion boundaries

- Child assembly installs the shared response-boundary output processor alongside
  the existing delegated turn-persistence processor.
- Through Mastra's public `processOutputStep`, terminal response steps retain their
  native assistant row boundary while tool-call steps remain open for results.
- The production child stream projection is also exposed through the agent's
  integration-fixture entrypoint, so desktop resume tests exercise the REAL mapper
  and public receiver.
- This changes no permission selection, enables no nesting, and replaces no native
  memory processors.

Guard: the reconstructed resume proof in `assistant-subagents.md`.

### Delegated approval and resume coordinates

- Approval and suspend actions may carry a strictly validated `delegation` path
  plus the exact native leaf tool-call ID. A child notice routes to the root
  transport run and call derived from its FIRST edge.
- Matching decisions, optimistic notice state and notifications use the LEAF
  identity, so a later child pause under the same root delegation alias is a NEW
  decision. Ordinary root actions retain their existing contract.
- The host validates root ownership and ancestry; the agent checks current native
  snapshots both BEFORE and AFTER durable admission. Approval and generic resume
  use their respective native transports and must match the pending leaf's pause
  kind. No new native execution engine or workflow snapshot parser is introduced.
- The resumed parent start retains its originally observed delegation name and
  arguments, captured by the native before-tool hook and stored with the
  invocation. The approved leaf tool remains separately identified for execution
  configuration, including execute-backed web-search preservation.
- Rediscovery returns leaf payloads with canonical root transport coordinates.

Guard: the native resume parity fixture, `delegated-decision-contract.ts`, and the
desktop host tests. Admission lifetime, keyless discovery and the remaining
interaction acceptance gates live in `assistant-subagents.md`.

### Durable delegated decision recovery display

- The suspended-runs endpoint adds exact durable leaf admission state to native
  rediscovery.
- Shared approval, question and plan cards LOCK claimed, consumed or interrupted
  decisions without claiming their effects succeeded. Root/leaf admission remains
  authoritative for races; staleness alone remains advisory.
- Prepare forwarded delegated pauses from the OBSERVED LEAF before the common
  mapper checks typed UI support and approval metadata. Retain the root transport
  target; native `agent-*` wrapper names cannot replace the leaf tool shown to the
  user. Read-only persona gates remain unchanged.
- The full state, ownership and verification contract lives in
  `assistant-subagents.md`, “Durable delegated decision recovery display”.

Guard: the paired production stream-loop and native process-restart tests
(`apps/desktop/src/__tests__/assistant-server/delegated-process-restart.integration.test.ts`).

### Shared transcript action capabilities

- `AssistantActionBar` and `UserActionBar` read the public thread runtime
  `capabilities.reload` and `capabilities.edit` respectively. The vendor action
  primitives gate running and editing STATE but do not gate these capabilities.
- OMIT an unsupported action, including in delegated external-store views. Do not
  install fake `onReload` or `onEdit` handlers to enable them. Supported root
  runtimes retain their existing actions; Copy remains available independently.
- Explicit root cancellation also covers durable waiting child decisions. The
  server records nonterminal cancellation INTENT before aborting execution or
  closing a waiting turn's exact checkpoint bracket. Both native admission and
  rediscovery consult that intent; an aborted initialization failure completes as
  cancelled, using the same precedence as an aborted stream. Cancellation never
  grants or consumes an unrelated child's decision. See
  `assistant-persistence.md` for terminal publication and restart recovery.
- Explicit custom-persona questions and plans pass through the same canonical
  self-suspending-tool gate as root tools, with durable child host capability
  required even when read permission allows the tool. The child inspector sends the
  existing exact leaf decision envelope; it does not create a second root execution
  or copy approval authority into a sibling.
- Approving a delegated `submitPlan` PRESERVES root plan mode even from a forwarded
  parent notice. Only a non-delegated plan may call the root mode-exit callback;
  the existing exact child resume envelope still carries the approval.

Guard: `packages/assistant-ui/src/__tests__/assistant-conversation-panel.test.tsx`
(both capability states, using real public runtimes).

### Recursive model/tool permit ownership

- Delegated model steps and child guarded tools share the ROOT host-leg FIFO queue.
  Native delegation waits do not consume a permit.
- Each child stream has its OWN budget processor. Its authoritative cancellation
  signal comes from the ROOT stream options, because Mastra omits
  `processInputStep.abortSignal` on some native unwind passes and skips user
  `onFinish` for aborted streams.
- Stop rejects queued admission and releases model capacity; the existing native
  completion join still drains descendants before terminal publication.
- Durable reservations remain conservative when abort prevents usage settlement.

Guard: `apps/desktop/src/__tests__/assistant-server/delegated-model-permit.integration.test.ts`.

### Inactive workspace scroll geometry

- The shared `ThreadScrollFollowProvider` IGNORES zero-height geometry from hidden
  workspace tabs, in both Resize/MutationObserver measurement and scroll-event
  handling. Hiding a tab is not evidence that the reader reached the bottom:
  retain pinnedness and any pending explicit follow until visible geometry returns.
- A pinned child follows new output when shown; an unpinned child retains its
  reading position. Shared static scrolling preserves the last visible reader
  position when a kept-alive workspace tab returns from zero geometry, including
  Chromium anchor displacement.
- Child conversation panels explicitly CLEAR inherited rewind capability, and their
  rewind composer bridge leaves the root prompt handoff untouched: viewing a child
  can neither restore the parent nor consume its draft.

Guard: `packages/assistant-ui/src/__tests__/thread-scroll-follow.test.ts` (both
pinned states) and the Electron workspace-navigation test, which switches two long
children and a grandchild while retaining the parent draft.

### Background conversation ownership

- `runAssistantTurn` acquires a FIFO owner keyed by resource and ROOT THREAD before
  initialization. Waiting input is abortable without releasing its predecessor or
  starting its initializer. Independent roots do not share that queue.
- Ownership ends only after the managed session closes AND its terminal status
  write settles; completion is owned even when the caller has not awaited the
  returned promise. Desktop turn checkpoints begin inside the admitted initializer.
- Background child output enters the ordinary delegated projection.
- Resume first validates the exact durable decision and claim, then reconstructs
  the native executor through `getToolsForExecution`, resumes the ORIGINAL native
  task, and forwards its real output writer. A further question or plan pause ends
  the resume leg after native snapshot persistence, without premature parent
  inference.
- Explicit root Stop shuts native admission, cancels queued, paused and running
  work, and joins the execution and workflow writes. Tab closure is NOT a stop
  command.

Guard: `packages/assistant-service/src/__tests__/run-turn.test.ts`,
`packages/agent/src/__tests__/background-worker-stream.integration.spec.ts`,
`apps/desktop/e2e/delegated-worker-write.desktop.test.ts`.

### Background failure and stopped-pause ownership

- ONLY explicit external root cancellation cancels paused native tasks. Provider
  construction failure, watchdog failure and ordinary disposal abort the attempt
  while RETAINING durable approvals and questions.
- Construction and streaming cleanup join their background work; multiple failures
  retain all causes and diagnostics.
- A Stop after the response closes revokes the durable turn, waits for live owners,
  CAS-cancels that turn's native background tasks, and deletes their workflow
  snapshots before reporting success. Damaged decision payloads cannot prevent
  root-owned teardown. A repeated Stop completes interrupted snapshot deletion.
- Selected child Stop is a shared conversation capability SEPARATE from the root
  composer's cancellation, and a reloaded pending decision exposes the same control
  as a live child. The button waits for `/assistant/cancel-child` to join the
  selected native owners, reports errors locally, then invalidates only that
  child's live snapshot and hydrates its durable history. The default composer
  Cancel is HIDDEN when this explicit child control owns cancellation, so there is
  only one Stop. Root messaging remains usable after the child is stopped.
- **A ROOT STOP RE-READS UNDECIDED PAUSES.** After a SUCCESSFUL cancel the run
  session calls the panel's `onPausesCancelled` when the cancelled messages held a
  pause notice with no durable `decisionState` (`undecided-pause-notices.ts`). The
  panel bumps its stop generation in the data-stream runtime key beside
  `historyGeneration`, so hydration re-runs discovery and the pause returns with
  `decisionState: 'cancelled'` (a non-actionable "Turn cancelled" row) or, once its
  snapshot is deleted, not at all. Liveness is never derived from message status: a
  failed leg keeps its pauses actionable.
- Gate that remount NARROWLY, because it throws the live runtime away:
  `undecided-pause-notices.ts` looks only at the STOPPED TURN (from
  `resolveTurnAnchorMessageId`) and counts only a pause NOTHING has answered — a
  durable `decisionState`, the host's streamed `tool-approval-answered`, or the
  user's own appended decision all settle it. In-session answers carry no durable
  state, so counting them remounts the thread on the ordinary "approve a tool, keep
  going, Stop" path.
- **That renderer scope and the HOST CANCEL SCOPE MUST MOVE TOGETHER.** The gate
  may stop at the turn only because `cancelDesktopAssistantRun`
  (`apps/desktop/src/assistant-server/cancel-run.ts`) does too. Widening the host
  cancel past the turn without widening this gate would leave an earlier turn's
  cancelled card reading "Pending" with live buttons until the thread is reloaded.
- The host writes that durable state BEFORE it answers: `cancelDesktopAssistantRun`
  marks the turn's runs `cancelling` before awaiting owners.
- The live composer DRAFT SURVIVES the remount: the panel calls `onStopReread`
  immediately AFTER the bump in the same React batch, so the command reaches the
  replacement, and app-shell re-enqueues that thread's recorded draft as a
  `replace` composer command, applied once by the remounted bridge and acknowledged
  by the wrapper. Only the TEXT draft travels; attachments and other per-mount
  composer state are discarded. The same thread-scoped text survives renderer
  reload in `assistant-composer-drafts.v1` sessionStorage — Zustand hydrates only
  the draft map and creates one replacement command per nonempty draft; queued
  commands and attachments are never persisted. Sending or clearing records an
  empty draft, so it is not restored. Factory reset clears sessionStorage and
  invokes the existing composer-store reset.
- The draft carry is thread-scoped BY CONSTRUCTION: the command carries its
  `threadId`, each wrapper passes only its own thread's command, the id is captured
  at Stop time, and a stale callback whose panel has since switched threads neither
  bumps nor notifies. It is NOT the global rewind slot (`rewind-composer-store.ts`),
  which is one unkeyed slot every open thread's bridge drains.
- The panel keeps no draft state: a host wiring no `onStopReread` keeps the old
  behaviour. A failed cancel is logged and changes nothing; a failed rediscovery
  during the re-read renders the existing discovery error notice. Storage
  read/write failures are logged and shown as a destructive toast; failed writes do
  not throw through the composer effect or claim reload recovery succeeded. Session
  storage is session-scoped, not a guarantee that text stays only in memory.
- Binding cleanup and delegated persistence both own after-tool-call work; stream
  option assembly joins both hooks, including when either fails. Background resume
  supplies the original native task thread and call identity to that completion
  hook, because the leaf's mutated resume context cannot identify the parent
  dispatch.
- Active child input reuses the main composer's draft, button and Enter behaviour
  through `ActiveConversationInputProvider`, invoking the selected child's
  host-authorized transport — never root `onNew` or the root follow-up queue. A
  failed acknowledgement retains the draft and request id for an explicit repeat,
  and the provider keeps pending acknowledgement and error controls visible after a
  child becomes idle or its transport owner retires. `canSend` represents active
  transport admission SEPARATELY from that retained feedback: ordinary idle Send
  and Enter stay blocked until the acknowledgement settles or the user explicitly
  discards the draft. The host verifies owner/root, live host leg, observed native
  child identity and cancellation admission before the native child signal owner
  can accept input. Closing a child panel neither cancels nor starts execution.
- Follow-up admission is rechecked INSIDE the per-child delivery queue after native
  receipt lookup and again after signal persistence, immediately before native
  enqueue. If durable Stop revoked admission in either await, no signal is sent and
  a persisted but never-enqueued signal is removed. Both admission rejection and
  native discard preserve the original non-delivery error alongside any failed
  memory deletion; cleanup failure never overwrites the rejection or becomes
  success.
- Explicit search focus has a two-second failure boundary if the requested row
  never enters the shared renderer. A failed focus reports through the navigation
  alert and disconnects its observer; it does not crash or unmount the transcript.
  In the static tier, targets taller than the viewport align their START rather
  than centering above the visible frame; the virtual tier keeps its center
  alignment through the virtualizer. Both tiers keep their own scroll owners.

Settled: the stop-generation remount is gated to the stopped turn and to pauses
nothing answered; the renderer gate and the host cancel scope move together; the
text draft survives the remount. Evidence:
`assistant-runtime/root-stop-rereads-pauses.md`.
Guard: `packages/agent/src/__tests__/background-failure-cleanup.spec.ts`,
`background-worker-stream.integration.spec.ts`,
`apps/desktop/src/__tests__/assistant-server/delegated-waiting-cancel.integration.test.ts`,
`packages/assistant-ui/src/__tests__/undecided-pause-notices.test.ts`,
`root-stop-rediscovers-approvals.behavior.test.tsx`,
`packages/app-shell/src/__tests__/assistant-ui-panel-wrapper-stop-reread.test.tsx`,
`use-stop-reread-draft-carry.test.ts`, and the `data-stream-runtime.test.ts` case
that pins the cancelled messages.

### Cancellation at queued native file mutations

- The native workspace executor forwards `ToolExecutionContext.abortSignal` for
  write, string replacement, delete and rename.
- The operation checks BOTH this selected-child signal and the host-leg signal
  INSIDE the canonical path lock, immediately before filesystem mutation. It does
  not substitute the root signal for the child's signal.
- A mutation already started completes ordinary checkpoint and index settlement,
  preserving inspectable completed work.

Guard: the real lock-contention integration cases, which verify all four cancelled
mutations and an unaffected sibling
(`apps/desktop/src/__tests__/assistant-server/delegated-cancellation.integration.test.ts`).
This boundary does not itself claim UI selective-Stop acceptance.

### Live approval answers while the parent is parked

- A host `tool-approval-answered` is an INTERACTION BOUNDARY, like the approval
  request: the data-stream mapper flushes queued data and publishes the answer at
  the text boundary.
- Still-streaming tool arguments retain their existing deferral until the argument
  boundary; an answer must never truncate them.
- Do NOT defer answers behind a root text part. A root can wait there for
  background children while a session grant has already consumed its sibling
  approvals.

Guard: `packages/agent/src/__tests__/data-stream-approval-answered.spec.ts`,
`data-stream-text-continuity.spec.ts`, and the live three-child grant in
`background-grant-wire.integration.spec.ts`.
