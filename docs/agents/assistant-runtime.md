# Assistant Runtime: Resilience, Permissions, Hooks, Plan Mode

> Extracted from AGENTS.md (2026-07-12). Read before changing the assistant tool/stream chain, tool approval, lifecycle hooks, or plan-mode/suspension. Keep this doc updated with the code.

## ASSISTANT RESILIENCE (CRITICAL)

The assistant tool→stream chain must never freeze the thread. The renderer safety
net, the two server-side resilience layers, and the Mastra error-processor layer
below are LIVE.

1. **Renderer safety net (LIVE)** — `packages/assistant-ui/src/assistant-panel-error-boundary.tsx`
   wraps `ChatThreadUI` (inside `AssistantRuntimeProvider`, so reset preserves
   the runtime). The data-stream adapter surfaces transport errors via `onError`
   and rethrow (never swallows). A run rejected BEFORE any stream part (e.g.
   typed `memory_credential_missing` → HTTP 400) has zero message parts;
   `AssistantMessage` mounts `AssistantMessageError` (ErrorPrimitive) so that
   rejection renders as a visible error block — styling lives on the
   error-conditional `Message`, never on the always-rendered `Root` (a styled
   Root paints an empty red bar under every assistant message).
   The adapter also owns a 30-second combined watchdog for asynchronous auth
   header and request-body preparation before `fetch`. It passes an internal
   abort signal through the body-preparation seam: user Stop aborts that work
   immediately, while expiry throws the typed
   `AssistantRequestPreparationTimeoutError`, invokes `onError`, and renders
   through the same zero-part error path. A prepared run that resolves after
   Stop/expiry is terminally completed as cancelled/failed and can never become
   the active fetch body. Invalid watchdog values throw; they never disable the
   bound. Built-in local model warmup runs in a separate pre-watchdog phase
   because it can include a visible multi-file download. Stop detaches the
   assistant run from that warmup immediately; the shared renderer-host
   download may continue in the background, and its broadcast progress remains
   visible. Auth headers, request persistence, and request-body construction
   still share the bounded watchdog for every provider, including local.

   Renderer consumers read the optional desktop assistant transport through
   `getAssistantBridge()` from `@brainstrike/assistant-contract`. That contract
   owns the `window.assistant` shape, returns no capability on web/SSR, and
   reports a present malformed bridge at most once per renderer process so hot
   render/request probes cannot flood logs; do not recreate local bridge
   interfaces, unchecked double casts, or web stubs.

2. **Per-tool guard (LIVE)** —
   `packages/agent/src/tools/guard-tool-execution.ts`. `applyToolGuards` wraps
   the combined Mastra tool map in `createMastraAgentRuntime`'s tool pipeline
   (`packages/agent/src/mastra/runtime-assembly/tool-pipeline.ts`) after local
   and MCP tools are sanitized/discovered. Tool timeouts and throws resolve to structured
   `GuardedToolError` payloads; guarded timeout/failure payloads are surfaced as
   failed tool events, not successful completions. Generic exceptions retain a
   redacted `tool_failed` message because they may contain host paths or secrets.
   Trusted `ToolInputError` validation failures instead retain their bounded,
   model-correctable message as `tool_input_invalid`; only application-owned
   validation code may construct that error.
   **The guard also CANCELS the work it gave up on (BST-1594).** Winning the
   race only stops the wait, so the guard publishes a deadline `AbortSignal`
   through `packages/agent/src/tools/tool-guard-deadline.ts` and aborts it
   BEFORE resolving the `tool_timeout`. The seam is keyed by TOOL-CALL ID via
   the single `readToolCallId` reader, not by execution-context identity:
   Mastra reconstructs the context object between the guarded `execute` and the
   tool's own callback (verified at @mastra/core 1.55), so a context-identity
   WeakMap would silently read empty. Registration returns a release the guard
   runs in its `finally`. The MCP runtime client folds the deadline into its
   `tools/call` signal (never replacing `context.abortSignal`, whose identity
   carries the `retainRawMcpCallToolResult` marker), so the SDK sends
   `notifications/cancelled` instead of leaving a progress-deferred request
   dangling. A call with no tool-call id publishes nothing and keeps the
   pre-guard behaviour — the caller's signal and the SDK request bounds still
   apply. The id is PROVIDER data, so two live executions can collide on it; the
   later registration wins and the collision is LOGGED (`error`, not thrown —
   a provider-chosen id must not take a working tool call down) so a
   mis-routed cancellation is diagnosable rather than invisible. Verifier over a
   real spawned stdio child:
   `packages/agent/src/__tests__/mcp-tool-guard-cancellation.integration.spec.ts`
   with `packages/agent/test-fixtures/mcp-stdio-progress-cancellation-server.mjs`.

3. **Stream inactivity watchdog (LIVE)** —
   `packages/agent/src/stream/with-inactivity-timeout.ts` (`withInactivityTimeout`,
   `StreamStalledError`). `streamAttemptChunks` wraps the raw Mastra iterator.
   The window is PHASE-AWARE across THREE phases (BST-1408, extended for
   reasoning): `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS` governs the wait for the
   provider to produce its first OUTPUT **in each step**,
   `BRAINSTRIKE_STREAM_REASONING_GAP_MS` every gap while it is emitting
   REASONING, and `BRAINSTRIKE_STREAM_INACTIVITY_MS` every gap once it is
   demonstrably ANSWERING — see the config list below for why they must not be
   re-merged, why the phase boundary is provider output rather than "the first
   part", and why a reasoning delta is not an answer. Since
   BST-1409 a stall ends the ATTEMPT, not the turn; see ATTEMPTS VS TURNS below.
   Only an unrecoverable stall emits a visible assistant message, a terminal
   `run.failed` event, and an error finish so the renderer does not remain
   in-flight forever.
   An EMPTY MODEL RESPONSE rides the same attempt rails: a terminal `finish`
   whose reason would complete the run, on a turn the model contributed
   NOTHING to (no text/reasoning delta carrying a non-whitespace character —
   whitespace-only output renders an equally empty bubble — and no
   tool-lifecycle part, across every attempt; the deltas themselves still
   stream, since formatting whitespace between real tokens is meaningful —
   `ToolLifecycleState.sawModelContribution`, carried
   like the billing flags; resume legs initialize it true because the resumed
   tool call is model output), throws `EmptyModelResponseError` from the
   mapper's `finish` case instead of completing. Field case 2026-08-23:
   OpenRouter's `stealth/ox-alpha` route degraded into HTTP 200 streams with
   one instant zero-usage step and a clean `stop` finish; mapping that to
   `run.finished` painted an empty assistant bubble marked "success". An
   ABNORMAL finish reason is deliberately NOT re-classified — it already fails
   the run with its own truth (gate: `COMPLETED_FINISH_REASONS`, shared with
   `makeTerminalRunEvent` so the two cannot drift).
   The adjacent `withToolCallInputTimeout` wrapper applies its OWN, much wider
   `BRAINSTRIKE_TOOL_CALL_INPUT_MS` window as an absolute deadline from the
   first streamed tool-input marker to its matching input end/complete call.
   `tool-call-delta` proves transport activity and continues to render
   progress, but it never extends that deadline: a provider cannot keep a run
   alive indefinitely by dribbling incomplete JSON arguments. The two windows
   are DELIBERATELY decoupled and must not be re-merged (BST-839): the
   inactivity window asks "is the transport still delivering parts?", this one
   asks "will this call ever become executable?". Reusing the 120s inactivity
   window as the input budget false-positived on legitimate large argument
   payloads — a model writing tens of KB of file content streams argument
   deltas continuously for minutes on a slow upstream route (observed on
   OpenRouter → GLM, which took >120s to stream one file-write input while the
   transport was demonstrably healthy). The wrapper ignores non-tool stream parts before
   probing tool-call IDs, so ordinary text and reasoning deltas do not allocate
   identifier candidate arrays. Expiry uses the distinct
   `tool_call_input_streaming_timeout` terminal code and aborts before an
   incomplete call can execute. A complete call leaves this layer and remains
   governed by the ordinary per-tool execution guard.
   Every initial, approval-resume, and suspended-tool-resume stream owns an
   internal AbortController linked to the caller's signal. The watchdog rejects
   with `StreamStalledError` first, then aborts that exact controller so provider
   work cannot outlive the terminal stream without misclassifying the timeout as
   a user cancellation. Stream teardown also aborts the controller before
   disposal, preventing late provider progress/results from reaching a closed
   consumer. For the built-in local provider this signal crosses
   `LlmHostChatModel → LocalLlmHostClient → LlmHostManager`, removes the exact
   pending request, and sends the hidden renderer's cancel command.
   When watchdog expiry or caller Stop aborts a memory-backed turn, Mastra
   (>= 1.62) itself persists the cancelled run's transcript through its
   `MessageHistory` output processor — completed tool work and any partial
   text, partial tool calls filtered — without awaiting that write. The stream
   adapter's abort seam (`mastra/aborted-turn-persistence.ts`) then persists
   the user input, every assistant message with its partial text RETAINED, and
   only COMPLETED tool invocations from Mastra's live `MessageList`, appends
   `[Assistant turn aborted before completion.]` as the last text part, and
   awaits the save before runtime disposal. Incomplete tool calls are the one
   thing excluded, so Stop cannot resurrect execution on the next turn; the
   awaited save is also the join that keeps Mastra's floating write from racing
   storage close (contract and measurements in
   `docs/agents/assistant-persistence.md`). The same finalizer covers approval
   and suspended-tool resume streams, while Mastra read-only memory remains
   write-free. Ordinary completion still uses Mastra's finish writer only;
   teardown never performs a second normal write.

4. **Mastra error-processor layer (LIVE)** —
   `packages/agent/src/mastra/error-processors.ts`, wired into `new Agent` +
   `buildToolLoopOptions` (`new Agent` in `agent-runtime.ts`; the tool-loop
   options in `runtime-assembly/stream-options.ts`, moved out of
   `agent-streaming.ts` by BST-1649). Adopts three `@mastra/core`
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

Every provider/model error that reaches the stream mapper is classified at that
single choke point; no provider-specific fetch wrapper or retry-attempt
instrumentation participates. The terminal `run.failed` event carries one
namespaced `metadata.runError` object with exactly `code`, optional `message`,
`causeChain`, `httpStatus`, `providerRequestId`, and `responseHeaders`. The
extractor walks bounded `Error.cause` / AI SDK `APICallError` shapes and, when
the code is not on the explicit stable allowlist, classifies by provider
evidence: `mastra_agent_stream_provider_error` when the walk found an
`httpStatus`, `providerRequestId`, allowlisted `responseHeaders`, or an AI SDK
api-call error marker (`AI_APICallError` / `AI_RetryError` name, or
`url` + `requestBodyValues` — these exist only for calls that crossed to a
provider), and `mastra_agent_stream_local_error` when it found none — a local
runtime fault (e.g. a TypeError inside the stream chain) must never wear the
provider label (the 2026-08-03 grepSearch-projection incident), and a real
provider failure that arrived without response metadata must never wear the
local one. The extractor emits at most
four bounded cause strings. Every truncated string ends with `… [truncated]`;
truncation is never silent.

The adjacent diagnostic breadcrumb uses the provider code plus validated HTTP
status in its diagnostic code so unrelated provider failures do not collapse
into one fingerprint. Content-policy tripwires terminate visibly through their
own `mastra_agent_stream_tripwire` diagnostic and never carry the provider
`metadata.runError` envelope. Mastra 1.51's canonical tripwire shape is
`{type:'tripwire', payload:{reason,retry?,metadata?,processorId?}}`; the mapper
must read that payload rather than the obsolete top-level fixture shape. The
bounded reason becomes visible assistant text plus durable `run.failed.detail`.
The sanitized processor fields travel under `metadata.tripwire` and the same
object is logged with durable run/thread/resource/root correlation. Arbitrary
metadata is JSON-validated, passed through the shared run-event denial-list,
then reduced by value shape before either persistence or logging: only
identifier-shaped values for the explicit safe diagnostic keys plus finite
numbers, booleans, null, and Mastra's literal `[REDACTED_MATCH]` marker retain
their value. Other strings become character-count summaries. Arrays and objects
are capped at 32 items/keys and use the reserved `__brainstrikeSummary`
envelope for unambiguous type/count/omission bookkeeping; keys are capped at
128 characters. Processor ids are capped at 256 characters. The visible,
durable, and logged tripwire reason is capped at the shared 600-character
provider-error limit because policy-triggering content must not gain a larger
server-log exposure than it has in the thread.
Malformed fields are enumerated in
`metadata.tripwire.malformedFields`, and a missing/malformed reason produces an
explicit visible compatibility error rather than the generic word "tripwire".
The pre-1.51 top-level or payload `tripwireReason` reader remains an explicit
compatibility input tagged `source:'legacy-tripwire-reason'`, including hybrid
parts that also carry current sibling fields but omit `payload.reason`; remove
it only alongside a Mastra compatibility-baseline change and its paired
regression test.

Response headers are a literal, case-normalized allowlist limited to
rate-limit, `Retry-After`, and provider request-id variants. Request/response
bodies, arbitrary `data` or provider metadata, request headers, URLs,
credentials, and retry-attempt payloads never enter the event. OpenRouter's
documented canonical token-limit vocabulary is still recognized across both
mid-stream raw errors and the AI SDK pre-stream `APICallError.data` envelope,
and remains visible in the bounded user-facing failure. Other providers use the
same generic extractor and stable fallback code. `readProviderRunError` /
`isProviderRunError`, exported by `@brainstrike/agent`, are the strict consumer
boundary; downstream integrations must not hand-parse arbitrary event metadata.

The provider-error termination log is also the durable diagnostic correlation
choke point. It copies `runId`, `threadId`, and `resourceId` from
`runtimeData.memory` plus `rootId` from the server-validated
`runtimeData.boundWorkspaceRootId` into the structured logger context argument.
The run id remains the renderer-minted durable run created before dispatch;
there is no second producer. These values MUST NOT use logger bindings, ambient
async context, `mainRootId`, or another inferred-root fallback: the diagnostic
converter promotes only explicit context keys, and an absent identity stays
absent rather than being guessed.

Hosted agent loops default to 100 model steps when the user has not configured
an explicit lower limit. The Output & Limits UI must describe that finite
default truthfully; an unset override is not an unbounded or "Open" run.
Output-limit finishes are terminal failures, not successful completions:
`finishReason: length` emits `run.failed`, an error finish, and a failed durable
run outcome. The desktop data-stream session receives the selected provider,
model, and `requestedReasoningEffort` as narrow output-limit context; that field
is absent for Auto even when provider options contain a resolved wire effort.
When Kimi K3 reaches the limit at explicit `high` or `max`, the terminal copy
tells the user to retry at Low or Auto; it never changes effort, retries, or
enlarges the output window automatically. Other models and efforts retain the
generic output-limit failure. Hosted Web accepts but ignores the shared wire
field because its trust boundary owns model/generation policy server-side and
currently exposes no explicit client reasoning-effort path.

**EVERY error finish is a failed durable outcome, not just `length`.** All three
parts of that sentence apply to `finishReason: 'error'` too — the finish emitted
by `makeProviderErrorTermination`, `makeStreamStalledTermination`,
`makeToolCallInputTimeoutTermination`, and the empty-model-response termination
(all five abnormal-ending policies live in
`packages/agent/src/mastra/stream-termination.ts` since BST-986; the watchdog
MECHANISM stays in `../stream/with-*-timeout.ts`). This was NOT true until 2026-07-25:
`getAbnormalFinishMessage` returns `undefined` for `'error'` (deliberately — the
termination helpers already emit the human detail as a visible text-delta, so a
message here would double-report it), and `terminalFailureText` was only ever
assigned from that message, so an error finish fell through to
`{status: 'completed', error: null}`. A provider failure therefore emitted a
`run.failed` run event while `thread_runs` recorded the run as SUCCEEDED — the
ledger contradicted its own events, and the debug bundle's Failure summary
(which reads `thread_runs`) reported success for exactly the runs it exists to
diagnose.

`handleFinish` now sets `terminalFailureText` for an `'error'` finish without
emitting a visible message, taking the text from the preceding `run.failed`
event's label and falling back to `ERROR_FINISH_FALLBACK_TEXT`. Two paired tests
in `data-stream-session.spec.ts` keep this honest: one pins the run-event-derived
text, one pins the bare-finish fallback — either alone would pass without the
other's mechanism working. Do not "simplify" this by making
`getAbnormalFinishMessage` return a string for `'error'`; that reintroduces the
duplicate visible message. `tool-calls` and `stop` correctly remain
`completed` — they are intermediate/normal finishes, not terminals.

The durable text comes from the `run.failed` event's **`detail`**, not its
`label`: all three terminations share the generic label "Assistant run failed",
so persisting the label alone yields a correct status with no forensic value.
`makeRunFailedChunk` exists to carry that detail. It is a separate helper rather
than another optional parameter on `makeRunEventChunk` because `detail` and
`timestamp` are both `string`, so a positional slip between them would
type-check cleanly while writing a timestamp into the detail field.

**A provider-evidenced HTTP 401 is a REJECTED CREDENTIAL, and the visible
detail says so — with the remedy for THAT provider's auth type (BST-1384).**
`resolveProviderError` (`mastra-chunk-decoding.ts`) rewrites the human detail
for a run error whose `httpStatus` is 401 into "<remedy> Provider response:
<body>", where the remedy is keyed by the registry `authType` of the run's
provider (subject = registry `displayName`):
`api_key` → "rejected the API key … Update the key in Settings → Providers, or
verify it in the provider dashboard"; `oauth_subscription` → "rejected the
sign-in session … Sign in again in Settings → Providers" (its stored key is the
`oauth-subscription-no-api-key` placeholder — an api-key remedy would be a
dead end); `aws` → "rejected the AWS credentials … Update the Bedrock credential
… or refresh the AWS profile session"; `none` → "rejected the request as
unauthorized … Check the runtime’s API token under Settings → Local Runtimes"
(the optional local-runtime bearer is `providerOptions.apiToken`, not a Settings
key); unknown provider → a neutral "rejected the credential" sentence. Adding a
registry `authType` is a compile error here until it picks a remedy. Guidance
comes FIRST so the visible clamp can only ever shorten the provider's own text
(pinned by the clamp spec). 401 is the ONE wrong-credential status, mirroring
the Settings "Test connection" probe's settled classifier
(`provider-verification.ts`: 403 = authenticated-but-limited, 429 = rate-limited
VALID credential) — a run must never blame the credential for a status the
probe reports as verified. The `runError` envelope (code, `httpStatus`, the
`mastra_agent_stream_provider_error:401` log fingerprint, debug-bundle fields)
is byte-identical to before; only the detail changes. DELIBERATE asymmetry with
the probe, do not "fix" either side to match the other: the probe composes its
detail from the status alone (bodies are never echoed there), while this path
appends the provider body — it is the user's only provider-side evidence, the
pre-change visible detail WAS the raw body, and `runError.message` persists it
regardless, so nothing new is exposed (some providers do echo a partially
masked key in a 401 body, e.g. OpenAI's `Incorrect API key provided: sk-…XYZ`).
Motivating field failure (2026-08-21): OpenRouter's 401 body is literally "User
not found." for ANY unrecognized key, so a revoked stored key surfaced as an
opaque app failure and read as a regression for a day. Pinned by the
`rejected credential (HTTP 401)` block in `mastra-chunk-decoding.spec.ts`.

**Finish-reason absence is distinct from a raw unsupported value (BST-868).**
`readFinishReason` and `resolveFinishReason` preserve a missing, empty, or
non-string Mastra field as Brainstrike's internal `'absent'` sentinel. The AI
SDK's literal `'unknown'` also remains completed because that upstream value
already combines "provider omitted the field" with provider values the SDK does
not recognize; Brainstrike cannot safely reconstruct that lost distinction.
Only a non-empty raw value outside the SDK/Brainstrike union becomes the
internal `'unrecognized'` sentinel, emits `run.failed`, surfaces the explicit
"unrecognized finish reason" message, and persists `thread_runs` as failed.
Before data-stream serialization, internal `absent` becomes assistant-stream
0.3.37's completed wire value (behavior verified at 0.3.25, unchanged by the
0.3.34 and 0.3.37 lockstep bumps — `unknown` is still in the completed-status
union at 0.3.37) `unknown`; internal `unrecognized` becomes the
terminal wire value `error`. Intermediate steps start as `absent`, never as the
SDK-owned `unknown`. Keep these internal sentinels out of the legacy data-stream
protocol and never infer provider failure from the AI SDK `unknown` value.

**Raw/model tool-output split (LIVE):**
`createMastraAgentRuntime` composes tools in this order (the stage sequence
lives in `runtime-assembly/tool-pipeline.ts`; OpenRouter billed-cost/usage
extraction lives in `runtime-assembly/usage-metering.ts`):
`sanitize/discover → timeout guard → lifecycle hooks → plan/permission/suspend
gates → provider-native swap → artifact settlement → model-output projection →
Agent`. The still-unregistered MCP Apps path captures its admission capability
immediately after the plan/permission/suspend gates. Admission returns an
opaque one-use executor bound to the exact post-gate tool entry and exact
server/tool identity; the Apps preparer has no separate invocation, guard, or
hook injection seam. The host authority creates a generation-bound preparation
id before invoking the preparer and requires its paired release callback to
settle before a denied or cancelled call completes, including a cancelled
preparation response. It receives no separate policy, plan, enabled-tool, or
storage decision: a tool omitted by any ordinary gate is absent and fails
visibly. The authority-owned per-call abort signal marks that bound execution
for raw MCP result retention, so the transport adapter and temporary preview
wrapper preserve the complete `CallToolResult` before artifact and model
projection. Canonical `isError: true` server results remain successful JSON-RPC
results with exact content and metadata; thrown transport/execution failures
alone become ordinary guarded errors. An admitted App call therefore uses the ordinary guard,
hooks, and execution-duration telemetry exactly once. Replaying the bound
executor fails visibly before another tool execution can start.

The final
projection uses Mastra's native `toModelOutput`, so the mapping observes the
post-hook execution result without replacing it. A discriminated internal
carrier takes PostToolUse context to `toModelOutput`; Mastra's official
display/transcript transforms unwrap it so live application consumers and the
durable transcript retain the exact domain result. Generated/default
projections use the unchanged 2000-token / 8000-serialized-character ceiling.
Purpose-built domain projectors MUST self-fit complete output within the active
run's context-window-scaled default (500..3000 tokens / 2000..12000
characters; 1500 / 6000 at the 128k anchor) and fail loudly on overflow; the
central seam never truncates an
opaque page after its continuation was computed. Guarded failures bypass custom
projectors. Successful PostToolUse metadata is stripped before projection
(one explicit internal envelope preserves every original result shape),
then its context is appended centrally without reordering content and fitted
into the remaining final 8000-character envelope. Only hook context may be
truncated at that composition stage. The `skill` activation exception keeps
its complete 6000-token instruction budget and adds a dedicated bounded hook
allowance plus structural reserve instead of rebinding to the generic
1500-token domain budget. Persona agents receive the same projections before
their independent permission gate. A reused parent-owned tool is invoked under
a save/restore active-budget context for the synchronous custom-projector call,
so a pinned child producer fits to the child's resolved tier rather than the
construction-time parent tier; every desktop custom projector is synchronous,
and the context is restored before any returned Promise can be observed.
Mastra 1.51's documented CoreTool
projection callback receives the raw execute output. Brainstrike never
shape-guesses `{toolCallId,input,output}` as adapter metadata because that exact
object is valid domain evidence; a future direct AI SDK adapter belongs at a
separately typed boundary.
Mastra may replay a stored `providerMetadata.mastra.modelOutput` through the
same tool projector while preparing a later same-run provider step. A
purpose-built projector that emits a recognizable canonical envelope must
therefore accept its own envelope idempotently. Stored/settled replay validates
the default domain portion against the fixed ceiling tier rather than a smaller
current-run budget; fresh projections use the per-run resolved tier. It must
validate the applicable domain budget and never reinterpret arbitrary lookalike
domain objects. `grepSearch` pins this
with the exact `{ type: 'text', value: 'grep …' }` replay that previously
terminated a hosted Claude verification run.

**Known tradeoff (BST-1206 review): replay's hook-context composition also
uses the ceiling tier, not the resolved one — documented, not yet fixed.**
When a settled/replayed projection carries `hookContext`, the domain payload
(validated above, accepted at the ceiling tier — up to 12,000 chars) is
combined with that hook context via `composeHookContextWithProjection`, which
ALSO receives the ceiling-tier budget object on replay, not the current run's
resolved one. In principle this could be tightened — accept the stored domain
projection at the ceiling tier (unchanged, for the reasons above) while fitting
any newly-composed hook context against the resolved budget, truncating the
hook context (never the domain payload) when it does not fit. In practice this
composition step's *total* envelope check is `totalSerializedChars`
(`MAX_MODEL_TOOL_RESULT_CHAR_BUDGET`, the fixed 8000-character raw-output
ceiling mentioned above) — a THIRD budget axis, deliberately left fixed and out
of BST-1206's scope (only the domain and transport budgets scale; see
`tool-output-limits.ts`'s anchor/floor/ceiling formula). Because that field is
identical on both the ceiling-tier and per-run-resolved `ModelProjectionBudget`
objects today, passing one or the other to `composeHookContextWithProjection`
on replay currently has NO differential effect — making the fix meaningful
requires also scaling `totalSerializedChars`/`totalTokens`, which would expand
BST-1206's scope reactively during PR stabilization instead of as a deliberate,
separately-tested change. Net effect: a projection settled during a huge-window
run (domain payload sized up to the 12,000-char ceiling) that replays with hook
context on a small-window run (e.g. an 8192-token local model) can compose a
combined envelope sized for the ORIGINAL run's budget, not the replaying run's
— the same 12,000-char-vs-3000-token-window mismatch the domain-only case
already accepts by design, just one layer further out. BST-1219's paired FRESH-
path work has now landed: desktop projector producers receive the resolved
per-run domain budget and the downstream fresh assertion uses that same
unfloored value. Replay budget context was deliberately not widened. The
remaining deferred tradeoff is therefore narrower and unchanged: only replay-
time hook-context composition against the fixed `totalSerializedChars` /
`totalTokens` axis described above.

`ModelOutputProjectionObserver` receives `(toolName, output)` at this final
projection seam. `RunTokenDiagnostics` uses it to retain one privacy-safe
per-call sample (tool id, actual serialized model-facing character count, and
booleans only), then emits one internal `tool-call-telemetry` chunk before the
terminal finish. Desktop consumes that chunk through the run-persistence
capability and writes migration 083's durable ledger; a run without that host
capability discards the internal chunk before renderer serialization. Generic
truncation is recognized only from final `{type:'json', value:{truncated:true}}`
projections. `grepSearch` and `globWorkspace` attach zero-match, request-offset,
and typed truncation metadata to their raw result in a private WeakMap before
projection, so no projected-text parsing or user search data enters telemetry.

At run end, the same diagnostics instance may emit one internal
`token-estimate-calibration` chunk for a completed run. The numerator,
`estimatedPromptTokens`, is the chars/4 backstop over model-visible
tool-output projections plus tool definitions, each counted once. The
denominator is `finalStepPromptTokens`, the single most recent step's
prompt-token count; via Mastra's resend behavior that prompt already contains
every prior tool output exactly once, unlike the cross-step accumulated billing
total. Both figures therefore use the same final-prompt-content basis.
Conversation/system-prompt text outside tool outputs and definitions is excluded
from both. The desktop run-persistence capability consumes the chunk before
renderer serialization; incomplete runs, failed measurement, or missing
model/provider attribution emit no sample.

The chunk also carries `promptBreakdownBaselineTokens` when a run-start
`promptBreakdown` exists: `systemInstructionsTokens + (taskListTokens ?? 0) +
(toolDefinitionsTokens ?? 0)`. Desktop persists it as migration 091's nullable
`prompt_baseline_tokens`. **BST-1232 review: eligibility for this chunk is no
longer "at least one measured tool-output projection".** That gate would have
meant an ordinary tool-free chat turn — and, before the companion fix below,
EVERY resume leg (tool-approval and suspended-tool) — never persisted a
baseline at all, silently starving the next turn's trigger of the one value
this migration exists to give it. The chunk is now emitted whenever there is
SOMETHING new to report: a measured tool-output projection (`
modelVisibleProjectionCount > 0`), a `promptBreakdown` to source a baseline
from, or both; it is skipped only when NEITHER is available. Both resume
iterators (`createToolApprovalIteratorFromRuntime`,
`createToolResumeIteratorFromRuntime` in `agent-streaming.ts`) now compute
`promptBreakdown` from the resumed runtime's own `instructionBreakdown` +
`toolDefinitionContextBreakdown()` (with `messages: []` — a resume sends no
new messages) so their calibration row carries the same baseline the initial
turn would have reported, since prompt composition is unchanged across a
resume. A zero-projection row can therefore still have a positive
`estimatedPromptTokens` (from the static tool-definition catalog alone) even
though nothing was actually measured from a live tool output; the
`estimator-calibration.sql` lens, not the writer, is where the
`model_visible_projection_count > 0` RATIO-eligibility gate now lives (its
WHERE clause requires it explicitly — `estimated_prompt_tokens > 0` alone is
no longer sufficient to exclude these rows).

Pre-request conversation compaction runs before the next runtime/prompt is
assembled, so it reads the latest thread-scoped calibration row **whose
`prompt_baseline_tokens` is NOT NULL** (belt-and-braces alongside the write-side
fix above: a future leg that forgets to thread `promptBreakdown` cannot shadow
an earlier real baseline with a later NULL-baseline row) and triggers on
`previousPromptBaseline + conversationMessageTokens >= 0.90 * inputBudget`. The
deterministic message-side target is
`max(1024, 0.70 * inputBudget - previousPromptBaseline)`; the 1024-token floor
preserves a minimally useful recent exchange/tool-result window when message
deletion alone cannot reach the nominal total target.

The lookup always runs CONCURRENTLY with the unprojected-message load
(`Promise.all`), never sequenced after it: neither depends on the other's
result, so sequencing them would add pure latency for no benefit, and
concurrency also means the lookup's DB round trip still fires even if message
loading itself later throws (e.g. a missing trusted compaction-overlay
lookup) — `agent-stream-init-and-memory.integration.test.ts` pins this by
counting `getDatabase` calls; an earlier "load messages first, then decide
whether to bother with the lookup" ordering silently regressed it in review.
A non-negative baseline only pushes the total UP, never pulls it back under,
so once the conversation-message share alone already clears the 90% trigger
the (already-fetched, free) baseline cannot change that decision and recency
pruning starts immediately. Either way, a missing row (no calibration yet — expected on a
thread's first turn) uses baseline 0 (the pre-091 behavior) and stays at
`debug` under code `conversation_compaction_baseline_unavailable`; a failed
DB read or a corrupt/out-of-range persisted value ALSO falls back to 0 but is
now `warn`-level under its own distinct code
(`conversation_compaction_baseline_lookup_failed` /
`conversation_compaction_baseline_corrupt` respectively) — the earlier
single-debug-code version made either failure silently and invisibly revert
the trigger to its pre-fix behavior for every later turn on that thread.

If the baseline alone is at or above the 70% target — realistic on small
context windows with a large tool catalog — recency pruning and the
deterministic path toward the 1024-token floor STILL run: pruning is entirely
message-side (it reclaims tool-output bloat) and is completely unaffected by
a baseline that message deletion structurally cannot reduce, so skipping it
would just let the thread grow until the provider throws and overflow
recovery performs the identical pruning one wasted round trip later. Only the
AGENTIC summarizer is skipped, under warn code
`conversation_compaction_baseline_exceeds_target` — latched to once per
thread for the process lifetime so a thread parked in this steady state does
not repeat the warning every turn — because it chases the same message-side
reclaim target that a dominant baseline makes structurally unreachable.
Provider context-overflow recovery (`createContextOverflowRecovery`) is a
separate path unaffected by any of the above and stays enabled.

When a trusted host supplies `toolOutputArtifactStore`, the final native/MCP
tool map is settlement-wrapped after policy/provider transforms and before
`toModelOutput`. Non-media results above 12,000 UTF-8 bytes are fully retained
before an artifact envelope can reach display/transcript.
MCP settlement also consults the generic model projector before retaining an
otherwise-inline result (BST-1655). A 9 KB issue can fit the 12 KB artifact
ceiling yet exceed the final 8 KB model envelope. The projection owner compares
its actual bounded value with complete source text, including JSON escaping and
the domain reserve used with PostToolUse context; any loss requires settlement.
This predicate applies only to MCP tools from the eligible runtime map. Task
status projections and inline media keep their dedicated contracts. No second
size constant approximates the model projection. The complete raw output is
stored before publishing a recovery page; storage failures still fail visibly.
Runtime settlement requires an explicit reader resolver. It resolves exactly
one eligible reader from the canonical name map before storage; zero or
multiple matches fail visibly without writing an artifact. Recovery pages use
the exact callable id. MCP Apps retain their complete marker,
origin, and ordinary result in display/transcript output so sandbox mounting
and hydration remain valid; only the ordinary result is serialized for model
artifact recovery. Apps media takes the existing inline media path. The eligible
artifact reader remains on the core discovery surface, so recovery never
requires a search call. The reader's own model projector receives
the sanitized tool through the central projection wrapper's receiver and fits
continuation guidance with that same id. Standalone page helpers retain their canonical-name default.
A trusted per-tool canonical-name map may lower the inline threshold by
serialized characters when a complete domain projection has a tighter budget.
`brainstrike.webExtract` uses the smaller of 2400 characters and the active
run's resolved domain-projection character budget: smaller extracts project
every source byte and exact URL directly; larger extracts settle completely
and continue through the artifact reader instead of clipping or re-fetching.
If a stricter-threshold artifact still fits one model page, settlement keeps
the rich raw display and publishes a complete page without an EOF cursor. If
no durable store exists, an oversized web extract produces an explicit
model-output-unavailable projection; it never silently clips source text.
A module-private WeakMap carrier keeps the original in-process result and authenticated
PostToolUse context away from public persistence. Once settlement succeeds,
model projection bypasses any domain projector for the original result and
projects a bounded initial-page view instead. That model view omits the
redundant artifact reference and carries one concrete reader/cursor action,
recomputing its cursor if the preview must shrink to fit. Display and transcript
keep the full envelope only when continuation is required. Public-shape guessing is forbidden. Storage failure, a
missing tool-call id, incoherent returned
metadata, or output above the explicit 16 MiB settlement cap throws visibly.
The `skill` tool is excluded because its instruction payload cannot be paged.
MCP image/audio `content` arrays are also excluded: they must stay inline so
display/transcript can render media, and they retain the explicit aggregate
media plus non-media metadata ceilings with or without durable settlement.
Desktop builds the paired `brainstrike.readToolOutputArtifact` capability only
when server-owned resource and thread scope plus the database bridge exist.
The registered model tool accepts the opaque continuation cursor plus bounded
page/search options, never artifact metadata or ownership ids. Plain calls
return the raw bounded page; `pattern` calls search the same validated slice and
project compact grep-style matching lines. Any unscanned source or
projection-omitted match carries an advancing cursor; missing continuation
guidance fails the run. Artifact-mint hints advertise whole-result delegation
only when persona assembly registered an artifact-reader-capable `agent-*` tool
for that run. No capability means no registered tool; Desktop never installs a
stub or an unscoped fallback.

Without that trusted host capability, MCP text/JSON keeps the temporary inline
behavior and is bounded inside `execute()` before inline persistence. The UI
data-stream bound is a separate transport backstop, not the model-context
boundary.

Mastra 1.51's TokenLimiter counts raw DB tool results before applying
`toModelOutput`. `ProjectionAwareTokenLimiter` temporarily swaps each completed
result to its stored model projection for counting, replaces media bodies with
markers, delegates to Mastra, and restores raw property descriptors in
`finally`. `mastra-tool-execution.integration.spec.ts` must keep proving the
configured-limit path reaches the next provider step and preserves MCP media;
`mastra-memory-persistence.integration.spec.ts` must keep proving a later turn
replays the stored projection rather than the raw sentinel.

Hosted runs also install `ProjectionSafeToolCallFilter`, a provider-boundary
equivalent of Mastra 1.51's `ToolCallFilter({ preserveModelOutput: true })`.
`processInputStep` computes eligibility without returning messages because
Mastra applies that hook's result back to the live `MessageList`.
`processLLMRequest` performs the transient rewrite after stored model
projections are resolved. It replaces only old, completed, successful native
read/search/retrieval calls that have a serializable non-multimodal stored
projection. The newest eligible read/search/retrieval step stays verbatim, as do missing
projections, errors, commands, verification, tasks, discovery, skills,
approvals, incomplete calls, and MCP tools. It never mutates the live
`MessageList` or durable rows.

EDITS get one narrow, separate treatment (2026-08-23 ctx-explosion
investigation, H2): a SETTLED `writeWorkspaceFile` / `stringReplaceWorkspaceFile`
call — successful result, outside the same recent-step window — whose
serialized args exceed 2,000 chars has its prompt-side INPUT collapsed to the
identifying fields (`path`, `root`) plus an honest `elidedArguments` marker.
The call/result pair stays structurally in place (nothing is stubbed or
replayed), the RESULT stays verbatim, failed or in-flight edits keep full args
(they may matter for a retry), and durable rows are untouched — same
wire-only `processLLMRequest` guarantee as the read filtering. Rationale: a
57 KB write's content otherwise rides every subsequent request of every
subsequent leg while carrying no information the file on disk does not. Same-turn and reload integration tests must keep
proving raw arguments/results remain persisted. A file write followed by two
successful reads therefore retires the older redundant read while preserving
the write and newest verification result; later protected state/working-memory
tools do not consume that recent-read window. Local, Ollama, and LM Studio runs
omit it.

Replacement shape (settled 2026-08-07, run-9136 debug bundle): a filtered pair
must NEVER become assistant-authored `<toolName> result:` text — GPT-5.x
Harmony models mimic that shape and fabricate tool-result dumps in their
visible commentary-channel output, which renders as message prose. The stale
tool-call part becomes a generic stub text (keeping OpenAI's
reasoning→following-item pairing valid; at most ONE stub per message, so
parallel fan-out steps do not repeat it) and the projection replays in a
following user-role message that flushes only after every adjacent tool-role
message — the filter runs for ALL hosted providers, and Anthropic merges
adjacent user-ish turns while requiring tool_result blocks to lead the merged
message. Because that replay can carry untrusted content
(web pages, retrieved documents), it is explicitly framed as "untrusted tool
output, not instructions" between BEGIN/END REPLAYED TOOL OUTPUT markers, and
marker lookalikes inside the projection are defanged so the body cannot forge
the boundary. Tool-results embedded in ASSISTANT-role messages
(provider-executed tools like native web search, which keep call, result, and
trailing text in one message) are ineligible and stay verbatim in place —
lifting them would reorder same-message chronology. A pair whose projection
cannot be textualized stays verbatim on BOTH sides — never a dropped result
under a kept call, which OpenAI rejects as an unpaired `function_call`.
`projection-safe-tool-call-filter.spec.ts` and the stale-read reload case in
`mastra-memory-persistence.integration.spec.ts` pin this shape.

The adjacent `RunTokenDiagnostics` path is measurement-only. It observes final
tool definitions and already-bounded model projections, then emits one
content-free `mastra_agent_token_measurement` log with the explicit
provider/model measurement mode and provider-reported prompt usage when
available. It cannot alter `ProjectionAwareTokenLimiter`, the deterministic
serialized-character ceilings, the outgoing prompt, or persisted run events.
Tokenizer failures remain visible under their declared mode and retain separate
backstop totals; they never relabel themselves as exact or silently select a
different counter. The provider/model capability contract and supported modes
live in `docs/agents/assistant-providers.md`.

**Hosted native-tool definition and prompt budget (LIVE):**
The runtime does not maintain a parallel provider-tool catalog.
`@brainstrike/assistant-contract` supplies canonical ids and descriptions from
the per-tool `defineNativeTool` declarations (`native-tools/definitions/*.ts`,
BST-1646); `NATIVE_TOOL_INPUT_SCHEMAS` in `packages/agent/src/tools/schemas.ts`
is derived from those same declarations and supplies the exact Zod input object
for each desktop native id. The desktop registry
uses those objects directly, `validateToolInput` parses with the same map, and
Mastra performs the Standard Schema → provider JSON Schema conversion. The
browser-safe `NATIVE_TOOL_SCHEMAS` registry is lossy display metadata derived
from those same Zod objects (`toToolSchemaDisplay`, BST-1646) and MUST NOT
enter execution, validation, or provider registration.

The hosted surface is guarded at both sides of Mastra's conversion boundary.
The authored full-registry red baseline must fit within 7,900 `o200k_base`
tokens. The live actual Mastra/OpenRouter core surface and resolved instructions
must fit within 5,000 tokens, materially below the retired 11,500-token eager
boundary. Live hosted first requests add Mastra's `search_tools` and `load_tool` controls;
deferred post-gate definitions are appended on later steps.
The production-equivalent fixture enables a representative workspace skill so
both numbers include the three default skill tools, conditional skills
guidance, and first-turn `SkillsProcessor` metadata; a registry measured
without `workspaceSkills` is an undercount.
Mastra 1.51 currently expands optional fields for the routed `openai/*` model;
the authored guard is therefore not evidence for the provider payload. The
regression constructs the real desktop registry and real hosted runtime
(`apps/desktop/src/__tests__/assistant-server/native-tool-prompt-budget.test.ts`);
an isolated description, schema estimate, or hand-built provider payload is
not sufficient evidence.

The per-call input-processor order is SkillsProcessor → ToolSearchProcessor →
ProjectionSafeToolCallFilter → ToolProjectionRewriteProcessor → ProviderHistoryCompat →
OpenAIToolSearchHistoryCompat → OpenAIDuplicateItemCompat →
ProjectionAwareTokenLimiter. The OpenAI-only compatibility seams are absent for
every other provider; token limiting is always last. OpenAIDuplicateItemCompat
(BST-1095) canonicalizes duplicated OpenAI item references at the transient
boundary — Mastra's sealed-boundary re-key can double-persist one assistant
response under two message ids, and a prompt carrying both copies serializes
two input items per `rs_`/`fc_`/`call_` id, which OpenAI rejects with
"Duplicate item found". Canonicalization must not trade that 400 for another:
reasoning/text ids keep their newest occurrence; a tool call and its output
(tool-role for client tools, assistant-role for provider-executed tools like
native web search) are kept as the newest COMPLETE pair so no
`function_call_output` survives without a preceding call; reasoning left
trailing in an edited message is swept ("reasoning without its required
following item" is also a 400); emptied messages are removed. Within-message
repeats are untouched (multi-summary reasoning merges provider-side) and
durable history is never mutated. It runs after the other compat rewrites so
it sees the item references they produce. Initial streams, approval resumes, and suspending-tool resumes reuse the
same discovery and history-filter processor instances so same-process approval
executors remain available while persisted discovery results provide restart
reconstruction.

Default instructions should state cross-tool routing and non-negotiable
invariants once, while canonical descriptions/schemas carry per-tool mechanics.
See `docs/agents/workspace-context.md` for the instruction invariants that
cannot be compacted away.

> **LIVE validation requirement:** A prior attempt wired the guard + watchdog into
> the live path and BROKE real Mastra tool calling (hosted-provider tools silently
> stopped executing) while mocked tests stayed green. Future changes to these
> layers MUST preserve coverage that runs the actual Mastra agent loop end to end
> with real tool `execute`, not only mocked stream parts. The current proofs live
> in `packages/agent/src/__tests__/mastra-tool-execution.integration.spec.ts` and
> `mastra-error-processors.spec.ts` (retry, prefill recovery, TokenLimiter
> clobber-guard regression, pinned `maxProcessorRetries`, bounded-terminal).

## MCP TASK STATUS AND RESTART CONTROLS (BST-1565)

`McpTaskStatusCard` is a controlled, browser-safe status surface, not a tool
result card. It receives the bounded `McpTaskPresentation` contract and one
injected controller port; it neither imports the agent runtime nor reconstructs
Tasks authority in the renderer. Recover and Cancel submit the complete opaque
handle unchanged. The agent-owned controller revalidates protocol, capability,
server/resource, principal, and authority epoch before and after the existing
repository/lifecycle/interaction authority runs.

The card remains truthful while actions are pending: recovery does not switch
to live and cancellation does not show `cancelled` until the controller returns
an observed state. Actions are single-flight by complete opaque authority
handle, so newer observations for the same handle stay pending while an
authority-epoch or other handle replacement fences the stale outcome. Stable
diagnostics render as a
focused alert; successful actions move focus to the live status summary, which
is a polite status region. The identity is never rendered, the transition list
is already bounded by the contract, and unexpected authority errors use fixed
copy rather than exposing paths or credentials. The component is exported for
opt-in composition only; host registration and advertisement of Tasks are
governed by `docs/agents/assistant-providers.md`.

### TOOL-PATH WIRING (BST-1566)

The agent runtime's MCP tool path is production-wired for a created task
(`packages/agent/src/mastra/mcp-task-tool-result.ts`, consumed by
`executeMcpTool` in `mcp-runtime-client.ts`):

- **Capability, not environment.** `MastraAgentRuntimeOptions.mcpTaskTracking?:
  McpTaskTrackingCapability` (the port in `packages/agent/src/mcp/task-tracking.ts`)
  is threaded exactly like `toolOutputArtifactStore`: runtime option →
  `composeRuntimeToolMap` → `createMcpRuntimeClient({ mcpTaskTracking,
  toolTimeoutMs })`, and it survives `toAiSdkStyleStream`'s `optionsOverride`
  Pick. Only a trusted host composes it; web and host-less runs leave it absent
  and every MCP call stays synchronous.
- **Detection covers both wire shapes.** A `tools/call` answer is a created task
  when it is the bare `resultType: 'task'` result OR the client extension
  registry's neutral envelope `{ [REGISTERED_EXTENSION_RESULT_KEY]: task,
  content: [], resultType: 'complete' }` (`readRegisteredExtensionResult` is the
  inverse of `rewriteIncomingMessage`; never re-implement the unwrap). Both are
  parsed with `parseMcpCreateTaskResult` — a malformed task throws, it is never
  coerced into an ordinary result. Detection runs before the raw-result
  retention and `isError` branches: a task has no content to retain.
- **NO SILENT FALLBACK.** A task result on a runtime without `mcpTaskTracking`
  throws `MCP tool "<server>.<tool>" returned a task but this host has no task
  tracking capability`. The task is never dropped, never returned as raw state.
- **Identity.** `track()` receives `configuredServerId = server.name`, which IS
  the host authority snapshot's `configuredServerId` (mapped verbatim in
  `createMcpRuntimeClient`) and therefore matches `McpTaskHandle.serverId` on
  the desktop host; `toolName` is the unprefixed MCP tool name.
- **App-originated calls return the wire task.** When the Apps admission
  executor marked the call for raw retention (`shouldRetainRawMcpCallToolResult`),
  the tool still hands the task to `track()` so the host owns it, then returns
  the canonical `CreateTaskResult` unchanged WITHOUT awaiting settlement: the
  MCP App client expects that result and its frame bridge aborts inbound
  requests after 10 s, far under the settlement wait. This branch runs before
  the ordinary settlement branch; a tracking-less host still throws.
- **Bounded settlement.** After `track()` the tool awaits
  `awaitSettlement(handle, { timeoutMs, signal })` with
  `timeoutMs = min(45_000, floor(0.75 × toolTimeoutMs))`
  (`MCP_TASK_SETTLEMENT_WAIT_MS`, `resolveMcpTaskSettlementTimeoutMs`). The
  guard's ceiling (`BRAINSTRIKE_TOOL_TIMEOUT_MS`, default 60s) is not observable
  from inside `execute`, so the wait is capped under the ceiling that
  `applyToolGuards` enforces; the remaining quarter covers the `tools/call`
  round trip and `track()` so the guard can never report a timed-out tool for a
  task that is tracked and healthy. A ceiling too small to hold any wait throws
  at runtime construction. Timeout is not an error: the capability resolves
  `{ settled: false, reason: 'timeout', task }` and the tool returns the live
  presentation the status card keeps updating.
- **Persisted marker vs model projection.** The tool's RAW domain result (what
  persists on the tool invocation, and what the live display/transcript
  transforms pass through unchanged) is
  `createMcpTaskToolInvocationResult(presentation)` from
  `@brainstrike/assistant-contract` (`{ kind: 'mcp-task', task }`). The
  MODEL-visible output goes through the existing `toModelOutput` seam:
  tracking-capable runtimes give every MCP tool `projectMcpTaskToolModelOutput`,
  which returns `{ type: 'json', value: projectMcpTaskForContext(task) }` for the
  marker and `undefined` for every other result (the pipeline then applies its
  generic projection, so non-task MCP results are unchanged). The projection
  never carries the control handle or raw task state and is bounded by
  `MCP_TASK_CONTEXT_MAX_BYTES` (2,048), tightened to the run's
  `domainModelResultCharBudget` via `getActiveToolResultBudget()` so the
  smallest scaled budget cannot trip the domain-projection RangeError.

Tests: `packages/agent/src/__tests__/mcp-task-tool-result.spec.ts` (detection
both shapes, malformed rejection, timeout resolution, absent-capability throw,
settled/timeout flows, projection bound at the smallest budget) and the "MCP
task results" block in `mcp-runtime-client.spec.ts` (end-to-end through the
runtime tool, `track` identity, persisted marker, model projection).

### TOOL-PATH WIRING (BST-1572)

The ordinary model-initiated MCP tool path now persists the renderer-owned Apps
mount marker when the executing tool definition advertises
`_meta.ui.resourceUri` (`packages/agent/src/mastra/mcp-app-tool-result.ts`,
consumed by `executeMcpTool` in `mcp-runtime-client.ts`):

- **Strict definition detection.** A definition with no own `_meta.ui` member
  is an ordinary MCP tool and is unchanged. A present `_meta.ui` is parsed by
  `parseMcpAppToolMeta` from `@brainstrike/mcp-app-host` before `tools/call`;
  invalid keys, shapes, visibility, size, or a non-`ui://` resource URI throw
  visibly before the remote tool can execute. A valid `ui` object without
  `resourceUri` remains an ordinary result.
- **Ordinary calls only.** The Apps admission executor marks its authority-owned
  abort signal with `retainRawMcpCallToolResult`; that early return remains
  before Apps marker construction and preserves the complete `CallToolResult`
  for preview/authority execution. The marker is built only on the ordinary
  model-initiated path.
- **Ordering and ordinary result.** Created Tasks first settle to their existing
  task marker (except app-originated raw-retention calls, which return the
  CreateTaskResult after `track()` — see the BST-1566 section). For non-task calls the raw successful `CallToolResult` is kept
  when there is no `structuredContent` or when media is present; otherwise the
  existing `structuredContent` value is used. Canonical `isError: true` throws
  before any Apps marker exists. The selected value is exactly the result this
  path returned before BST-1572.
- **Persisted marker and identity.** `createMcpAppToolResult` calls
  `createMcpAppToolInvocationResult` with `serverId = server.name` (the
  configured server id), the unprefixed MCP `toolName`, the strict `ui://`
  `resourceUri`, and `mimeType: 'text/html;profile=mcp-app'`. The raw domain
  result is `{ kind: 'mcp-app', app: { mimeType, resourceUri, serverId,
  toolName }, result: ordinaryResult }`. Existing hook display/transcript
  transforms and bounded artifact settlement preserve this small raw domain
  marker exactly as they do the sibling Tasks marker.
- **Model projection.** Apps metadata never reaches the model.
  `projectMcpAppOrTaskToolModelOutput` composes the Tasks projector with the
  Apps marker reader. The central `toModelOutput` seam unwraps `result` before
  the custom projector and before generic fallback, so a nested task keeps its
  bounded task projection and every other Apps result receives exactly the
  generic projection its `ordinaryResult` would have received without the
  marker. Definitions with neither Tasks capability nor `_meta.ui` retain no
  custom projector.

Tests: the "MCP Apps tool results" block in
`packages/agent/src/__tests__/mcp-runtime-client.spec.ts` pins both ordinary
result shapes, strict metadata failure, unchanged non-Apps tools, `isError`
ordering, persisted marker identity, and marker-free model projection;
`mcp-app-tool-call.spec.ts` pins the unchanged admission executor path.

### ATTEMPTS VS TURNS (BST-1409)

A turn may span several provider ATTEMPTS. `runTurnAttempts` (`turn-attempts.ts`,
moved out of `agent-streaming.ts` by BST-1649) owns the turn; `streamAttemptChunks`
(still in `agent-streaming.ts`) owns one attempt and now PROPAGATES a
watchdog error instead of deciding the turn's fate. `runtime.dispose()` moved to
the turn's `finally` and has exactly one owner across all three legs — the
runtime is reusable, since `dispose()` only shuts down mastra + the MCP client.

- **A stall ends the attempt.** The turn continues with a fresh
  `agent.stream` carrying the original request plus everything the stalled
  attempt produced, read from Mastra's in-memory `messageList` on the stream
  result. Bounded by `BRAINSTRIKE_STREAM_STALL_ATTEMPTS` (default 2).
- **Why the message list, not memory.** On core 1.59 an aborted stream
  persisted NOTHING to `mastra_messages` — measured, not assumed (BST-1415):
  not the completed tool calls, not even the user's message. Mastra >= 1.62
  (BST-1667) changed that: its `MessageHistory` output processor persists the
  aborted attempt's transcript, partial tool calls filtered, without awaiting
  it — so the continuation is no longer the turn's only writer. The message
  list stays the recovery source because it is complete and synchronous, and
  re-sending the original request in a continuation stays non-duplicative
  because Mastra's `saveMessages` upserts by message id; the recovered-stall
  proof asserts exactly one user row and no abort marker.
- **`readProducedMessages()` returns `undefined` vs `[]` and the difference is
  SAFETY-CRITICAL.** `[]` means the attempt genuinely produced nothing (a stall
  before the first step), so continuing from the request alone re-runs nothing.
  `undefined` means we could not tell, and continuing would re-send the request
  as if the turn never started — every completed tool would execute a second
  time. A turn that cannot prove what it produced does NOT resume.
  An empty list is additionally CORROBORATED against what the attempt was
  observed to do: `terminalToolCallStates` gains an entry per completed tool
  call, so `produced.length === 0` while tools demonstrably ran is a
  contradiction and refuses recovery too. That trust would otherwise rest
  entirely on the reader, and being wrong reaches the re-execution outcome
  through the branch treated as safe.
- **Five refusals, all terminal:** user cancel (a decision, not a transport
  fault), budget exhausted, unreadable produced messages, produced messages that
  contradict completed tools, and `ToolCallInputStreamingTimeoutError` (a
  generation fault — re-sending the same prompt has no reason to change it).
  Recovery covers `StreamStalledError` only.
- **Recovery is never silent.** Each stall emits `run.stalled` and each
  continuation `run.resumed`, both carrying attempt/budget and the stall's full
  BST-1408 breadcrumb (phase, parts-seen, `lastPartType`). A RECOVERED stall is
  followed by no `run.failed`, so its `run.stalled` is the only durable record
  of it and must carry the whole breadcrumb, not a subset. A refused stall's
  `run.stalled` names the refusal.
- **Per-attempt state, EXCEPT billing.** `ToolLifecycleState` is built per
  attempt (`createTurnAttemptLifecycleState`), and the split is not uniform:
  latency and in-flight lifecycle (`streamStartedAtMs`, `firstTextLatencyMs`,
  the delegation tracker, the tool-call maps) are per attempt, because carrying
  them would mis-time latency and re-settle tools the replaced attempt already
  settled. BILLING is per TURN — a recovered turn really did spend the stalled
  attempt's tokens, and the `message-finish` is what the run ledger and spend
  analytics persist. `stepBilledCostUsd` / `stepCount` / the billed-cost flags
  carry directly; TOKENS ride separate `carried*` fields because Mastra's finish
  usage is cumulative over ONE stream and `stepped*` keeps its per-stream
  meaning for the steered finish. Context sizes never accumulate: they describe
  the latest step's prompt, and inflating them would claim a context window that
  never existed.
- **A replaced attempt SETTLES what it started.** The turn drains both
  `makeCancelledDelegationRunEventChunks` AND
  `makePendingToolOutputRunEventChunks` before discarding the attempt — the same
  pair the terminal path drains. Without the second, a tool whose only terminal
  observation was a `tool-output` part loses its `tool.completed` row and its
  duration outright, because the continuation treats that tool result as INPUT
  and never re-emits it.
- **One turn reports one `run.started`.** A continuation is a fresh
  `agent.stream`, so Mastra re-emits `start` and the mapper would produce a
  second `run.started`; `withoutDuplicateRunStarted` drops it, and `run.resumed`
  is what marks the new attempt. Left in, the timeline shows two "Assistant run
  started" rows for one turn and every started/finished aggregation
  double-counts recovered runs.
- **A continuation that cannot be CONSTRUCTED terminates like everything else.**
  `handleStreamFailure` already disposes the runtime and rethrows, so the turn
  must not dispose again (`dispose()` has no idempotency guard, and a throw from
  a second `mcpClient.disconnect()` would replace the original error). The turn
  yields the same visible-text + `run.failed` + error-finish triple instead of
  throwing mid-stream, which would have been the one ending whose cause is
  invisible in the durable timeline.
- **Only the INITIAL leg recovers.** Approval- and suspend-resume consume a
  one-shot approval/snapshot that cannot be re-issued, so they run through the
  same turn runner with `maxAttempts: 1` and keep the pre-BST-1409 behavior.
- **Construction failures still REJECT the returned promise.** The first attempt
  is built eagerly, before the generator is returned: a run rejected before any
  stream part must surface as a transport rejection the renderer renders as an
  error block (see the renderer safety net above), never as a mid-stream throw.
  Pinned by the `stream_failure`/`empty_stream` cases in `mastra-streaming.spec.ts`.
- Paired tests: `mastra-stall-recovery.integration.spec.ts` (recovery, budget
  exhaustion, opt-out, user-cancel, continuation prompt contents, orphan drain
  across a recovery). Every recovery case asserts the TOOL-EXECUTION COUNT: a
  continuation that lost the completed steps would still answer plausibly, it
  would just re-run every tool first, so only the count proves the carry-forward.

Config (strict parse — malformed value THROWS, per the no-silent-fallbacks rule),
defined in `packages/agent/src/config/resilience-config.ts`:
- `BRAINSTRIKE_TOOL_TIMEOUT_MS` (default 60000) applies to every native and MCP tool execution.
- `BRAINSTRIKE_STREAM_INACTIVITY_MS` (default 120000) — the tolerated gap
  between parts, once the provider is demonstrably ANSWERING. Scoped to that
  phase only since BST-1408, and narrowed again to exclude reasoning (see the
  reasoning-gap entry below).
- `BRAINSTRIKE_STREAM_FIRST_OUTPUT_MS` (default 600000) — the budget for the
  provider to produce its first output, **per step, not per stream**.
  DELIBERATELY decoupled from the inactivity window and never tighter than it,
  for the same reason the tool-call-input budget is (BST-839): the two answer
  different questions — "has the provider started answering yet?" versus "is it
  still delivering?". Sharing one number killed a healthy 18-minute turn,
  because a request carrying ~169k prompt tokens at `reasoning.effort: 'max'`
  can spend minutes producing nothing observable, which is indistinguishable
  from a wedged transport at the stream-part layer. Same explicit-vs-default
  resolution as the input budget: two EXPLICIT values in a contradictory shape
  throw; an unset first-output window widens to the inactivity window.

- `BRAINSTRIKE_STREAM_REASONING_GAP_MS` (default 600000) — the tolerated gap
  between REASONING parts. Same explicit-vs-default resolution and same
  never-tighter-than-inactivity invariant as the first-output window.

  **A REASONING DELTA IS NOT AN ANSWER — do not relitigate.** BST-1408 split
  "has it started?" from "is it still delivering?" but left reasoning on the
  wrong side of that line: any non-scaffolding part flipped the stream to
  `streaming`, so the FIRST reasoning token armed the 120s window for the rest
  of the step. Interleaved-thinking models emit a burst of thought, pause to
  think further, then continue — so that window was armed against precisely the
  pauses high reasoning effort is made of. `google/gemini-3.7-flash` at
  `reasoning.effort: 'high'` died on both attempts of one turn (run-352bcf33),
  each time with `phase: 'streaming'` and `lastPartType: 'reasoning-delta'`.

  Reasoning shares the first-output BUDGET because it asks the first-output
  QUESTION: the model is working and has not begun its answer. It is a separate
  phase rather than an addition to the scaffolding set, because a reasoning part
  IS provider output — folding it into scaffolding would let it re-arm the
  first-output window on every delta and would erode the closed-list rule that
  makes unknown new part types default to "this is output".

  The phase moves BOTH ways: the next answer part returns the stream to
  `streaming`, so a wedged provider mid-answer is still caught by the tight
  window, and reasoning resuming after text widens it again.

  Owned by `MASTRA_REASONING_PART_KINDS` in `agent-streaming.ts`, typed
  `Partial<Record<StaticMastraChunkType, …>>` — the SAME union derived from
  Mastra's own `ChunkType['type']` that `MASTRA_STATIC_CHUNK_DISPOSITIONS` is
  checked against — so a Mastra rename fails to COMPILE here rather than
  silently dropping a type back into the tight window.

  CONTENT vs MARKER inside that record is load-bearing. A thinking delta ENTERS
  the reasoning phase; block bookkeeping (`reasoning-end`,
  `reasoning-signature`) only PRESERVES the phase already in effect. Providers
  exist that emit `text-start` BEFORE `reasoning-end`, so a marker that set the
  phase would widen the window back out exactly as the answer began. Preserving
  keeps a not-yet-answering stream wide — the gap between `reasoning-end` and
  the first `text-delta` is still "has it begun answering?" — and an
  already-answering stream tight.

  `resolveStalledVisibleMessage` (stream-termination.ts) has its own branch for
  this phase: "stalled without output" would be actively wrong when the model
  was producing reasoning and stopped mid-thought.

  **THE PHASE BOUNDARY IS PROVIDER OUTPUT, NOT "THE FIRST PART" — do not
  relitigate.** Measured through the real Mastra loop, a turn's raw parts are:

  ```
  start       t+0ms      <- framework, instant
  step-start  t+7ms      <- framework, instant
  tool-call   t+312ms    <- provider, after 305ms of thinking
  step-start  t+321ms    <- framework, instant
  text-start  t+723ms    <- provider, after 402ms of thinking
  ```

  A rule that ends the wide window at the first RAW part therefore covers ~0ms
  of provider time and measures every real time-to-first-token against the tight
  one — which is the exact failure the split exists to prevent. Worse, Mastra
  opens EVERY step with that prologue, so time-to-first-output recurs throughout
  a turn: the captured incident's fatal gap was a MID-TURN step's TTFT
  (`run.step.started` 07:51:41 → silence → killed 07:56:48), not the opening
  one. `withInactivityTimeout` therefore takes a `countsAsProviderOutput`
  classifier; `MASTRA_SCAFFOLDING_PART_TYPES` (`start`, `step-start`) both KEEPS
  and RE-ARMS the wide window, so each step gets its own budget. That set is a
  CLOSED list of scaffolding rather than an allowlist of output kinds: a Mastra
  release adding a new provider part type must default to "this is output"
  (tightening on a part known to come from the provider), never to "this is
  free". The real-loop coverage is
  `packages/agent/src/__tests__/mastra-stream-first-output.integration.spec.ts` —
  it exists because the shared fake-Mastra harness feeds a hand-written part
  list with NO prologue and structurally cannot see this.
- `BRAINSTRIKE_STREAM_STALL_ATTEMPTS` (default 2) — provider attempts per turn
  before a stall becomes terminal. `1` disables recovery (the pre-BST-1409
  behavior) and is what the terminal-path specs pin. Deliberately small: a
  resume re-sends the whole prompt (~169k tokens in the captured incident), so
  an unbounded budget would let a reliably-stalling route bill one turn
  repeatedly.
- `BRAINSTRIKE_TOOL_CALL_INPUT_MS` (default 600000) is the maximum wall-clock
  time for one incomplete streamed tool input; argument deltas do not reset it.
  Decoupled from — and never tighter than — the inactivity window (BST-839).
  That invariant is enforced only when the value is EXPLICIT (env or override);
  when it is left at its default it widens to the inactivity window instead of
  throwing, so a deliberately long `BRAINSTRIKE_STREAM_INACTIVITY_MS` cannot
  fail a run by naming a variable the operator never set. Widening a default is
  not a silent fallback — nothing configured is overridden, and the documented
  rule still holds.
- A local-runtime inactivity termination includes the normalized provider and
  selected model in both the structured error log and visible run failure. Do
  not include bearer tokens or silently restart/unload the external server. The
  timeout aborts the exact active provider request; it never lengthens the
  window or leaves generation running after the visible terminal failure.
- Invariant: tool timeout < stream inactivity <= tool-call input budget, and
  stream inactivity <= stream first-output window, and stream inactivity <=
  stream reasoning-gap window (all `<=` comparisons are enforced only against an
  explicitly configured value; see above). The
  FOUNDATIONAL tool-timeout ordering is checked before any derived window, so a
  config breaking several invariants names the first thing to fix.
- The stall diagnostic and the durable `run.failed` metadata carry `phase`
  (`awaiting-output` | `reasoning` | `streaming`), `partsSeen` (scaffolding included — it is
  transport activity, and `partsSeen: 2` beside `awaiting-output` is precisely
  the "prologue arrived, provider never did" story), and `lastPartType`
  (BST-1408). `lastPartType` is the last part the caller could NAME: an
  undescribable part leaves the previous name in place rather than erasing the
  breadcrumb. The user-visible text differs by phase too — a step that never
  started reads "produced no output within Xms of the request starting", not
  "stalled ... without output", which implied it had been streaming. `inactivityMs` alone could not say WHICH silence
  fired or what the provider last sent, so the 2026-08-22 incident had to be
  reconstructed by inference from run-event timestamps. The watchdog itself
  stays generic over the stream element: `describePart` supplies the Mastra part
  type from the call site rather than the timer module assuming a shape.
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
emit them mid-part (proof: data-stream-text-continuity.spec.ts).

Open tool-call args streams have a related ordering contract (BST-962), whose
decoder-side justification CHANGED at assistant-stream 0.3.35 — read this whole
paragraph before reasoning about the mapper's deferral machinery.

Through 0.3.34 the `DataStreamDecoder` closed the ACTIVE call's argsText
controller on every frame in a `TOOL_CALL_ARGS_CLOSING_CHUNKS` set
(`b`/`9`/`0`/`g`/`h`/`3`/`e`/`d`/`aui-text-delta`/`aui-reasoning-delta`/
`aui-data`), so ANY such frame between a call's `b` and its `9` made the next
`c` args delta append to a closed controller — an unhandled "Cannot enqueue a
chunk into a readable stream that is closed" TypeError that errored the whole
renderer pipeline (the visible chat died with the enqueue error) while the
agent-side run completed invisibly.

**0.3.35 removed that set entirely** — `TOOL_CALL_ARGS_CLOSING_CHUNKS` does not
exist anywhere in the pinned 0.3.37 dist. At 0.3.37 an argsText closes ONLY on
an explicit frame: the complete `9`; a `c` delta carrying `isFinal: true`; the
call's `a` result (which marks it closed); and the stream-wide
`closeOpenToolCallArgs()` that `3`/`e`/`d` and decoder flush run. A `0`/`g`/`h`/
`aui-data`/`aui-text-delta`/`aui-reasoning-delta` frame between a call's `b` and
its `9` now closes nothing. Two further consequences, both verified against the
0.3.37 decoder source rather than inferred:

- The crash class is GONE as described. A `c` delta for an already-closed args
  stream is now dropped behind a one-shot `console.warn` ("Dropped tool-call
  args delta for closed args stream"), not an unhandled TypeError. What STILL
  throws in strict mode (the default) is a duplicate `b` tool-call id, and a
  `c`/`a` naming an id the decoder never saw.
- Interleaved args across PARALLEL calls (`b`-A, `b`-B, `c`-A) is no longer
  decoder-lethal: distinct ids get distinct controllers and `c`-A still resolves
  to A's open controller. The previous "already lethal at the `b`" note applied
  to the pre-0.3.35 decoder and is retained below only as history.

The mapper's obligations are UNCHANGED by this bump — deliberately. It still
(a) defers aui-data parts (run events, shell output, context breakdown,
child-run usage) while `openArgsCallId` is set, flushing after that call's `9`;
(b) closes an open args stream — emitting its `9` with the accumulated args —
before text/reasoning deltas, error/finish frames, and approval/suspend notices
(pauses produce no later boundary, so the notice cannot be deferred);
(c) prefers DEFERRAL over premature flushing everywhere; (d) closes the window
EAGERLY (`b` immediately followed by its `9`) when a tool start already carries
the complete input — the non-streaming provider path (`tool-call` part, no
`input_stream_*` events) — so the window never spans tool EXECUTION, which would
buffer live shell output and run events until the result; a late
`input_stream_end` after any forced close is dropped by the `argsEmitted` guard.

Which of those still carry a LIVE justification at 0.3.37, so a future reader
does not delete them as dead weight:

- (b) is still load-bearing for `3`/`e`/`d`: `closeOpenToolCallArgs()` closes the
  argsText WITHOUT any `9`, so a call whose args were never completed settles
  with partial args. Emitting the `9` first is what preserves them.
- (d) is still load-bearing for LATENCY, independent of any decoder behavior: an
  args window spanning execution buffers live shell output and run events until
  the result.
- (a) and (c) keep an independent justification from the paragraph above — an
  `aui-data` part CLOSES the active text/reasoning append in the ACCUMULATOR,
  which 0.3.35 did not touch — but their args-specific half is now strictly more
  conservative than the pinned decoder requires.

That conservatism is intentional and is why this bump needed no mapper change:
the emitted wire stays valid against both the pre-0.3.35 and post-0.3.35
decoders. Whether the args-specific half of (a)/(c) should be relaxed now that
the crash class is gone is a real question, but NOT one to settle inside a
dependency bump — it needs its own ticket and its own evidence.

The incident producer was an OM-observer run event landing mid
`updateWorkingMemory` args (debug bundle 2026-07-28T15-43-22Z). Proof: the
BST-962 describe block in data-stream-text-continuity.spec.ts, including the
`expectDecoderSafeArgsStream` invariant sweep — which asserts the mapper's
stricter ordering, and whose docblock records that it now outruns what the
decoder needs. The renderer's
data-stream runtime also defers assistant-stream's decoded `message-finish` until
decoder flush: assistant-stream 0.3.37 emits that marker before its trailing
`part-finish`, and exposing completion early lets an immediate next turn abort a
still-draining text controller. Aborted runs propagate the authoritative abort
reason without surfacing cancellation teardown as a new assistant error; server
subscriptions detach without double-closing their stream controller. Desktop
assistant execution is owned by the main-process data-stream session, not by one
renderer HTTP response. A response close detaches only that subscription; the
source continues to terminal state and remains replayable for the session
retention window. User Stop is the distinct authoritative cancel path: the
renderer posts the validated run id to `POST /assistant/cancel`, which aborts
the registered execution controller. Do not infer user intent from navigation,
renderer reload, or a dropped socket.

Mastra title generation has its own finish-boundary lifecycle. The PGlite
memory factory opts into top-level `generateTitle`, while
`streamAttemptChunks` starts the public
`Agent.generateTitleFromUserMessage` request before yielding the terminal
finish. The downstream data-stream consumer stops pulling immediately after
that finish, so the generator's `finally` must await the already-started title
task before aborting the internal stream controller or shutting down the
per-run Mastra instance. This wait happens after the finish has reached the UI:
it protects background persistence without adding title-model latency to the
visible assistant response. Approval/suspend terminal parts and memory-free
runs never start the task.

Each desktop response exposes an opaque absolute replay cursor in
`X-Brainstrike-Assistant-Event-Id` and the durable assistant message identity in
`X-Brainstrike-Assistant-Message-Id`. While the run is active, the renderer
stores only `{assistantMessageId, eventId, runId}` in thread-scoped
`sessionStorage`. After history hydration on renderer reload, it reconnects with
`GET /assistant/resume` plus `Last-Event-ID`; it never composes a second model
request. Replay must reuse the durable assistant message ID and its persisted
parent rather than append a duplicate hydrated message. The installed
assistant-ui runtime creates a temporary streaming message for `resumeRun`;
Brainstrike removes the hydrated durable leaf before replay, then reconciles
the history append to the durable ID and maps the temporary local ID back
through the public thread `export`/`import` API after assistant-ui's `runEnd`
event. Waiting for `runEnd` is required because error and incomplete outcomes
can update the local message after the replay iterator closes. Do not patch
assistant-ui internals to add a message-ID input. A missing durable leaf or a
leaf with descendants is a visible replay error, never a guessed parent.
Transient replay
failures receive at most two automatic retries; a missing/expired session is a
visible 404 and clears the stale renderer record. Terminal completion, failure,
or explicit Stop clears the record. The endpoint base must come from the
already-resolved assistant runtime API (`getAuth()`/`getUrl()`), never from the
legacy optional `window.assistant.url` field alone.

### ACTIVITY GROUPS (BST-1656, re-based on `MessagePrimitive.GroupedParts`)

The assistant message renders its parts through `MessagePrimitive.GroupedParts`
(`packages/assistant-ui/src/assistant-activity-parts.tsx`) with
`groupAssistantActivityPart` (`assistant-activity-grouping.ts`) as the grouper.
The library's legacy `components.ChainOfThought` path is gone from this repo
and must not return: its grouper ends a group on ANY part that is not
`tool-call`/`reasoning`, and this runtime emits a `brainstrike.run-event` data
part around every tool call (live via `aui-data` → `part-start`, and woven
between parts on reload), so every call rendered as its own "Worked · 1 step"
group. Grouping rule (pinned by `assistant-activity-grouping.test.ts`):

- `reasoning` / `tool-call` → the activity group.
- `brainstrike.run-event` → group-transparent, EXCEPT `isAlwaysVisibleRunEvent`
  kinds, which stay standalone so a collapsed group can never hide a failed or
  cancelled run, a skipped MCP server, or a pending approval row.
- shell-output / context-breakdown / child-run-usage → transparent (they
  render `null` either way).
- tool-approval / tool-suspend cards, `text`, and unknown data parts →
  standalone. A pause is a real boundary.
- MCP-app tool calls stay inside the group: Brainstrike detects apps by RESULT
  shape only, and a call must not change groups when its result lands.
- A `group-activity` node holding only transparent data parts (no
  `reasoning`/`tool-call` — for example a trailing `run.finished` after the
  final text) renders its children bare: no `AssistantActivityGroup` chrome,
  no `assistant-activity-group` test id.

`AssistantActivityParts` passes `indicator="no-text"` to `GroupedParts` (the
library default), required for parity with the legacy path's empty-message
placeholders (`EmptyParts`, `ConditionalEmpty`) — `"never"` blanks the
assistant bubble from Send until the first part arrives, which regressed the
pre-first-token thinking indicator. The library also emits that slot whenever
the last part is a tool call or transparent data part, i.e. while an activity
group is live; the renderer drops it exactly when the TRAILING group holds an
activity part (`trailingGroupHasActivity(state.message.parts)`), so that
group's header is the sole live status and no second "Thinking" row trails a
collapsed group (CDT pass 4). The slot still renders for a running message
with no activity in its trailing group — zero parts, only standalone data such
as `run.started`, or `[…, text, tool.started]`, where the earlier group is no
longer trailing (it reads `Worked`) and the bare data-only group renders
nothing, so the slot is the turn's only live affordance until the next
tool-call part lands. Suppressing on "any activity part anywhere" darkened
that window (review finding, wave 3). A trailing approval/suspend card is
standalone as well, but a message paused on one is `requires-action`, not
`running`, so the library emits no slot there regardless.

Chronology rulings (unchanged): each contiguous group renders at its own
position; never hoist later parts into an earlier group or suppress later
groups. Group status is the library's `GroupPart.status` (running if any part
runs, else the last part's). A group also counts as active when the message is
still running, this group holds the message's last part, and the group's own
status has not resolved to `incomplete` — a tool call's result can land in the
same streamed chunk that fences the next call into the same coalesced group,
so a purely part-derived status would otherwise flash "Worked" for the
model-latency gap between two calls of the same run. Only the trailing group
gets this treatment: earlier, genuinely finished groups stay inactive when
later thinking starts (BST-1656 ruling preserved). The reasoning disclosure
renders live reasoning text directly from `useMessagePartReasoning`, never
through the text-part renderer; each reasoning part carries its own
disclosure (open while it streams, collapsed once it settles, a manual toggle
sticks), so a group with several thinking blocks never opens or closes them
together — test ids and labels unchanged. Reasoning-only groups omit the step
count. Incomplete group status is authoritative (cancelled → Stopped; other
reasons → Activity failed); a completed call with the canonical `isError`
flag is counted once into the header's `· N failed` suffix — it never turns
the group itself failed, only the group's own incomplete status does. The
group's `Stopped`/`Activity failed` headline is derived from its ACTIVITY
parts (running if any runs, else the last reasoning/tool-call part's status),
never from a transparent data member, so a trailing `tool.completed`/
`tool.started` cannot mask an interrupted call (PR #3061 review finding 1:
`getGroupStatus` mirrors the group's own last member — including transparent
data parts — which can read "complete" even though an earlier, resultless
call in the same group is `incomplete`) — and a group whose activity all
resolved reads `Worked` even on a cancelled/errored message (the standalone
`run.*` row carries the run outcome; this narrowed an earlier, over-wide fix
that inherited the message's incomplete reason onto the whole trailing group,
including one whose own activity had already resolved). Tool
durations and shell output correlate by call id across the message; each
group's elapsed fallback uses only its own tool events. The turn-wide task
list renders once, in the group holding the
message's first activity part.

COLLAPSED BY DEFAULT (BST-1677 wave 3, Sean's request): a group's body renders
collapsed at ALL times — running or done — `AssistantActivityGroup`'s
`expanded` derivation is `userExpanded ?? false`, never `?? isActive`. The
header is the live "cycler" instead: while the group is active it reads
"Thinking" (shimmer text, no active tool label) while a reasoning part in this
group is `status.type === 'running'` and no tool has started yet, and switches
to "Working `<tool>` `<arg>`" the moment a tool call becomes the active step
(`ActivityGroup` computes this `reasoningActive` flag from the group's own
parts). An explicit user toggle (`AssistantActivityGroup`'s `userExpanded`
state) sticks for the life of the mounted group, exactly as before — it can
still be expanded while running.

HYDRATION LIVENESS (do not relitigate): every animated "still happening"
indicator carries `data-live="true"` (`BrainstrikeThinkingMark`,
`AssistantThinkingIndicator`, the subagent pulse), and
`assistant-hydration-liveness.test.tsx` asserts a reloaded thread renders NONE
unless a pause is genuinely pending. Part-derived status is safe by
construction (hydrated messages are `complete`, so a resultless tool call
inherits it). Run-event rows are the hazard: a `running` row whose owning
message has settled resolves to the renderer-only `'interrupted'` status
(`AssistantRunEventDisplayStatus`; never persisted) unless a
`brainstrike.tool-approval` / `brainstrike.tool-suspend` data part for the same
`toolCallId` exists in the thread — the live notice, or the synthetic message
`appendSuspendedPauseMessages` re-appends for a still-suspended pause. An
ABSENT message status is left alone: liveness is never guessed. Subagent child
rows follow the same rule (`readLiveSubagentToolRowsFromMessages`). Between
history hydration (messages land `complete`) and `beginAssistantReplay`
removing the durable leaf it replays, an in-flight row can briefly read
"Interrupted" — the replay re-creates the message right after, so the window
is short and self-correcting.

### Renderer stream-insulation boundary (BST-704, LIVE)

assistant-stream 0.3.37's
decoder/tool pipeline hand-rolls nested stream controllers (merge streams,
tool-call sub-streams) whose settlement paths (`setResponse`, detached
part-finish continuations) enqueue with NO cancellation guard — if downstream
cancellation or an upstream abort error propagates into that pipeline
mid-settlement, the late enqueue rejects as an unhandled renderer TypeError
("Cannot enqueue a chunk into a readable stream that is closed"; upstream root
fix is unreleased assistant-ui/assistant-ui#5045, and `patchedDependencies` are
banned — see ci-quality.md). `insulateAssistantStreamPipeline`
(`packages/assistant-ui/src/stream-insulation.ts`) therefore makes
those states STRUCTURALLY unreachable instead of racing them: the pipeline
reads a guarded byte source that translates an expected transport abort (the
run's AbortSignal fired) into a clean EOF, and the consumer reads through a
cancellation firewall — cancelling the run never cancels the pipeline; the
byte source is cancelled and the pipeline drains to its natural close in the
background, so every in-flight settlement lands in an open stream. Because an
insulated abort now ends in clean EOF, `run()` re-throws the authoritative
abort reason after the loop (an aborted run must never fabricate a successful
finish). Completion wins only after the buffered terminal `complete` message
has already been yielded: because that marker is deferred until decoder EOF, a
superseding abort in the yield-to-iterator-EOF gap must not rewrite the finished
run as cancelled. That decision reads the flush-time flag surfaced by
`deferMessageFinishUntilFlush`, NEVER the accumulated message's status:
`AssistantMessageAccumulator.flush()` fabricates a terminal status for any
stream that ends while still running, so message status is terminal on EVERY
drained EOF and cannot distinguish "run finished" from "stream was cut" (using
it marks every aborted run complete — proven by the abort-reason unit test,
whose expected rejection then never fires). The usage/context-breakdown taps
are abort-gated so a draining stream cannot report late usage. Real faults stay loud: pre-cancellation
pipeline/transport errors propagate to the consumer, post-cancellation
non-abort drain failures log with diagnostic context. Do NOT re-route the
decoded pipeline around this boundary or pass raw `response.body` into the
decoder directly. Proof: `stream-insulation.test.ts` (contract + deterministic
incident-class settlement) and
`data-stream-runtime-cancellation.browser.test.ts` (real-Chromium
abort/supersede interleaving sweeps; the incident environment is the Electron
renderer). Remove the boundary only after consuming an assistant-stream
release containing #5045 AND re-proving the browser sweeps green without it.

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
`background:true` on the one-shot tool is not the persistence mechanism. The
desktop application-layer command-session manager below owns that lifecycle;
model exposure remains a separate permission/discovery slice. Proofs:
mastra-tool-execution.integration.spec ('streams incremental shell-output …'),
execute-command-tool.test / execute-command-live-loop.test, shell-output-parts.test.

Persistent command sessions (desktop application layer):
`apps/desktop/src/assistant-server/command-session-manager.ts` is the
desktop-main source of truth for commands that must outlive one tool call (for
example a dev server). It deliberately does NOT replace `executeCommand`, which
remains the bounded, wait-for-exit path for normal tests/builds.

- A session belongs to one DB-backed workspace `rootId`; all list/get/read/
  write/stop/remove operations require that same root. A cross-root lookup is
  indistinguishable from an unknown id.
- `start()` resolves and realpaths the requested cwd inside that root, then
  returns immediately after a real `node-pty` spawn. Unsupported roots,
  escaping/nonexistent cwd, startup failure, exited writes, and invalid cursors
  surface typed errors; there is no cwd or cursor fallback.
- Combined PTY output is memory-only and capped at 2 Mi UTF-16 code units.
  Retention uses head-evicted, fixed-size adaptive blocks: Latin-1 terminal
  output stays one byte per code unit, and a block upgrades to UTF-16LE only
  when wider code units enter it. Tiny PTY events are copied into bounded
  blocks instead of retained as individual references, appends never rebuild
  the full retained buffer after it reaches the cap, and reads decode only the
  requested retained suffix. Oversized events copy their retained suffix so a
  V8 sliced string cannot pin the discarded parent.
  Reads use absolute cursors; `-1` attaches at the live tail without replay.
  The manager applies the requested UTF-16 page limit while decoding retained
  blocks, before joining the page, and backs the page cursor off a high
  surrogate rather than splitting a pair. An evicted cursor returns the
  retained page with explicit `hasMore`,
  `truncatedBeforeCursor` + `bufferStartCursor`; a cursor beyond the produced
  output throws. This mirrors OpenCode's bounded absolute-cursor replay shape
  and prevents duplicate polling output.
- Model-facing inventory and reads are producer-paged below a 5,500 UTF-8 byte
  result ceiling, which is deliberately below the durable artifact-settlement
  threshold. List continuation uses `offset`/`nextOffset`; read continuation
  advances `nextCursor` only through the emitted UTF-16 code units and exposes
  `availableEndCursor` plus `remainingUtf16CodeUnits`. A page never splits a
  surrogate pair. This source-owned paging is load-bearing for bounded live
  delivery. The canonical session-tool ids are additionally registered as
  non-durable outputs, so artifact settlement skips them even when a lifecycle
  hook wraps a result: command-session output must never be copied into the
  seven-day tool-output artifact store.
- Running/exited state is typed. The newest 25 exited sessions per root remain
  readable; older exited sessions are evicted. Command text, cwd, environment,
  and raw output are never logged or persisted.
- Tree reaping walks descendants before killing the PTY leader, then applies a
  POSIX process-group backstop and waits for the PTY exit event. Reaping is
  idempotent across abort/stop/remove/dispose races; operations on an already
  exited session surface typed state. Bulk disposal settles every PTY and logs
  any missing exit acknowledgement so one stuck process cannot skip the rest of
  graceful shutdown. Root disconnect reaps by the durable DB id returned from
  the path-keyed disconnect update (never the possibly divergent adapter id);
  factory reset and graceful shutdown dispose all sessions.
- Hosted desktop models receive two deferred operations through the ordinary
  native registry: read-risk `inspectCommandSessions` (list/read) and
  execute-risk `manageCommandSession` (start/write/stop/remove). The latter is
  omitted in plan mode and follows the normal ask/deny discovery and approval
  gates. Both tools own a target-aware transcript transform: start command/cwd,
  write data, streamed input deltas, session cwd, PTY output, and guarded error
  messages/reasons are replaced by allowlisted metadata before PGlite
  persistence, while the live display and current model step retain the bounded
  domain result. The built-in local provider omits both because it lacks
  deferred tool discovery. Web never constructs the desktop registry, and its
  explicit native tool-id partition omits both from settings, request
  allowlists, and the model tool menu, so it exposes no stub or fallback. Do not
  widen `executeCommand` in place. The command-session inventory UI is a separate
  follow-up slice.

Proofs: `command-session-manager.test.ts` (scoping, cursors/gaps, retention,
stdin, typed failures, startup-abort/dispose races, stuck-PTY settlement) and
`command-session-manager.integration.test.ts` (real PTY HTTP server survival,
natural non-zero exit, and leader/descendant reaping), plus the command-session
cases in `assistant-tools-read.integration.test.ts` (transcript redaction, UTF-8
result ceilings, manager/tool continuation composition, and surrogate-safe
paging).

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

## WHERE THE MASTRA STREAMING SPECS LIVE (BST-988)

`packages/agent/src/__tests__/mastra-streaming.spec.ts` was a single 4,246-line
file covering the whole stream boundary. BST-986 split `agent-streaming.ts` into
modules; the spec is now split to match. Five files share ONE fake-Mastra harness
(`packages/agent/src/__tests__/fixtures/mastra-stream-harness.ts` — the mocked
`Agent`/`Mastra`/MCP classes plus the mutable stream-part queue they read):

| Spec | Pins |
| --- | --- |
| `mastra-tool-lifecycle.spec.ts` | `mastra/tool-lifecycle-processors.ts` — `ToolLifecycleState`, `mapToolLifecyclePart`, `mapGenericToolEvent`, `makePendingToolOutputRunEventChunks`, `makeLifecycleStepMetadata` |
| `mastra-tool-approval-chunks.spec.ts` | `mastra/tool-approval-chunks.ts` (`makeApprovalRequiredChunks`, `makeToolSuspendRequiredChunks`) **paired with** `streamMastraToolApprovalAction` / `streamMastraToolResumeAction` — a pause that cannot be resumed is a bug in the PAIR, so splitting these across two files would let either side stay green while the contract broke |
| `mastra-stream-termination.spec.ts` | `mastra/stream-termination.ts` (`makeProviderErrorTermination`, `makeTripwireTermination`) plus the `run.finished`-vs-`run.failed` finish-reason policy, which is one question even though its code is split across `agent-streaming.ts` and `makeFinishChunk` |
| `mastra-stream-watchdogs.integration.spec.ts` | `makeStreamWatchdogTermination` through the real elapsed-time behavior of the inactivity and tool-call-input watchdogs; the suffix keeps these wall-clock-sensitive cases in the uncached integration lane |
| `mastra-streaming.spec.ts` | What no single module owns: the async-iterator contract, the R6 unknown-chunk diagnostic, token measurement, cross-step usage/cost accumulation, steering, observational-memory chunks, and everything reached through `createMastraAgentRuntime` |
| `openai-duplicate-item-compat.spec.ts` + `openai-reasoning-item-replay.integration.spec.ts` | `mastra/openai-duplicate-item-compat.ts` (BST-1095) — the unit spec pins keep-newest/drop-stale semantics and proves via the real `@ai-sdk/openai` serializer that each item id reaches the wire once; the integration spec seeds real PGlite with the double-persisted history shape and asserts every prompt the real agent loop produces carries each OpenAI item reference in at most one message (plus approval suspend/resume replay regression coverage) |

**These are integration specs, not unit specs — deliberately.** They drive
`streamMastraAgent` over a fake Mastra stream instead of importing the module
under test, because the mappers are reachable only through the R6 dispatch
(`processMastraStreamPart`) and the ORDERING they must produce is a property of
the dispatch loop, not of any single mapper. Contrast
`packages/agent/src/mastra/__tests__/mastra-chunk-decoding.spec.ts` (BST-985),
which CAN import its subject directly because those decoders are pure. Put a new
case in the file whose module owns the behaviour; add a file only when a new
module seam appears.

`mastra/stream-run-event-chunks.ts` has no dedicated spec on purpose: its
minting helpers are used by all four module-seam specs above, so each of those
files exercises it and no coherent set of cases pins it alone.

Mocked dependencies do not by themselves make a watchdog case cache-safe. The
two watchdog specs above drive production `Date.now` / `setTimeout` behavior
with real elapsed-time gaps, so their verdict still depends on un-hashed host
scheduling and every invocation must execute them. A watchdog test that uses
deterministic/fake time, or whose verdict does not depend on scheduler progress,
stays in the cacheable unit lane. The BST-839 case deliberately keeps 10x
per-gap headroom (20ms stream gaps against a 200ms inactivity window) while its
~400ms total stream remains long enough to prove the old coupled-timeout
regression; do not narrow that margin merely to shorten the integration lane.

## THREAD SCROLLING (STICK-TO-BOTTOM + JUMP-TO-LATEST)

Scroll position is owned by the REPO's follow engine
(`packages/assistant-ui/src/thread-scroll-follow.tsx`), never by panel state
and — since the 0.15 upgrade — never by @assistant-ui. The tier-1 scroller is
a PLAIN div wired to `ThreadScrollFollow` (one engine per panel via
`ThreadScrollFollowProvider` in ChatThreadUI): a thread pinned at the bottom
follows streaming growth; the moment the user scrolls up, `isAtBottom` flips
false and the engine stops writing `scrollTop` — streaming can never steal the
reading position back. Re-engaging is an explicit user act.

**Why repo-owned:** the library's `useThreadViewportAutoScroll` broke twice
upstream (0.14.28 and 0.15.x tear down its ResizeObserver on every `isRunning`
flip, silently unpinning follow on every send), and the failure is not
workable at its public API — the scrollTop clamp misread is indistinguishable
from a real user scroll from outside (two app-level workarounds were built and
failed the BST-1039 test; see dependency-updates-breaking-changes.md). The
engine is a parity port of the library's algorithm with a STABLE observer
lifecycle (attached once per scroller element, never re-created by renders) —
the stable lifecycle is the fix. `ThreadPrimitive.Viewport` must not return:
`assistant-ui-panel-architecture.test.ts` pins the plain-div scroller.

Content growth is detected by `MutationObserver`, measured immediately, then
verified in one coalesced `requestAnimationFrame`. Mutation delivery can
precede Chromium's final layout, while a `ResizeObserver` attached to the
scroller does not reliably observe scroll-height-only growth; relying only on
the synchronous read can therefore miss the new bottom. Pointer, wheel, and
touch intent plus detach cancel a pending frame so user navigation, or an
unmounted scroller, cannot receive a deferred follow write.

The scroller, the message list, the button and the engine are one owned
module pair — `assistant-thread-messages.tsx` (`ThreadMessagesRegion`,
`ThreadScrollRegion`, `ThreadScrollToBottom`) + `thread-scroll-follow.tsx`,
re-exported from assistant-ui-panel.tsx. The panel only composes them and
hands over the message components.

- **Jump-to-latest** (`ThreadScrollToBottom`) is the follow engine's button
  (`ThreadStaticScrollToBottom`): DISABLED
  while at bottom, scroll + re-engage when clicked; we style it
  (`.bs-scroll-to-bottom`, hidden via `:disabled { opacity: 0 }` — no layout
  shift either way). It mounts inside `ThreadScrollRegion` as a SIBLING of the
  scroller, not a child, so it stays anchored ~1rem above the composer instead
  of scrolling away; that works outside the scroller element because the
  follow engine lives in `ThreadScrollFollowProvider` context above both.
- **No explicit `behavior` on explicit scrolls.** An explicit option bypasses
  CSS `scroll-behavior`, and therefore the global `prefers-reduced-motion`
  override in globals.css — the engine's `scrollToBottom()` deliberately omits
  it so `scrollTo`'s default routes through CSS. Streaming growth follow is the
  exception: `'instant'`, because CSS smooth cannot keep up with per-token
  growth (same stance the library took).
- **`overflow-anchor: none` is SCOPED to the pinned state** via `data-pinned`
  on `.bs-thread-scroll-region` (mirroring `isAtBottom`). Pinned, JS owns
  `scrollTop` and native scroll anchoring would double-adjust. Scrolled up, the
  library writes nothing, so native anchoring is the ONLY thing holding the
  reader's text still when content ABOVE the fold resizes (async markdown/Shiki,
  images resolving, tool cards or chain-of-thought folds collapsing, edit
  composers swapping in). Disabling it unconditionally makes the text jump —
  do not "simplify" this back to a blanket rule.
- **No jump on attach or run start** (the library's
  `scrollToBottomOnInitialize`/`scrollToBottomOnRunStart` equivalents) — that
  is the reload-hydration stance in assistant-persistence.md: reopening a
  thread restores its position instead of jumping to the newest message. The
  ONE navigation jump is the thread SWITCH (`switchKeyRef` in
  ThreadMessagesRegion → `jumpToBottomInstant()`), parity with the library's
  `scrollToBottomOnThreadSwitch`; it requires a `threadKey` prop and never
  routes through the explicit-request listeners.
- There is deliberately NO collapsed-history affordance (removed in BST-896):
  every message renders. Which messages MOUNT is the render tier's business —
  see below.
- **Follow-up queue dispatch re-pins explicitly when the thread was pinned**
  (BST-1039). The flush unmounts the composer's chip row, and the browser's
  resulting `scrollTop` clamp can be misread as a user scroll by the follow
  engine's bookkeeping — silently unpinning follow with no user act. The
  dispatch in `follow-up-queue.tsx` captures `getIsAtBottom()` BEFORE the
  flush and fires the engine's `scrollToBottom` after appending; a reader who
  scrolled up is never yanked. Do not "simplify" this away as redundant with
  the engine's own resize re-stick — that path loses the clamp-ordering race.
- **A `scroll` event the engine itself authored never disengages follow.**
  A `measure` write claims the `scrollTop` it MOVED to (`unechoedWriteTop`) and
  the scroll listener swallows that one echo. A scroll event carries no position
  of its own — `handleScroll` reads LIVE geometry — and `measure` writes
  `scrollTop` synchronously and judges the result in the same breath, clearing
  `pendingFollow`, while the browser dispatches that write's event a task
  LATER. Resize the viewport in between and the leftover event is judged
  against dimensions the engine has never measured ("not at bottom, position
  did not move down"), which is indistinguishable from a reader parked above
  the end; follow then disengaged with no user act and never recovered,
  because `measure` only re-sticks while pinned. The chip row mounting
  (shrinks the viewport from OUTSIDE the scroller) plus a streamed chunk
  (grows the content inside it) is exactly that window, and neither fires a
  scroll event of its own. Two rules follow, both load-bearing:
  **authorship is the discriminator, not movement** — scroll events coalesce,
  so a user round trip to the end and back arrives as ONE event whose net
  movement against the last PROCESSED position is zero (the tier-switch suite
  relies on that event still disengaging); and **`lastScrollTop` is not the
  position before the current event**, it is the last one `handleScroll`
  processed. This was a ~9% `Browser tests` flake in
  `follow-up-queue-repin.browser.test.tsx`, always landing exactly
  `Δclient + Δscroll` px short of the bottom.
  Two placement rules keep the claim honest, and neither is optional.
  It is made in `measure` and NOT in `write`, because the justification for
  swallowing an echo is the synchronous `handleScroll` that only `measure`
  performs: the explicit-request writes (`scrollToBottom` — the jump button and
  the BST-1039 dispatch re-pin — and `jumpToBottomInstant`) never judge, so
  their echo is the ONLY thing that can re-pin the thread. Swallowing it leaves
  the jump button stuck on, which the default CSS smooth scroll hides and a
  **reduced-motion** user (`scroll-behavior: auto`, so the write lands
  synchronously) hits immediately — that is the third case in the paired suite.
  And only a write that MOVED the position is claimed: a no-op write dispatches
  no scroll event, so its claim could never be consumed and would linger until
  some unrelated event happened to land on that exact pixel.

Paired tests: `packages/assistant-ui/src/__tests__/assistant-scroll-to-bottom.browser.test.tsx`
(real Chromium against the real follow engine: pinned/unpinned button states,
click-to-bottom, growth below vs ABOVE the reading position, anchor scoping,
and the own-write echo — that suite forces the squeeze, the growth and the
stale event into ONE synchronous task so neither observer can have measured,
which is the interleaving CI produced under load),
the BST-896 case in `assistant-ui-panel-architecture.test.ts`, which pins the
plain-div scroller, the engine wiring, the absent `behavior`, and the scoped
CSS rule, and `follow-up-queue-repin.browser.test.tsx` (BST-1039: real chips +
real bridge — pinned dispatch requests the explicit re-pin, scrolled-up
dispatch never does).

### Render tiers (BST-897)

`ThreadMessagesRegion` picks one of two renderers by message count and
publishes the choice as `data-thread-render-tier` on the viewport — tier
selection is observable, never silent.

**Tier 1 — `static`** (below `THREAD_VIRTUALIZATION_THRESHOLD`, currently 400).
Every message is a real DOM row from `ThreadPrimitive.Messages`; off-screen
rows are cheap via `content-visibility: auto` + `contain-intrinsic-size` in
overrides.css, which keeps find-in-page, selection, screen readers and anchor
links working — that is why it is the DEFAULT tier. Containment is NEVER
applied to the last row: the streaming message grows token by token and a
lagging intrinsic size fights the follow logic. The streaming message is always
the last row and the library's message root carries no "running" attribute, so
`:not(:last-child)` IS the streaming exclusion. Scrolling is exactly as
described above.

**Tier 2 — `virtual`** (at or above the threshold). The list becomes an
end-anchored TanStack virtualizer (`anchorTo: 'end'`, `followOnAppend`,
`getItemKey` = message id, `measureElement`) driven by the library's documented
escape hatch, `unstable_useThreadMessageIds` +
`ThreadPrimitive.Unstable_MessageById`. Mounted rows are bounded by the
viewport, not by thread length.

- **One scroll owner per tier.** On tier 2 the virtualizer writes `scrollTop`,
  so every library-driven scroll is off: `autoScroll={false}` and
  `scrollToBottomOnThreadSwitch={false}`. Never run the library's
  stick-to-bottom hook and the virtualizer on one container.
- **`overflow-anchor: none` is UNCONDITIONAL on tier 2**, via
  `[data-thread-render-tier="virtual"]`, independent of `data-pinned`. The
  pinned-only scoping above is the static tier's rule: it holds because the
  library writes `scrollTop` only while pinned. The virtualizer corrects
  `scrollTop` in every state — item re-measurement fires while the reader is
  scrolled up too — so native anchoring would double-adjust there as well. Two
  independent selectors setting the same value; they never disagree.
- **Opening position.** `scrollToBottomOnInitialize` / `scrollToBottomOnRunStart`
  stay `false` in both tiers. Tier 2's equivalent is explicit: entering the
  virtual tier anchors to the newest message with `behavior: 'instant'` (never
  animated), but only when the reader was not already scrolled up — a thread
  crossing the threshold mid-session must not yank the viewport away. The
  anchor re-arms when `threadKey` changes or when the thread drops back to the
  static tier.
- **Pinnedness at the switch is RECORDED, never measured.** The anchor effect
  runs after the commit that already swapped the renderer, so the viewport is
  sized by the virtualizer's ESTIMATES by then, not the static list's real row
  heights; measuring `scrollHeight` there compares a stale `scrollTop` against a
  size that just changed, and the verdict flips depending on whether the
  estimate happens to run above or below the real height. The static tier's own
  `isAtBottom` is recorded while it is still the truth and read back on the
  swap. **Testing consequence:** a test that scrolls up and then crosses the
  threshold must wait for the LIBRARY to disengage — the jump button rendering
  enabled — not just for `viewport.scrollTop`, which is written synchronously
  and says nothing about the recorded value. Cross while the recorded value is
  still `true` and the swap anchors to the newest message, which is a terminal
  state: the viewport is legitimately pinned and no amount of waiting recovers
  the scrolled-up position.
- **`aria-live` forks per tier.** Every insertion into a live region is an
  announcement. Tier 1's only insertions are new messages, so the viewport stays
  `aria-live="polite"`. Tier 2 mounts and unmounts rows as the user SCROLLS, so
  the same setting would read out every row entering the overscan window; it is
  `off` there until a dedicated new-message live region exists.
- **Reduced motion, tier 2.** The no-explicit-`behavior` rule above is a tier-1
  rule. The virtualizer's behavior argument is not merely forwarded to
  `scrollTo`; it drives the instance's scroll state machine (a `'smooth'`
  scroll suppresses measurement corrections so re-measuring items cannot push
  the target away mid-animation). It therefore must be explicit, and the
  jump button checks `prefers-reduced-motion` itself.
- **One control, one chrome.** Class, icon, label and test id are declared once
  and shared; only the behaviour differs — `ThreadPrimitive.ScrollToBottom` on
  tier 1, `isAtEnd()` / `scrollToEnd()` on tier 2. The button takes plain
  `{ atEnd, jumpToEnd }` values, never the virtualizer: its identity never
  changes, so a child memoized on it would freeze.
- **Message markup never forks.** Both tiers render the SAME components map
  through library primitives; the tier decides which messages mount, never how
  they render. CSS that keyed off "direct child of the viewport" must account
  for tier 2's `.bs-virtual-message` position wrapper.
- **Row spacing must live inside the measured box.** `measureElement` measures
  the border box, so margins on a row — and the virtualizer's `paddingEnd` —
  are invisible to it: margins make consecutive rows overlap, and trailing
  padding outside the measured rows only reaches the DOM on the next React
  commit, so a correction fired while the last message is still growing is
  clamped by exactly that gap and the thread rests just above the true bottom.
  Tier 2 puts inter-message spacing and the trailing gap on the row wrapper as
  padding.

Paired tests: `packages/assistant-ui/src/__tests__/assistant-thread-virtualization.browser.test.tsx`
(real Chromium: tier attribute either side of the threshold, bounded DOM rows at
N=1000 with all messages still reachable, opening at the newest message, append
while scrolled up, streaming growth staying pinned, tier-1 containment computed
styles) and the BST-897 case in `assistant-ui-panel-architecture.test.ts`.

---

## IN-FLIGHT TOOL CARD PROGRESS (BST-849)

`ToolFallback`'s running row reads its label from what assistant-stream already
delivers, so a 30–120 s argument stream is no longer indistinguishable from a
hung run: `Receiving input · 12.4 KB · 42.0s` while the model is still sending
argument text, `Running · 44.0s` while the tool executes, and the measured
execution time once the call settles. The pure label lives in
`packages/assistant-ui/src/tool-call-progress.ts`; the hooks in
`use-tool-call-progress.ts`.

- **The signal is the accumulator's `state`, NOT `status.isArgsComplete`.**
  `AssistantMessageAccumulator` (assistant-stream, pinned in lockstep with
  `@assistant-ui/core`) stamps `state: 'partial-call'` on the tool-call part
  it opens, flips it to `'call'` on `tool-call-args-text-finish`, and to
  `'result'` with the result. It ALSO writes `status: { type: 'running',
  isArgsComplete: false }` at creation and never flips that flag, so the typed
  field cannot carry the distinction. `state` is undeclared on
  `@assistant-ui/core`'s public `ToolCallMessagePart`, so
  `readToolCallArgsState` narrows it off the props (the accumulator spreads
  the whole part into the renderer) rather than casting.
- **Fallback is silence, not a claim.** An absent or unrecognised `state`, or a
  `partial-call` part that has received zero bytes (a zero-argument tool, a
  call delivered whole, the window before the first delta), reads as plain
  `Running`. "Receiving input" is asserted only once bytes have arrived.
- **Elapsed comes from `part.timing`** (`startedAt` at part creation,
  `completedAt` with the result), ticking once per second while running via
  `useToolCallElapsedMs`; no timing means no timer — never a fabricated clock.
- **Byte count is incremental** (`useIncrementalUtf8ByteLength`): the
  accumulator only appends, so only the new suffix is encoded per delta —
  re-encoding the whole text per emission is O(n²) allocation on the render
  frame budget.
- **Contract test:** `packages/assistant-ui/src/__tests__/tool-call-args-state.contract.test.ts`
  drives the INSTALLED accumulator through part-start → delta → args-finish →
  result and asserts `state`, `status`, and `timing` at each step. A
  dependency bump that renames `state`, starts flipping `isArgsComplete`, or
  drops `timing` fails there — otherwise the UI would silently revert to
  plain `Running` for the whole stream while every other documented runtime
  behaviour stayed green. Re-derive this section and that test together.

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
  BUNDLED `typescript-language-server` + the JavaScript TypeScript 6
  compatibility API (desktop `dependencies`, so it works out-of-box).
  TypeScript 7's native compiler owns the workspace `tsc` binary, while the
  official `@typescript/typescript6` package re-exports the JS API from its
  `@typescript/old` dependency. The LSP resolver therefore follows that
  package-scoped forwarding dependency to the real `tsserver.js`; it must not
  assume the server is adjacent to the compatibility wrapper's
  `lib/typescript.js`. Reliability recipe (all three required, verified):
  spawn the server's `cli.mjs` through `process.execPath` +
  `ELECTRON_RUN_AS_NODE=1` (packaged apps have no standalone `node`); pin
  `initializationOptions.tsserver.path` to the bundled real TypeScript 6
  `tsserver.js` (deterministic — OUR TS version); and advertise the
  `textDocument.publishDiagnostics` client capability (without it the server
  stays silent). Diagnostics land as two pushes (`[]` then the real set), so a
  settle-window is mandatory — an empty publish is polled a little longer
  before the "clean" verdict is trusted. This intentionally means agent-facing
  diagnostics come from TypeScript 6 while build/type-check gates run native
  TypeScript 7. The full compiler parity sweep covers every non-emitting project
  command, and the real-subprocess LSP integration additionally checks the
  embeddings WebGPU surface that relies on the current DOM library declarations;
  do not remove that cross-major control while the LSP stays on TypeScript 6.
  The desktop manifest must list the compatibility implementation
  (`@typescript/old`) as a production dependency and unpack it explicitly:
  Electron Builder packages the `@typescript/typescript6` wrapper but does not
  retain that wrapper's private dependency by inference. The build-config
  contract has a mutation control for both the dependency and unpack rule.
  The root also owns that exact alias so `.vscode/settings.json` can point
  `typescript.tsdk` at `node_modules/@typescript/old/lib`; the compiler-wiring
  guard requires both the path and its `tsserver.js`, preventing VS Code from
  silently falling back to its bundled compiler.
  Python/Go/Rust discovery + the config surface are the remaining Phase B work.
- **`lspInspect` tool (Phase B).** A read-risk native tool for semantic
  navigation: `{path, line (1-based), match}`. Prefer a markerless single
  JavaScript/TypeScript identifier as `match`; the cursor is its first character
  when it occurs exactly once on the target line. If the identifier repeats on
  that line, use a unique line fragment with exactly one `<<<` cursor marker
  before the intended occurrence. The tool reads the file through the checked
  reader and anchors the identifier or marker-stripped fragment against the REAL
  line text. A markerless identifier missing from the requested line returns up
  to five actual candidate line numbers for an explicit retry; it never jumps
  lines itself. Missing and ambiguous matches refuse, while marked fragments
  resolve the column as fragment-start + marker-offset, so a partial or stale
  quote can never silently inspect the wrong position (same
  validate-before-position convention as `stringReplace`). Returns up to four
  groups — hover (inferred type/docs), the inspected line's diagnostics,
  definition locations (with a one-line preview + workspace-relative path,
  URIs converted via `fileURLToPath` so Windows drive letters survive), and
  implementations. Reuses the same pooled connection + per-file diagnose lock;
  each hover/definition/implementation query is independently bounded
  (`QUERY_TIMEOUT_MS`) and never throws. A malformed
  marker / out-of-range line / unmatched or ambiguous `match` is an actionable
  input error thrown for the model to correct. Registered across the full multi-registry checklist (read-risk,
  no approval).
- **An unanswered inspect query is never an empty one (BST-1614).** A bounded
  query that TIMED OUT or THREW must not degrade to the same value the server's
  own "nothing here" answer produces. `queryHover`/`queryLocations` therefore
  return a `QueryOutcome` — `{ok:true, value}` or `{ok:false, reason}` — and
  `withTimeout`'s fallback is the `QUERY_TIMED_OUT` sentinel symbol, never
  `null`. Every leg that did not answer lands in `LspInspectionResult.queryFailures`
  as `{query, reason:'timeout'|'error', message}`, where `query` is named for the RESULT FIELD it fills (`hover` / `diagnostics` /
  `definition` / `implementation`) and `message` says what is UNKNOWN and what
  not to conclude ("do not conclude it has no definition or is dead code").
  `detail` text from a rejected request is bounded and collapsed to one line by
  `boundQueryFailureDetail` AT THE PRODUCER: `queryFailures` is a RETURNED
  value, and a consumer other than the projection gets these strings raw.
  Four invariants, all test-pinned:
  (1) a partial failure NEVER flips `available` to false — a hover that worked
  is still returned alongside the failures; (2) the failures are logged with
  `logger.warn`, visible at the DEFAULT `INFO` level, so a human chasing a
  wrong "no definition" claim finds the cause without enabling debug logging;
  (3) `| unanswered=<queries>` goes in the projection HEADER, which is the only
  unconditional line and is self-bounding, so the "absent group is not
  verified-empty" signal never depends on a line that fits; (4) the
  `query_unanswered:` detail lines sit in a PRIORITY-ORDERED prelude above the
  droppable result lines — ahead of `hover`, because they prevent a wrong
  conclusion while hover is only informational — but the prelude is itself
  fit-aware. `domainModelResultCharBudget` is per-run (`resolveScaledToolResult
  Budget` clamps the domain allowance to 500..3000 tokens, so a small context
  window floors it at 2000 chars) and a maximal header + three failure lines +
  clipped hover measures 4338 chars, so forcing them in would make the closing
  `assertProjectionFits` THROW — failing the tool call outright exactly when
  the language server is already misbehaving. Do not make any prelude line
  unconditional. Do not reintroduce a bare `catch { return []; }` on either
  query, and do not give `withTimeout` a fallback that a real answer could
  equal.
- **Diagnostics settlement is RETURNED, never inferred from the map
  (BST-1614).** `waitForDiagnostics` resolves to a `DiagnosticsWait` —
  `{settled:true, diagnostics}` only for a non-empty publish or an empty one
  that survived the FULL `DIAGNOSTIC_SETTLE_MS` window, `{settled:false}`
  otherwise — and both `diagnose`/`getEditDiagnostics` and `inspect` read that
  value. The old `hasPublishedFor` map probe is gone, and re-adding one is a
  regression: the diagnostics map is mutable and shared, so (a) a preliminary
  empty publish landing near the 6s deadline leaves an entry behind while the
  settle window never completes, and (b) a publish arriving during the up-to-4s
  semantic queries repopulates it after `inspect` already captured the line
  diagnostics. Either way a post-hoc `has()` reports a never-settled leg as
  ANSWERED, resurrecting the false "this line is clean" verdict inside the very
  leg added to prevent it. Both paths are pinned in
  `lsp-inspect-query-failures.test.ts`.
  Pinned by
  `apps/desktop/src/__tests__/assistant-server/lsp-inspect-query-failures.test.ts`
  (fake JSON-RPC wire: per-query timeout, throw, and the mixed case) plus the
  projection cases in
  `workspace-inspection-model-projections.test.ts`.
- **Pool + lifecycle.** One pooled server child process per workspace `rootId`
  (module-level Map, mirroring `execute-command-tool`'s `liveChildProcesses`).
  All acquisition goes through `acquireLspServer`, which registers the pool
  entry (a `Promise<LspServerConnection>`) in the same synchronous frame as
  the miss check — the diagnose locks are per-FILE, so concurrent
  first-touches of different files under one root race creation, and a bare
  get → create → set would spawn two children and orphan one. Do not inline
  `pool.get`/`pool.set` at call sites.
  Every server MUST be torn down: `disposeLspServers()` is wired into BOTH the
  factory-reset `runtimes[]` and graceful shutdown in `main.ts` (alongside the
  shell/terminal reapers); `evictLspServersForRoot(rootId)` fires from the
  `fs:removeRoot` IPC handler. Disposal awaits the child process's actual exit,
  not merely `child.kill()` accepting the signal, so each caller awaiting that
  connection's disposal observes honest settlement. Pool closure against new
  acquisitions during global/root teardown is separate follow-up territory.
  The no-orphan proof is the heart of `lsp-diagnostics.integration.test.ts`.
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
cases in `assistant-tools-multiroot-and-gating.integration.test.ts`. When changing this flow, update
this section and those tests.

---

## LOOP GUARDS (BST-1188)

The desktop assistant server applies three thread-scoped, main-process-memory
guards to stop an agent from repeatedly reconfirming evidence it already has.
This is a desktop native-tool capability boundary: web does not construct these
tools, and no network round trip or persistent store participates. Design
settled across PR #2323 review (both an automated and an LLM reviewer found
real correctness bugs in the first cut — several rulings below exist BECAUSE
of that review; do not relitigate without re-reading it).

- **Repeated identical calls — grepSearch/globWorkspace ONLY.**
  `withRepeatedCallGuard` in
  `apps/desktop/src/assistant-server/tool-call-loop-guards.ts` tracks stable,
  recursively key-sorted arguments independently for each `(threadScope,
  toolId)`. Calls one and two run normally, call three runs and stamps a
  warning, and call four or later is REFUSED WITHOUT calling `run` at all.
  Different arguments reset ONLY that tool's streak; an intervening call to
  another tool NEVER resets it. **`readWorkspaceFile` deliberately does NOT
  use this mechanism** — an args-only streak has no way to know the file
  changed between calls, so it would either permanently refuse a legitimate
  re-read after an edit (the refusal fires BEFORE the file is ever checked) or
  stamp a false "results have not changed" warning on content that did change.
  `readWorkspaceFile` relies solely on the mtime-aware window guard below,
  which always re-reads the file first and can therefore never go stale that
  way.
- **The streak only advances on a call that PRODUCES a result.**
  `peekRepeatedToolCall` is read-only with respect to the observable streak
  (it never mutates `repeatedToolCalls`); `withRepeatedCallGuard` calls it
  BEFORE `run`, then calls the mutating `commitRepeatedToolCall` only AFTER
  `run` resolves. A call that throws (transient ripgrep/fs error) is never
  committed, so it never advances the streak and never falsely tells the model
  "the result already in context" when no attempt ever produced one. The peek
  does separately promote cross-mechanism thread-scope LRU bookkeeping, as
  detailed under the bounded-state ruling below.
- **The warning is its own field, never folded into `hint`.** The grep/glob
  purpose-built projectors' continuation logic returns its offset-form
  continuation (and skips `hint` entirely) whenever the page was already
  trimmed by the output-char budget — exactly the large/expensive repeats this
  guard exists to stop. `withRepeatedCallGuard` therefore stamps
  `result.loopGuardWarning` (mutated in place, never a spread into a new
  object — the WeakMap-keyed telemetry in `tool-call-telemetry.ts` is tagged
  onto the SAME object and a spread would silently drop that tag). Both
  projectors render `loopGuardWarning` as its own `warning:` line
  unconditionally, the same way they already render `liveNote`/`probeNote`,
  so it survives regardless of the continuation branch.
- **Unchanged file-read windows.** `checkUnchangedReadWindow` keys a fresh
  `readWorkspaceFile` request by root, normalized workspace path, requested
  `startLine`/`endLine`, the EFFECTIVE `maxChars`, and observed mtime — two
  reads of the same range with different `maxChars` are NOT the same read (a
  bigger budget can return content the smaller one omitted), so `maxChars`
  participates in the key. The first read returns content, the second
  unchanged read returns `dedup: true` with `UNCHANGED_READ_STUB_MESSAGE`, and
  the third returns the same non-throwing hard-refusal shape used by the
  repeated-call guard. An mtime change resets the window (the model's next
  identical-args request always sees the edit — this is what makes it safe for
  `readWorkspaceFile` to skip the args-only streak above). A request with
  `cursor` is a continuation and MUST NEVER enter this guard; paging must
  continue normally.
  - **Checked only AFTER a page is built, and only when it is NOT truncated.**
    `runReadWorkspaceFile` calls `checkUnchangedReadWindow` after
    `fitReadWorkspaceFileResult` has already produced `selected.result` — never
    right after the file scan, where a later page-fitting failure (e.g.
    `maxChars` too small to advance) would otherwise record an observation for
    a call that never produced a page, priming the model's very next
    (corrected) retry to look like a repeat of a read that never happened. And
    only when `selected.result.truncated === false`: stubbing a TRUNCATED page
    would discard the only `nextCursor` pointer to the rest of a large file and
    misreport `truncated: false`/a full `endLine` — the stub's metadata always
    comes from the real `selected.result`, not a re-derived guess.
- **Repeated string-replace failures.** `recordEditFailure` counts only
  consecutive `StringReplaceError` failures whose reason is `ambiguous` or
  `not_found`, keyed by thread, root, and normalized workspace path. On failure
  three and later, `runStringReplaceWorkspaceFile` APPENDS
  `EDIT_FAILURE_HINT_MESSAGE` to the fuzzy matcher's own message rather than
  replacing it — the matcher's diagnostic (matched line numbers, the "diverged
  after N lines" cascade) is the single most actionable fact for widening
  `oldStr`, and replacing it would throw away exactly what the model needs most
  after two prior failures. `no_op` NEVER increments this streak. A successful
  `stringReplaceWorkspaceFile` OR a successful `writeWorkspaceFile` to the same
  path resets the streak — a full rewrite is the recovery path the hint itself
  recommends, so it must count as recovery too.
- **One shared scope authority.** Every mechanism MUST receive
  `threadScope = readStateScope(runtimeData)` from
  `apps/desktop/src/assistant-server/workspace-file-staleness.ts`; no tool may
  derive a second thread key. This intentionally shares identity with the
  read-before-write mtime tracker.
- **Refusal is data, NEVER an execution error.** `buildRepeatedCallRefusalResult`
  returns `{ok:false, refused:true, error}` so the model receives a compact
  decline and the run remains alive. For grep/glob, the object intentionally
  lacks `outputMode`: `parseGrepToolResult` and
  `parseGlobWorkspaceToolResult` reject it with
  `ToolProjectionInputRejectedError`, then `projectExistingModelOutput` in
  `packages/agent/src/mastra/tool-model-output.ts` catches that explicit marker
  and emits the generic bounded projection. Other projector errors still fail
  loudly. `readWorkspaceFile` already uses the generic JSON projection, so its
  refusal passes directly.
- **The unguarded read caller is load-bearing.** `workspace-context-tools.ts`
  calls `runReadWorkspaceFile` directly for bulk context and MUST see no loop
  guard or widened return. The three-argument overload therefore remains
  exactly `Promise<ReadWorkspaceFileResult>`; ONLY the four-argument overload
  used by `buildDesktopAssistantTools` can return `LoopGuardRefusalResult`.
- **Dedup still records knowledge.** Before an unchanged-read stub or refusal
  returns, `runReadWorkspaceFile` MUST call `recordKnownFileMtime` with the
  loop guard's scope and the file's canonical path/mtime. The bytes are not
  resent, but the thread's knowledge is current; omitting this write corrupts
  the next write-staleness decision.
- **Ephemeral, not factory-reset state — and now bounded (BST-1197).** The three
  maps are process-local. `resetToolCallLoopGuards` serves test isolation AND
  one production caller: after BST-1192 commits a stale-read projection
  rewrite batch, it resets that exact `readStateScope(runtimeData)` thread. A
  dedup stub must never refer the model to an earlier result the newly
  committed overlay will collapse on the next replay. This mirrors
  `packages/agent/src/tools/file-read-state.ts` and its `resetFileReadState`
  and MUST NOT be wired into factory reset. Each per-thread map holds at most
  the exported `MAX_KEYS_PER_THREAD_SCOPE` (256) keys, using that module's
  insertion-order, delete-then-set LRU-on-write technique. One shared activity
  tracker across all three mechanisms holds at most the exported
  `MAX_TRACKED_THREAD_SCOPES` (256) thread scopes; overflow evicts the
  least-recently-active scope from every store. The unchanged-read and
  edit-failure mechanisms are intentionally whole-thread, non-consecutive
  dedup: their designed behavior is for a key to survive arbitrary unrelated
  activity between touches. A tight 8-key cap defeated that behavior in
  ordinary multi-file sessions (PR #2332 review), so 256 preserves useful
  history while remaining bounded. Repeated-tool state only has grepSearch and
  globWorkspace entries in practice (at most a couple per thread), making the
  same generous cap harmless headroom there.

  Every write path (`commitRepeatedToolCall`, `checkUnchangedReadWindow`, and
  `recordEditFailure`) promotes its scope through `getOrCreateScopeMap`, and the
  read path (`peekRepeatedToolCall`) promotes it through the same shared
  `touchThreadScope`. The read-path touch is required because a refused call
  returns before commit: without it, a thread actively stuck in a refuse-only
  loop could be evicted as falsely idle and have its refusal silently undone
  (PR #2332 review, threads 1 and 3). This promotion changes only LRU
  bookkeeping; peeking still never advances the observable successful-call
  streak. The bounds remain lossless: a key or scope is forgotten only after
  `MAX_KEYS_PER_THREAD_SCOPE` or `MAX_TRACKED_THREAD_SCOPES` OTHER identities
  are touched in between, respectively. At that point the activity is no
  longer meaningfully contiguous, so restarting at fresh/one is correct.

Paired proofs live in `tool-call-loop-guards.test.ts`,
`loop-guard-projection-round-trip.test.ts`,
`assistant-tools-read.integration.test.ts`, and
`string-replace-workspace-file-live-loop.test.ts`. When changing this flow,
update this section and those tests.

## GUTTER-PREFIX WRITE GUARD (BST-1202)

`readWorkspaceFile` renders model-visible pages in
`read-workspace-file-tool.ts` (`renderReadWorkspaceFilePage`) with an unpadded
`${line}: ` prefix. `gutter-prefix-guard.ts` conservatively identifies that
display form before it can be pasted back onto disk. Refusal requires ALL of:
at least three lines matching the exact `^\d+: ` shape; those captured numbers
forming a monotonic NON-DECREASING run (an exact adjacent repeat is tolerated,
a decrease is not) with a TIGHT SPAN (`max - min < 2 * count`); and the run's
first (smallest) number being greater than 1. Do not broaden the prefix shape.

The tight-span bound (not a strict `+1` requirement, and not a majority-of-
lines proportion — PR #2352 review replaced the original design that used
both) is what does the actual discriminating work: it tolerates a single
deleted line from an edited paste (`10,11,13,14,15`, span 5 over 5 matches)
and a repeated boundary number — `renderReadWorkspaceFilePage` re-emits the
SAME line number as the prefix on both halves of a line split across a page
boundary, so a verbatim paste of two continuation pages repeats it — while
still rejecting two unrelated reads pasted back to back (`40,41,100,101`,
span 61 over 4 matches) and non-sequential content that merely starts with
digits (`12,45,90`).

**Known coverage boundary — deliberate, not an oversight.** A page-1 paste
(gutter numbers starting at 1, e.g. a verbatim `1: a\n2: b\n3: c`) is NEVER
refused. Legitimate sequential numeric-key content — a YAML mapping
(`1: January\n2: February\n3: March`), a numbered config list, any 1-based
enumeration — is textually IDENTICAL to a page-1 gutter paste (the common
case, since `readWorkspaceFile` defaults to starting at line 1); no signal in
the text distinguishes them. Blocking the legitimate write is strictly worse
than missing this one paste shape: a false refusal makes an ordinary numbered
write permanently impossible through these tools, while a missed page-1 paste
still gets caught by the model's own read-verify cycle after the corrupted
write lands. Only a read that started past line 1 (an explicit `startLine`,
or a continuation cursor) produces gutter numbers starting above 1, so only
THOSE pastes are guarded. Do not relax the `first > 1` requirement to close
this gap — it would reopen the YAML/numbered-mapping false positive instead.

The guard applies only to `writeWorkspaceFile.content` and
`stringReplaceWorkspaceFile.newStr`. It deliberately does not inspect
`stringReplaceWorkspaceFile.oldStr` (quoted from real file content), and delete
and rename have no content argument. In `runWriteWorkspaceFile` the
`MAX_WRITE_WORKSPACE_FILE_BYTES` size check runs BEFORE the guard (both are
pure pre-lock validations) so an over-limit payload is rejected before it
pays for the guard's `split('\n')` pass. This is a fourth, independent,
STATELESS mechanism: it has no thread scope or Map and does not participate
in `MAX_KEYS_PER_THREAD_SCOPE`/`MAX_TRACKED_THREAD_SCOPES`. A match throws
`ToolInputError` before locks, disk I/O, or the "Repeated string-replace
failures" path above can reach `recordEditFailure`; a gutter refusal consumes
zero edit-failure streak slots. An out-of-safe-integer captured number (e.g.
an attacker appending `99999999999999999999: x` to an otherwise perfect
gutter block) disqualifies only that ONE line — it is skipped, not treated as
a reason to abort the whole check, so it cannot be used to defeat the guard.

---

## PERMISSION ENGINE (TOOL APPROVAL)

Scope note: MCP elicitation (a server asking the user for input or link consent
DURING a tool call, BST-1584) is a separate consent channel from tool approval
and suspension. Approval/suspension ride the assistant stream and render as
thread cards; elicitation is host-scoped — desktop main's presenter authority
pushes it over IPC to an app-wide modal (`McpElicitationHost`) and receives the
settlement back over IPC. Neither channel resumes or approves the other; see
`docs/agents/assistant-providers.md` (client input / elicitation).

Renderer execution boundary (BST-1233): production desktop main does not import
or register `ipc-tools.ts`, the visible preload exposes no `tools.execute`, and
desktop Settings supplies no playground execution callback. The `window.tools`
bridge is selection-event-only. Consequently renderer code — including the
renderer-hosted local LLM adapter — receives no desktop executor and cannot
invoke native, assistant, shell, or MCP tools directly. The shared local-runtime
adapter remains executor-agnostic for explicit non-desktop embeddings/tests,
but local tool definitions are omitted when no executor is present. Tool
execution stays on the assistant server path below, where the
permission engine owns policy and per-call approvals; there is no compatibility
fallback that reconstructs approval state or accepts a renderer-supplied
workspace path. `ipc-tools.ts` is retained only as an unregistered legacy unit
harness: it preserves coverage of the former exploit path while production has
no import edge to it, and it throws before handler registration unless
`NODE_ENV === 'test'`. `tools-ipc-main-wiring.test.ts` pins the production seams
(main registration, preload/channel exposure, shared Window declaration, and
Settings callback) closed.

Mutation tools PROMPT for per-call approval by default. The permission policy
store (`packages/app-state/src/stores/permission-policy-store.ts`) defaults to
`enforce: true` with policies `{read:allow, mcp:allow, edit:ask, execute:ask}`,
so by default read/MCP tools run free while edits and shell commands suspend the
run for user approval. A user can turn `enforce` off (explicit opt-out), set a
category to `allow`/YOLO, or grant a session category. Its platform storage is
resolved through a local deferred state-storage proxy, so an optimized
chunk-evaluation cycle cannot make Zustand silently omit the `persist` API; a
later hydration retries resolution and genuine adapter failures remain visible.

Flow (desktop assistant server → agent runtime):
1. The renderer attaches the persisted policy snapshot to the request only when
   `enforce` is true. **ONE producer, at request-composition time (BST-1652 — do
   not add a second):** `prepareRequestData`
   (`packages/app-shell/src/hooks/use-assistant-request-lifecycle.ts`) calls
   `getPermissionToolGateSnapshotInput()` against the LIVE store and sets
   `permissionPolicyRequest` unconditionally — to the snapshot when
   `permissionEnforceable` (the desktop data-stream transport) and `enforce`,
   otherwise to `undefined`, which `JSON.stringify` drops. That fresh read is
   what closes the grant→resume race ("Always allow" flips the store and
   approves the pending call in the SAME synchronous handler, with no re-render
   in between). Consequently `buildAssistantRequestData` deliberately does NOT
   take or emit the field and `assistant-ui-panel-wrapper.tsx` deliberately does
   NOT subscribe to the permission-policy store during render: a render-time
   value could only be overwritten, while the subscription re-rendered the whole
   assistant panel on every grant. Pinned from both sides by
   `use-assistant-request-lifecycle.test.ts` ("permission-policy freshness at the
   request-composition seam"), the "never attaches permissionPolicyRequest" case
   in `assistant-ui-panel-wrapper-runtime.test.ts`, and the commit counters in
   `assistant-ui-panel-wrapper-store-subscription.test.tsx`.
   `resolveRequestPermissionPolicy` (agent) builds the trusted
   `PermissionToolGateSnapshot` with a SERVER-built `riskByTool`
   (`buildNativeToolRiskMap`) — the client never classifies tool risk.

   WIRE SHAPE — the field's disappearance for an opted-out request is a
   JSON-BOUNDARY ASSUMPTION, NOT the presence-means-non-default rule that a
   neighbouring opt-in field (`subagentPersonasRequest`) uses by genuinely
   omitting its key. Here the key is always present on the producer's object
   and only serialization removes it; `planMode` is written the same way. Read
   the VALUE — pass it to `resolveRequestPermissionPolicy`, which treats an
   absent key and an explicit `undefined` identically. Full rationale
   (including why `exactOptionalPropertyTypes` never catches drift here) is on
   the field declaration in `packages/agent/src/types.ts`. Pinned from both
   ends: "leaves the opt-in keys PRESENT with undefined values"
   (`use-assistant-request-lifecycle.test.ts`) fixes the producer's shape, and
   the "wire-shape contract" cases
   (`packages/agent/src/__tests__/permission-policy-request.spec.ts`) fix the
   resolver's indifference to it. The unconditional write is load-bearing and
   must NOT be simplified to conditional spread: it has to clobber a stale
   snapshot inherited from `requestData`, not skip it.
2. `filterToolsByPermissionWithMetadata` (`packages/agent/src/mastra/permission-tool-gate.ts`)
   gates the tool map BEFORE the immutable `Agent` is built: `'deny'`→omit;
   `'allow'`→keep unchanged; `'ask'`→keep a CLONE with Mastra's PER-TOOL
   `requireApproval: true` and record in `askToolIds`.
   SUSPENDING tools included (`brainstrike.runPython`; BST-1097, mechanism
   re-based at the @mastra/core ^1.57 adoption — the old SELF-APPROVING
   exception and its registry are gone): an `'ask'` decision takes the SAME
   `requireApproval` clone as every other ask tool — the framework's
   pre-execution approval is Gate A. The 1.56 approval rework made the old
   self-raised in-tool suspension unworkable (the framework consumes the
   `{approved}` resume before the tool can read it — an unfinishable loop)
   and simultaneously made the clone safe: the suspend-resume transport
   attaches the `approved: true` rider Mastra's per-leg re-check demands, so
   the tool's OWN `suspend()` pause (Gate B) stays resumable under the flag.
   `resolveSelfApprovalDecision` (exported beside the gate — same resolver,
   same risk lookup, cannot drift) is still injected at the composition root,
   now ONLY for the direct-invocation guard: an `'ask'` call outside an agent
   run refuses rather than running unprompted.
3. PER-TOOL, not global: marking each ask tool with `requireApproval` (Mastra
   >=1.37) makes Mastra suspend ONLY when that tool is actually called — allowed
   `read`/`mcp` tools in the same run still run free. We deliberately do NOT force
   the run-wide `requireToolApproval` (it would suspend EVERY tool call, breaking
   the read-only default). `resolveAskToolsForRun` (in the tool pipeline,
   `runtime-assembly/tool-pipeline.ts`)
   only decides whether ask tools may STAY: WITH Mastra workflow storage they stay
   (their per-tool flag suspends + the resume path can restore the run); WITHOUT
   storage (`streamMastraToolApprovalAction` throws) they are fail-safe OMITTED
   (never run an approval-required tool unprompted — no-silent-fallbacks).
4. The approval UI + resume chain (`makeApprovalRequiredChunks` →
   `tool-approval-required` chunk → `DataStreamMapper.handleToolApprovalRequired`
   → `TOOL_APPROVAL_DATA_NAME` data part → `assistant-tool-approval-notice.tsx`)
   prompts the user; approve→execute, decline→skip. Valid
   `brainstrike.executeCommand` arguments render as a selectable,
   whitespace-preserving command block plus the supplied working directory,
   workspace root, and timeout (an omitted working directory is labeled as the
   selected-workspace default). Its local guard mirrors the strict agent
   schema, including unknown-key rejection; malformed arguments show the
   existing visible preview error and unmodified raw arguments rather than a
   guessed command. File-edit previews label the target path and optional
   workspace root separately in their combined text, with an explicit
   separator; long identifiers truncate only visually while their complete
   text remains available to assistive technology and on hover. Live and
   rediscovered approvals share this component.
   `brainstrike.runSkillScript` uses a separate semantic preview that names the
   activated skill and skill-relative script while showing the explicit
   mounted root, root-relative cwd, runtime, and structured argv. It never
   presents or accepts a model-supplied absolute skill path; malformed typed
   arguments stay on the same visible raw-arguments error path.
   `brainstrike.runPython` (BST-1070 Gate A) renders the code plus
   always-rendered fact rows (internet / write / read / time limit / sandbox)
   from a server-computed `executionContext`
   (`CodeExecutionApprovalContext`, tool-approval contract): host facts the
   model's args cannot carry, derived by
   `resolveRunPythonExecutionContext` from the tool's own strict schema plus
   the constants execute() uses. It is forwarded in THREE places — stamped in
   `makeApprovalRequiredChunks`, spread through
   `DataStreamMapper.handleToolApprovalRequired`'s field-by-field rebuild
   (miss it and every LIVE approval degrades while rediscovered ones work —
   pinned by a live-transport test), and RECOMPUTED on rediscovery in
   `status-endpoints.ts` beside `riskCategory`. Fail-safe: args that fail
   strict narrowing or an absent/invalid context keep Approve/Decline but
   SUPPRESS the grant buttons (parent-side `resolveApprovalPreviewPolicy`,
   riding the existing null-`grantCategory` gating path) with a visible
   reason — no "always allow" for a call the card cannot read. Copy rule the
   fence contract forces: an empty `allowRead` under `defaultReadAccess:
   'permissive'` renders "most files on this computer", NEVER "can't read
   your files". Settled result surface (`run-python-result.tsx`, mounted by
   `tool-fallback.tsx`): killed ≠ completed ≠ didn't-run, non-zero exit is an
   amber finish (destructive chrome is reserved for `unavailable`), cancelled
   never renders as success or empty, and truncation is a per-stream note.
   Structurally narrowed result numbers must be safe integers (non-negative
   exit/omitted-byte values and a positive timeout) before this purpose-built
   surface renders. Malformed numbers stay on the generic tool-result path
   rather than producing `NaN`/`Infinity` UI. The card-level status maps
   cancelled/timed-out/killed to a `stopped` state
   instead of the generic green check.
   The built-in local provider admits a call to this chain only after its
   arguments parse as a root JSON object. A
   `local_tool_call_arguments_invalid` generation ends visibly with typed
   `run.failed` metadata before Mastra can create an approval snapshot; there
   are therefore no enabled Approve/Decline controls and no resume action for
   malformed Gemma output. Valid arguments are canonicalized before suspension,
   so the approval notice, durable snapshot, resumed card, and execution share
   one value.
   Alongside Approve/Decline the notice offers GRANT actions when (a) a
   `ToolApprovalGrantProvider`
   is mounted above it (app-shell wraps the panel, same outside-in pattern as
   `EditCheckpointProvider`; no provider → no buttons, capability gating) and
   (b) the approval carries a valid `riskCategory` (policy-driven ask —
   non-policy pauses never over-promise a grant): "Always allow <tool>" →
   `setToolOverride(toolId,'allow')` (persisted), "Allow <category> this
   session" → `grantSessionCategory` (session-lived), and — in a compact
   overflow menu (`approval-grant-overflow`) — "Allow all tools this session"
   → `grantAllSessionCategories()`, which grants ALL FOUR risk categories in
   ONE atomic store `set()` (a single subscriber notification, never a partial
   grant set). SETTLED: the blanket action is four category grants, NOT a
   session-yolo flag — per-tool DENY overrides still beat it (the safe
   direction), it changes no wire contract, and Settings > Permissions lists
   each granted category individually revocable plus a "Revoke all" button
   (`clearSessionGrants`). All grant actions record the grant
   FIRST, then approve the pending call through the normal resume; the
   pending call still resolves through `streamMastraToolApprovalAction`.
   TIMING (confirmed): the grant takes effect on the SAME resumed leg, not
   just the next request — `useAssistantRequestLifecycle.prepareRequestData`
   reads the permission posture FRESH from the store
   (`getPermissionToolGateSnapshotInput()`) at request-composition time,
   precisely because the grant + approve happen in one synchronous handler
   with no re-render in between (the same fresh-read pattern as plan-mode
   exit). The wrapper's reactive subscription additionally keeps later
   requests in sync.
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
   unrelated tool failures remain visible. Before either approval decision is
   applied, the resume adapter reads Mastra's storage-backed
   `listSuspendedRuns()` snapshot and exact-matches both `runId` and
   `toolCallId`. That durable snapshot is the authority for the original tool
   name and arguments. The resumed stream is seeded with that exact invocation
   before terminal output is mapped, so live completed cards retain the same
   arguments shown by the approval notice. A missing snapshot, tool name, or
   argument payload fails visibly before approve/decline executes; never invent
   `{}` or trust the client action as a fallback. Runtime reconstruction also
   reads Mastra's durable suspended-call snapshot before runtime reconstruction
   and preserves the execute-backed `brainstrike.webSearch` implementation only
   when that exact call is being resumed. A same-click read grant changes
   authorization immediately, but must not replace the suspended Tavily function
   with provider-native search: Mastra's durable invocation names the function
   and otherwise finishes without executing it. Resuming a different tool keeps
   provider-native search available, and a fresh later turn may select it. The
   approve/decline resume (`streamMastraToolApprovalAction`) passes
   `requireToolApproval: true` (the resume API needs it); the gate runs again on
   resume so the ask tools keep their per-tool flag. Because run-wide
   `requireToolApproval: true` would suspend EVERY tool call on the resumed leg,
   `resolveResumeApprovalGate` (`attempt-legs.ts`, moved out of `agent-streaming.ts`
   by BST-1649) substitutes the FUNCTION form of
   the gate backed by the rebuilt runtime's authoritative `askTools` set. Allowed
   read/internal-state tools keep running, ask-gated mutations may suspend again,
   and the canonical Mastra internal ids (`internal-approval-exempt-tools.ts`:
   `updateWorkingMemory`/`setWorkingMemory`) remain explicitly exempt — as are
   the SELF-APPROVING suspending tools (BST-1097), but ONLY from the ASK-SET
   half: re-gating one there would make Mastra consume its `{approved}` resume
   before the tool sees it, so the tool re-runs with no resume data and
   suspends Gate A again — an approval loop that can never complete. The
   EXPLICIT GLOBAL posture still gates them: with `permissionEnforced ===
   false` there is no snapshot, the injected decision resolves `'allow'`, and
   the in-tool gate is inert — exempting them there would make run_python the
   one execute-risk tool a global approval request never prompts for (and the
   loop cannot occur, because the inert self-gate never re-suspends after the
   framework consumes the approval). The symmetric transport rule also
   holds: `streamMastraToolResumeAction` verifies via
   `assertResumedCallIsSuspendPause` that the targeted call is suspended on a
   PLAIN `suspend()` pause (`requiresApproval === false` in the snapshot) —
   a generic resume payload must never answer an approval pause, mirroring
   `readResumedApprovalToolCall`'s `requiresApproval === true` requirement in
   the other direction. An EMPTY
   `askTools` on the resumed leg is AMBIGUOUS and is disambiguated by the
   runtime's `permissionEnforced` flag (`permissionSnapshot !== undefined`),
   NOT by `askTools.size` alone:
   - **A policy WAS enforced (`permissionEnforced === true`) but resolved nothing
     to `'ask'`** — every remaining tool is ALLOWED, e.g. after "Allow all tools
     this session" grants all four categories (denied tools were already omitted
     from the map). This is an all-allowed posture: the resume gate gates
     NOTHING, so a later mutation tool in the SAME resumed run is NOT re-prompted.
     (Without this, granting all categories then approving re-prompted every
     subsequent tool — the opposite of "allow all this session".)
   - **No policy was enforced (`permissionEnforced === false`) yet the caller set
     run-wide `requireToolApproval: true`** — a genuine explicit GLOBAL approval
     request (the pre-permission-engine behavior); the resumed leg keeps gating
     every non-internal tool.
   Per-tool DENY still wins in both cases: a denied tool never enters the gated
   map, so it never reaches the resume gate. A non-empty `askTools` always gates
   exactly the ask set regardless of posture.

THE PAUSE IS ALSO A DURABLE ROW (BST-1402). Every approval pause writes a
`tool.approval.requested` run event to `brainstrike_assistant_run_events`
carrying the paused call's `toolCallId`. It exists so a LIST-WIDE question —
"which threads are waiting on me?" — can be answered in SQL: rediscovering
pauses from Mastra's suspended-workflow snapshot is a per-thread round trip and
cannot be run for a whole thread list. Its consumer is the Threads panel's
"needs you" projection (`use-threads-awaiting-approval.ts`, one resource-scoped
live query; see `docs/agents/assistant-persistence.md` § THREAD GROUPS). Two
properties of that row are load-bearing:
- RESOLUTION IS DERIVED AND RUN-AGNOSTIC. Nothing marks the row answered. A
  pause is resolved by the LATER existence of `tool.started` / `tool.completed`
  / `tool.failed` / `tool.resume.unsupported` for the SAME
  `metadata->>'toolCallId'`. PAIRING is on that id and never on `run_id`: the
  approve/decline resume is a SEPARATE leg that mints its own `runId` and its
  own `thread_runs` row, so the event that answers a pause always carries a
  different run id than the pause. `tool.started` counts as resolved here (a
  tool that started was approved) even though the run-timeline derivation does
  not treat it as terminal — the two ask different questions, which is exactly
  why `tool.started` needs an ORDERING guard the three terminals do not: the
  approval gate runs inside `toolCallStep`, so the PAUSING leg already emitted
  a `tool.started` for that same call before the pause row. The guard compares
  `occurred_at` (`sequence` is per-run and meaningless across the two legs).
  The SQL, the guard, and the producer shapes that make it load-bearing are
  specified once in `docs/agents/assistant-persistence.md` § THREAD GROUPS — do
  not restate the rule here. Two earlier restatements each drifted: one into the
  opposite ruling ("no ordering guard is needed"), and one into a run-scoped
  guard that a step with two gated calls defeats.
- IT DELIBERATELY IGNORES `thread_runs.status`. A leg that pauses for approval
  finishes with `finishReason: 'tool-calls'`, which every terminal writer
  records as `completed`, so a `status = 'running'` join would make the
  projection permanently EMPTY while the user's obligation and the suspended
  Mastra snapshot both outlive that row. For the same reason the startup
  run-reap does not gate it.
- AN ABANDONED PAUSE STAYS LIT (BST-1417, known). The only thing that clears
  the glyph is an outcome event for that `toolCallId`. A pause the user never
  answers — and whose suspended snapshot is later discarded — leaves the row
  unresolved forever, so its thread keeps the "needs you" glyph with no pause
  left to answer. Lighting it is the safe direction (never silently drop an
  obligation), but it is a real dead end, not a design intent to defend.

APPROVAL ACTION MESSAGES ARE BOOKKEEPING, NOT CONVERSATION: clicking
Approve/Decline (and the suspend notice's Approve/Reject/Answer) appends a user
message whose `metadata.custom` + `runConfig.custom` carry the action under
`TOOL_APPROVAL_RUN_CONFIG_KEY` / `TOOL_SUSPEND_RUN_CONFIG_KEY`, with an echo
text ("Approved <tool>." / "Approved the plan."). Approval actions are a strict
wire object: exactly the own keys `action`, `runId`, `toolCallId`, and optional
`toolName`; the two required ids and any present tool name are non-empty and
bounded by the shared 512-character approval-transport constants. Suspend
resume actions mirror that exact-own-key and identifier contract for
`resumeData`, `runId`, `toolCallId`, and optional `toolName`; only the
`resumeData` value stays tool-defined for Mastra's resume schema. Extra own or
inherited fields, blank identifiers, and oversized identifiers are malformed.
Every Desktop and Hosted Web boundary parses BOTH continuation kinds before
dispatch: either malformed action returns the corresponding
`invalid_tool_approval_action` / `invalid_tool_resume_action` HTTP 400, and two
valid actions return `conflicting_tool_continuation_actions` / HTTP 400. Hosted
Web deliberately has no tool registry or durable Mastra workflow store: both
the Vercel Preview function and Vite dev/preview return
`tool_approval_unavailable` / HTTP 409 for a valid approval/decline action and
`tool_resume_unavailable` / HTTP 409 for a valid suspend-resume action. This is
identical in local Vite and Vercel Preview so a long-lived dev process cannot
advertise continuation behavior that fails when Vercel routes the next request
to another instance. The deployable Vercel wrappers fail closed outside Preview
as `production_auth_required`; public production requires application
authentication plus distributed quota/cost controls. Hosted Web likewise
rejects every non-empty `Last-Event-ID` with
`stream_resume_unavailable` / HTTP 409 after enforcing the body-size bound;
process-local replay is not a distributed capability. Normal Web turns run
without workflow storage, so approval/suspending tools remain fail-safe omitted.
Before any Vite dev/preview assistant route reaches those contracts, its
developer-key boundary requires a loopback TCP peer, a `localhost`/loopback
`Host`, same-origin browser provenance (while permitting no-`Origin` loopback
CLI calls), and `application/json` on POST. Boundary failures are typed 403/415
responses and drain the incoming request; they never fall through to Vite or
touch the assistant runtime. Vercel entrypoints use their separate deployment
boundary rather than this local socket check.
That message is THREAD-STATE ONLY:
- The panel renders it as a compact outcome chip
  (`approval-action-chip.tsx`, `data-testid="approval-action-chip"`), never a
  prompt bubble — BOTH marker kinds: per-tool approvals ("Approved
  <tool>"/"Declined <tool>") and suspend resumes ("Approved/Rejected the plan"
  with a feedback note, "Answered: <truncated answer>"). The recognizers are
  STRICT (canonical contract guards + only the resumeData shapes the suspend
  notice actually produces); an unrecognized/malformed marker falls through to
  the ordinary bubble — content is never hidden behind a guessed chip. The
  message stays in thread state so the notices' outcome locking
  (`resolveApprovalRunOutcome`/`resolveSuspendRunOutcome`) and the resume
  `runConfig` keep working.
- The shared transport (`data-stream-runtime.ts` `run()`, both apps) excludes
  action messages (BOTH keys — `approval-action-message.ts` is the single
  recognizer) from EVERY outbound payload BEFORE
  `selectTransportMessagesForMastraMemory`, so a regenerate-after-approval leg
  anchors on the previous REAL user message instead of the echo, and
  non-memory full-history resends never replay it. Action legs themselves
  (runConfig carries either key) ship `messages: []` — the desktop and web
  resume routes read the action from `runConfig` and ignore messages. The
  transport recognizer uses the SAME strict contract guards as the chip
  (`isAssistantToolApprovalAction`/`isAssistantToolResumeAction`, keyed per
  run-config key), NOT a loose "is a record" check: wire-exclusion and
  chip-rendering MUST agree on what an action message is. A
  record-but-structurally-invalid marker (e.g. `{}`) is NOT an action — the chip
  renders it as an ordinary bubble, so the transport keeps it on the wire rather
  than silently dropping a user-visible prompt (no-silent-fallbacks). Proof:
  `data-stream-runtime.test.ts` ("keeps a record-but-INVALID … marker on the
  wire").
- Mastra never persists the echo (neither resume path passes messages), so it
  is absent after reload — restart-safe rediscovery owns the post-restart UI.
  Pinned live in `mastra-tool-approval-suspend.integration.spec.ts`
  ("never persists an approval action echo").

NAME-FORM CONTRACT (settled — the rediscovery live bug class): Mastra registers
tools under SANITIZED ids (`brainstrike.executeCommand` → `brainstrike_executeCommand`,
see `tool-sanitizer.ts`) and its stream parts + suspended-run snapshots carry
that registered id. Every CLIENT-FACING approval surface, though, is keyed by
the ORIGINAL dotted name: `riskByTool` (`buildNativeToolRiskMap`), per-tool
overrides (`setToolOverride` from "Always allow"), and the notice label. The
bridges:
- `askTools` stays SINGLE-keyed by sanitized id (dual-keying would inflate
  `askTools.size`, corrupting the empty-ask-set posture check in
  `resolveResumeApprovalGate` — disambiguated by `permissionEnforced`, see above —
  and duplicate the gate's per-tool logs — do not
  relitigate). `resolveAskToolMetadata(askTools, name)` (permission-tool-gate.ts)
  resolves metadata under EITHER form: `get(name)` first, else a scan over
  `meta.originalName`.
- `makeApprovalRequiredChunks` uses that lookup; the emitted chunk's `toolName`
  is always the ORIGINAL name — resolved as
  `sanitizedNameMap?.get(raw) ?? denormalizeNativeToolName(raw)`, the SAME
  MAP-WINS order as `resolveDiscoveredApprovalToolName`,
  `listSuspendedMastraRuns` (below) and `ProjectionSafeToolCallFilter`
  (`projection-safe-tool-call-filter.ts`). The runtime `toolNameMap` is
  AUTHORITATIVE — it is the only layer that can bridge MCP names — and the
  static native reverse map is only the fallback for a route whose runtime
  registered no natives: `apps/desktop/src/ipc-agent.ts` streams with NO
  `tools`, so a native pause there has no map entry and would otherwise label
  the notice `brainstrike_executeCommand`.
  **ORDER IS LOAD-BEARING, do not "simplify" it to
  `denormalizeNativeToolName(map.get(raw) ?? raw)`** (settled on #1987 review):
  `sanitizeTools` records `map.set(uniqueName, name)` UNCONDITIONALLY, including
  the identity case, so a tool registered under the literal underscored id
  `brainstrike_executeCommand` maps to ITSELF — denormalizing a successful hit
  would rewrite that authoritative original to `brainstrike.executeCommand`,
  mislabelling the notice and submitting the wrong id to per-tool grant
  handling. (A colon/dot original like `brainstrike:executeCommand` is NOT
  affected either way: the map VALUE is not a key of the reverse map.)
  `makeUnsupportedApprovalChunks` (the malformed-pause termination, whose
  tool-event `name` + `run.failed` `toolName` are the only names the user sees)
  resolves identically. Proof in `mastra-tool-approval-chunks.spec.ts`: the two
  "denormalizes a native … no sanitized name map entry exists" cases pin the
  FALLBACK half, "keeps a MAPPED approval tool name authoritative even when it
  looks like a sanitized native id" pins the ORDER, and "passes an underscored
  NON-native approval tool name through unchanged" pins that the fallback never
  fabricates a dotted name by blind `_`→`.` swap.
  A policy-driven
  pause (non-empty `askTools`) whose tool resolves under NEITHER form still
  surfaces the pause but omits `riskCategory`/`policyDecision` (never
  fabricated) and logs `logger.error` code
  `mastra_agent_approval_metadata_unresolved`.
- `listSuspendedMastraRuns` maps each discovered `toolCall.toolName` back to the
  original: the discovery runtime's `toolNameMap` first (tools registered), else
  the static native reverse map (`denormalizeNativeToolName` — this is what
  makes the desktop KEYLESS discovery route resolve natives), else the
  registered id passes through with `logger.warn` code
  `mastra_agent_suspended_tool_name_unmapped`. The desktop route then warns with
  `assistant_suspended_approval_risk_unresolved` when a rediscovered approval
  still has no risk category (honest degradation: no reason line, no grant
  buttons). Live proof: the dotted-id cases in
  `mastra-suspended-runs-discovery.integration.spec.ts` and
  `mastra-tool-approval-suspend.integration.spec.ts`.
  KNOWN DISPLAY GAP (documented follow-up, NOT a bug): on the KEYLESS discovery
  route (empty `toolNameMap`) an MCP tool falls through BOTH maps —
  `denormalizeNativeToolName` only reverses KNOWN NATIVE ids, and MCP sanitization
  is not safely reversible (an underscore in an MCP server/tool name could be
  original, so a blind `_`→`.` swap would FABRICATE a wrong dotted name — a
  no-silent-fallbacks violation). So a rediscovered MCP approval displays its
  sanitized id (`someServer_someTool`, not `someServer.someTool`). Display-only:
  MCP is absent from the native risk map, so grant actions are correctly absent
  anyway, and the pause still surfaces for approve/decline. A future fix would
  persist the MCP name map alongside the suspended run.

Migration (enforce-on is a SECURITY fix): the store bumps to v2. Under v1,
`false` was the default AND always persisted, so a pre-v2 `false` slice is
indistinguishable from an opt-out — `migrate` adopts the secure default (`true`)
for ANY pre-v2 slice (a genuine v1 opt-out gets re-prompted once, the safe
direction). Only a v2+ persisted boolean is honored verbatim. Skipping this would
leave upgrading `enforce:false` users with the now-always-registered, ungated
`executeCommand` — the regression this guards against.
The store also sanitizes every current-version hydration through the shared
persist merge: malformed `enforce`/`yolo` values take secure defaults, invalid
policy and override entries are dropped/defaulted, and persisted action-shaped
keys or `sessionGrants` never enter live state. The merge returns live state
unchanged when no persisted snapshot exists and preserves the session-only grant
set across a late hydration.

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
Other initialization failures return only a safe stage
(`provider_model_bootstrap` or `stream_construction`) plus a correlation id;
the structured main-process log retains the same pair and the redacted error.

---

## WORKSPACE-ROOT AUTHORIZATION

Desktop workspace tools authorize filesystem access only from
`RuntimeData.workspaceRoots`, populated server-side from live path-backed rows in
the `roots` table. `workspaceRootPath`, `mainRootPath`, and related renderer
fields are selection or ordering hints; they never synthesize an authorized
root. A successful empty DB query records `workspaceRoots: []`. A failed query
leaves the inventory absent, and root resolution fails closed and visibly rather
than falling back to a renderer-provided absolute path. Focused selection and
Tapestry reads must match exactly one entry in the same authoritative inventory.

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
  (`runtime-assembly/tool-pipeline.ts`, called from `agent-runtime.ts`). Permission runs downstream of `execute`, so **hooks
  REFINE, never widen**: a PreToolUse hook can BLOCK a permitted tool but can
  never allow a denied/ask tool. A block returns a `HookBlockedToolError`
  (`error.code:'tool_blocked_by_hook'`, recognized by `isGuardedToolError`) so it
  renders as a FAILED tool event. PostToolUse `additionalContext` is capped
  (`HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET` 2000) and carried beside the original
  result in the explicitly discriminated internal hook envelope. The reserved
  JSON shape is NOT sufficient proof of provenance: every consumer also
  requires membership in a private in-memory WeakSet, registered only after a
  successful PostToolUse hook. A native/MCP result that copies the reserved
  field/kind or reflective object properties is ordinary visible domain
  evidence and can never inject model-only context or be stripped from
  UI/persistence. Losing the in-memory provenance through cloning or
  serialization likewise fails closed as visible data. Mastra's target-aware
  display/transcript transforms restore the exact domain result before the live
  UI and persistence boundary; the trusted envelope itself is never a public
  or durable tool result. Because JSON persistence and Mastra's
  transform protocol cannot represent an exact `undefined` result, a tool that
  returns `undefined` while PostToolUse requests context fails visibly instead
  of dropping the guidance or substituting a placeholder. The later
  model-projection seam consumes that reserved envelope: domain projectors
  receive the clean original result, and the provider view gets centrally
  composed context within the final model-output budget. A hook-runner FAULT is
  allow-on-fault (a runner bug must not brick tool calling).
- `UserPromptSubmit`/`Stop` run in `packages/assistant-service/src/stream-init.ts`
  (`initializeAgentStream`). A UserPromptSubmit block short-circuits the turn with
  a visible message + `run.failed` and NEVER invokes the model; additionalContext
  prepends a `system` message. The blocked branch returns an `ok:true` stream but
  carries `terminalStatus:'failed'` (+ `terminalError`) on `AgentStreamSuccess`, so
  ``runAssistantTurn` (packages/assistant-service/src/run-turn.ts, since BST-972 B3)` persists the `thread_runs` row as `failed` — never
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
(`packages/app-state/src/stores/hook-trust-store.ts`, persisted,
factory-reset-registered) records `{rootId → {approvedSha256, approvedAt}}`. The
store resolves its platform storage through a local deferred state-storage
proxy, preserving the `persist` API across optimized chunk cycles and retrying
resolution on a later hydration without defaulting trust open. The
renderer only ATTESTS approved hashes over the wire (`HookTrustRequest`); the
server independently RE-READS + RE-HASHES disk (`trust.ts` `resolveTrustedRoots`)
and runs a root's hooks only when `sha256(disk) === approvedSha256`. The trust
hash is over the RAW file BYTES (`sha256OfBuffer`), and the approve-time review
(`ipc-hooks-handlers.ts`) hashes those same bytes — never a utf8-decoded string,
which would diverge for BOM/non-utf8 bytes and silently void an approval. Trust
+ parse come from ONE read (`loadHooksConfig` reads the bytes once, hashes them,
and parses those same bytes only when trusted — no read-vs-hash TOCTOU window). A
changed file → untrusted (re-approve). A project config's descriptor is accepted
only after a nonblocking open proves it is a regular file of at most
`MAX_HOOKS_CONFIG_BYTES`; its initially observed bytes are the only bytes read.
The loader and approve-time review share this reader, so oversized/special files
produce a visible error before hashing. Keyed by durable `rootId`, never raw path.
Stdin payloads are secret-redacted before spawn (`executor.ts` `redactSecrets`,
mirrors the logger redact key set). The hook keeps ordinary parent shell/runtime
variables, but `createCredentialIsolatedChildEnvironment` removes every provider
and Tavily credential name derived from the same canonical registries used by
desktop environment-file loading before hooks and non-interactive command/skill
children spawn. This boundary is required even for SHA-256-approved project
hooks: approval authorizes the reviewed command, not ambient disclosure of
unrelated Brainstrike credentials. Scope: interactive terminal/command-session
PTYs and the LSP child still inherit the full parent environment; those
human-controlled/runtime-support processes are separate trust decisions.

**Config paths (D6):** global `~/.brainstrike/hooks.json` (new home-dotfile, for
discoverability); per-root `<root>/.brainstrike/hooks.json`. Merge order:
global-first, then roots in mounted order; each loaded hook is tagged with its
source `cwd`/`rootId` (global hooks' cwd = the MAIN root — client-declared
`activeRootIds[0]`, `created_at` fallback; see "WORKSPACE ROOT IDENTITY" in
`docs/agents/workspace-context.md`).

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
- **`assistant_message` stdin (BST-1251)**: `withStopHook` accumulates the
  RUN's assistant text — every generation step's `text-delta` chunks, with a
  `\n` inserted at step boundaries (any non-text chunk) so line-anchored
  graders never see step N's tail glued onto step N+1 — and hands Stop hooks
  a 64 KiB TAIL (`ASSISTANT_MESSAGE_TAIL_CHARS`; an acceptance hook grades
  the END of the final answer). The trim is amortized (only past 2× the
  bound; exact tail cut once at Stop), omitted entirely when the stream
  produced no text, and never grows unbounded with the stream.
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
  (assistant-server/run-persistence.ts) upserts `brainstrike_assistant_run_outcomes` via the
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
adapter rootId is the durable identity of a persisted mount and is reused when
the same canonical folder is picked again, while the DB id identifies the
retained indexed row. They are separate identity domains and MUST NOT be assumed
equal. The server keys trust by the DB id (its roots come from the DB
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
  fail closed. The disconnect-severs property is additionally SERVER-ENFORCED:
  `fs:removeRoot` asks the main-process `WorkspaceRootRegistry` to remove the
  mount and converge the DB to the complete remaining mounted-path set. The
  persisted registry write happens first, but a DB failure rolls it back before
  the IPC rejects; the capability and renderer projection remain mounted. Every
  server-side consumer of `loadWorkspaceRootsFromDatabase` (workspace tools,
  hooks review containment, context-files scan, user /commands, checkpoint
  revert) serves only `status='live'` rows. `reconcileRoots` (app-shell)
  restores `status='live'` on remount — it path-matches the KEPT row, so
  disconnect ≠ delete and a re-add resumes without re-indexing
  (`workspace-roots.integration.test.ts` proves the full cycle). The renderer
  attestation scoping above remains as defense-in-depth: a renderer that skips
  scoping can at most re-run byte-identical already-approved hooks, never new
  content (same-process trust model + the server's authoritative disk re-hash).
- CONVERGENCE (do not relitigate): `WorkspaceRootRegistry` serializes add,
  restore, preference, and disconnect transitions. `rootsList` is its persisted
  mount inventory; only successfully mounted, persisted presentation paths are
  supplied to `markRootsDisconnectedExcept`. An EMPTY mounted set is meaningful
  and demotes every comparable path-backed row. Web FSA rows remain outside this
  desktop comparison.
- Restore never guesses. Malformed `rootsList` JSON or shape THROWS before DB
  convergence. A missing or transiently unmountable folder remains persisted,
  is returned as `permissionState:'unknown'`, and is excluded from the mounted
  DB authorization set until a later restore succeeds. Boot-time DB convergence
  remains allow-on-fault with an ERROR log so a transient DB failure does not
  erase the Explorer restore; explicit disconnect remains fail-closed with
  storage rollback.
- Renderer state is a projection. `removeRootDirectory` awaits the authoritative
  IPC transition and changes no renderer/store state when it rejects. The old
  best-effort compensation loop and independent `lastFolderPath` root writer no
  longer exist. `lastFolderPath` is only a preference for an already-persisted,
  mounted root.
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
wiring; Stop auto-continue; full hooks.json
editor UI; rendering the fetched `content` in-panel (approval is hash-only today);
a refetch on approve/revoke/refocus (a disk edit after the fetch shows a stale
badge until reopen — fail closed server-side); `<userData>` vs home-dotfile
decision.

When changing this flow, update this section and the paired tests.

---

## SYSTEM-INSTRUCTION COMPOSITION

`composeRuntimeInstructions` (`agent-runtime.ts`) assembles what the model
actually receives, in two halves that
`composeCacheAwareInstructions` keeps apart:

- **`stableText`** — the resolved instructions, the CURRENT-DATE note, and the
  context-budget note. Cached.
- **`volatileText`** — the task-list note. Re-sent each turn; never cached.

**THE DATE IS COMPOSED OUTSIDE THE PROVIDER BRANCH — do not relitigate.**
`buildCurrentDateNote` is joined into `stableText` alongside the budget note,
NOT threaded into `buildDefaultInstructions`. There are three supported
instruction paths — the hosted default, `buildLocalDefaultInstructions` for the
built-in local model, and a caller-supplied `instructions` override — and only
the first takes options. Injecting there left the other two shipping dateless
prompts; the local one arguably needs it most, since a small local model is the
least able to recover from not knowing the date.

Nothing in the prompt used to state the day. A model with no date does not
abstain — it substitutes its training cutoff or a guess. An observed run
reasoned "Today's date is unknown but likely later" and then wrote a fabricated
date, three days off, into DURABLE working memory. It is also load-bearing for
an instruction AGENTS.md already gives (treat dated material under
`docs/superpowers/` and `docs/archive/` as historical evidence), which is
unfollowable without a date to compare against.

**DATE ONLY, and LOCAL.** A clock time would invalidate the cached prefix on
every turn; a date moves at most once a day. And the day is the user's, not
UTC: Brainstrike is local-first, so the process clock IS the user's clock, and
`toISOString()` would state tomorrow's date to anyone east of UTC in their early
morning. The format is `en-CA` (whose short date IS ISO 8601) plus the weekday
name — `03/04/2026` denotes two different days depending on the reader.

The clock is INJECTED (`composeRuntimeInstructions({ now })`) so the composed
instructions stay a pure function of their inputs. The paired guard drives
`createMastraAgentRuntime` with frozen time and asserts the date reaches
`config.instructions`; asserting `buildCurrentDateNote` directly would prove
only that it renders a date it was handed.

## RUN-CREATION SEAM: WHAT MAY COMPOSE AROUND IT (BST-1115 W5 T4b)

`useAssistantRequestLifecycle.prepareRequestData` is the single place a run
comes into existence in the renderer: it calls
`createAssistantThreadRunPromise` → `repository.createThreadRun`, the SOLE
runId minting site (`docs/agents/assistant-persistence.md`). Features that need
to act "when a run starts" COMPOSE AROUND that callback in
`assistant-ui-panel-wrapper.tsx`; they never add a second producer and never
grow the lifecycle hook a feature-specific branch.

- **It fires for EVERY run, not every user message.** A tool-approval resume, a
  plan-mode continuation and a stream replay all reach it. Anything that must
  distinguish "the human sent something" needs a SECOND signal:
  `AssistantUiPanel`'s `onThreadRunStart`, which is the composer form's
  `onSubmitCapture` and fires for nothing else.
- **Neither signal is sufficient alone.** assistant-ui's composer input calls
  `form.requestSubmit()` on Enter unconditionally, so an Enter on an EMPTY
  composer fires `onThreadRunStart` and sends nothing (`useComposerSend()`
  returns null). The conjunction — a submit that is FOLLOWED by a run creation
  — is the only honest reading of "a user-authored message started a new run".
- **Conversation Rewind finalization is the first consumer.** `useRewindFinalization`
  holds a read-and-cleared arming flag: `markUserAuthoredSend` (wired to
  `onThreadRunStart`) arms it, and the wrapper's `prepareRequestData` wrapper
  consumes it after the run row exists. That is what ends the one-level redo
  window; see the FINALIZATION bullet in `assistant-persistence.md` for what
  the main process then does.
- **A composed effect MUST NOT be awaited by the send.** `finalizeAfterRunCreated`
  returns `void` deliberately — the send is what the user asked for, and a
  cleanup they did not ask for may never delay or fail it. Report failures
  (log + toast); never swallow them, and never let one reach the composer.
- **An abort that lands after run creation is not a send.** `prepareRequest`
  throws the abort reason once `prepareRequestData` resolves, so the wrapper
  re-checks `abortSignal.aborted` before firing a composed effect. The arming
  flag stays set, and the retry that actually sends fires it.

Paired tests: `assistant-ui-panel-wrapper-rewind-finalization.test.tsx` (the
wiring, including the never-settles and throwing-bridge cases) and
`changes/__tests__/use-rewind-finalization.test.ts` (each half of the
conjunction alone).

When changing this flow, update this section and the paired tests.

---

## PLAN MODE & TOOL SUSPENSION (ask-user / submit-plan)

Two SUSPENDING native tools pause the run DURING execution and resume with
arbitrary data, on a NEW transport that PARALLELS the approval transport (it does
not overload it). Built on `@mastra/core@1.55` tool `suspend()`/`suspendSchema`/
`resumeSchema` + `agent.resumeStream(resumeData, {runId, toolCallId})`
(re-verified at the 1.55 bump; 1.56 changes the approval half of this surface —
see the version ceiling in mastra-boundary.md).

- **`submitPlan`** (packages/agent/src/tools/submit-plan-tool.ts): takes a
  structured plan INLINE (`{title, overview, steps[], risks?, verification?}` —
  NOT an on-disk path like Mastra's builtin `submit_plan`), `suspend()`s with it,
  and on resume returns `{status, feedback?}`. Resume vocab is the builtin-
  compatible `{action:'approved'|'rejected', feedback?}` (SubmitPlanDecision).
- **`askUser`** (ask-user-tool.ts): `{question, options?, selectionMode?}`,
  resumes with the `{answer: string | string[]}` envelope (AskUserResumeData —
  an OBJECT so the 1.56+ `approved: true` rider attaches when askUser is
  ask-gated; a bare answer cannot carry the rider and would be denied by
  Mastra). The tool still accepts the LEGACY bare `string | string[]`
  (AskUserAnswer) so runs suspended before the envelope migration stay
  resumable; multi-select joins with ", ".

The renderer structurally narrows both tools' `suspendPayload` before displaying
or resuming it. An absent payload (`undefined` or durable JSON `null`) retains
the generic actionable fallback for legacy suspended runs. Core plan terms
(`title`, `overview`, and the steps array)
and the `askUser` question/options must be readable. Plan step titles and askUser
options are decision terms, so one unreadable entry makes the decision
unapprovable/unanswerable; unreadable advisory plan fields (`risks`,
`verification`, or a step `detail`) remain omitted. A present non-array option
list, an unknown `selectionMode`, or a selection mode without readable options
likewise makes the question unanswerable rather than silently changing its
interaction mode. An unreadable core payload renders a diagnostic failed alert
with a scrollable raw-payload view capped at 4,000 serialized characters. The
same bounded serialization is logged once per run/tool-call identity across
renderer remounts; the raw malformed object never bypasses that cap. The process-local
identity cache is capped at 64 entries with deterministic oldest-entry eviction;
tests reset it explicitly rather than depending on file order. The user may
safely reject an unreadable plan (never approve it). A readable question whose
choice controls drift remains an explicit failed alert, shows the bounded raw
payload, and offers a clearly-labelled free-text answer through the schema's
supported string arm; it never guesses a choice interaction. If the question
itself is unreadable there is no safe typed answer and no durable run event
explaining the dead end, so its alert remains visible and cannot be dismissed or
answered.

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

**Stream path** (`mastra/tool-approval-chunks.ts`, dispatched from
`agent-streaming.ts`): Mastra emits `tool-call-suspended` when a
suspending tool calls `suspend()`. `makeToolSuspendRequiredChunks` turns it into
a resumable `tool-suspend-required` chunk + a tool-calls finish and STOPS at the
pause (this replaced the old `makeUnsupportedApprovalChunks` dead-end at ~936).
A native OpenRouter pause finish has zero tokens and no billed-cost field because
Mastra has not exposed that step's `step-finish` yet. Resume emits the deferred
step finish before continuing, so the resumed terminal finish aggregates the
pre-pause and subsequent step costs.
A malformed pause (missing toolCallId/runId) still falls back to the unsupported
termination so it fails visibly.

**Unknown resume schemas are REJECTED VISIBLY and NON-TERMINALLY (BST-558):** only
tools listed in `REGISTERED_SUSPEND_RESUME_TOOL_IDS`
(`@brainstrike/assistant-contract/tool-suspend` — today `askUser`, `runPython`
(the BST-1070 Gate B network escalation), and `submitPlan`) have a registered
typed suspension UI. A well-formed pause from any OTHER tool
still becomes a `tool-suspend-required` chunk, but
`makeUnregisteredSuspendResumeNoticeChunk` PREPENDS a durable
`tool.resume.unsupported` run event
(`UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND`; `unregisteredResumeSchema:true` +
`resumeSupportedByClient:false` + `runStillSuspended:true` + `suspended:true` +
the run/tool identifiers) and a coded `logger.error`. The tool-defined
`suspendPayload` is deliberately EXCLUDED from that durable metadata (run-event
metadata is allowlist-by-denial, not a content channel); it travels only on the
transient chunk.

**Its OWN run-event kind, never `tool.failed`.** `tool.failed` is consumed as a
METRIC in three places, all of which enumerate kinds explicitly, so the new kind
is excluded from each by construction:

| Consumer | With `tool.failed` | With `tool.resume.unsupported` |
| --- | --- | --- |
| `RUN_LEDGER_AGGREGATION_SQL` (`assistant-memory-repository.ts`) | +1 `toolCallCount` AND +1 `failedToolCallCount`, permanently — and when a later build resumes the same pause its real `tool.completed` counts the ONE call twice | not matched by either `FILTER` |
| `collectToolDurations` (`tool-durations.ts`) | closes the `tool.started`→terminal pair, inventing a duration for a tool that never finished | kind not in its allowlist; no duration recorded |
| `getMatchingFailedKind` (`assistant-run-event-derivation.ts`) | resolves the `tool.started` row to `failed` | only `tool.failed` resolves it; the row stays `running`, which is TRUE — the tool IS still suspended |

No tool ran and none failed: this is a CLIENT CAPABILITY MISMATCH. Recording it
as a failed tool call would contradict `runStillSuspended: true` in the event's
own metadata.

**No `tool.failed` is emitted upstream either — verified against the live loop,
do not relitigate from the comment alone.** `data-stream-mapper.ts` carries a
line deleting the suspended call's `pendingToolErrorTexts` entry, added in #1606
against @mastra/core 1.50 (behavior unchanged at the pinned 1.55) when Mastra reported `suspend()` through the
`tool-error` path BEFORE the correlated suspension event. If that ordering still
held, `makeToolLifecycleRunEventChunk` would convert the earlier part into a
durable `tool.failed` and every claim in the table above would be void. It does
not hold on @mastra/core 1.51: a real `suspend()` emits no `tool-error` at all.
The observed durable sequence for an unregistered pause is `run.started` →
`run.step.started` → `tool.started` → `tool.resume.unsupported` →
`tool-suspend-required`. That is pinned by live-loop assertions (real Agent +
real PGlite) in `mastra-tool-suspend-resume.integration.spec.ts`, not by a
synthesized `tool-call-suspended` part — so a Mastra bump that reinstates the
old ordering fails there instead of silently re-polluting the ledger. The
mapper's delete stays as defence in depth; it is NOT evidence of current
behaviour.

**Tool-call args-stream discipline (BST-940 field failure, 2026-07-27).** The
renderer's assistant-stream decoder closes a call's argsText controller on the
complete `9` frame and THROWS in strict mode (the default) on a duplicate tool
call id or on a `c`/`a` naming an id it never saw. GLM-5.2
via OpenRouter emits trailing `tool-call-delta` parts after the complete tool
call and after the result. `data-stream-mapper.ts` therefore (1) emits the `c`
args-delta frame only while `toolState` exists AND `argsEmitted` is false, and
(2) tracks `settledToolCallIds` so a late progress event for a settled call is
dropped instead of auto-starting a duplicate `b`. Pinned by the "drops trailing
args deltas" case in `data-stream-session.spec.ts`.

Guard (2) is pinned by that still-live duplicate-id throw. Guard (1) changed
severity at assistant-stream 0.3.35: appending into a CLOSED controller used to
be an unhandled TypeError that failed the whole run, and is now dropped behind a
one-shot `console.warn` (see the BST-962 paragraph above). The guard stays —
silently discarded args are still a correctness bug, just no longer a visible
crash, which makes the guard MORE valuable, not less, because the failure it
prevents is now quiet.

Mastra's dynamic `data-om-*` stream chunks are handled by prefix in
`agent-streaming.ts`: `-failed` variants map to a durable
`memory.observation.failed` run event (they were the only runtime evidence of
the field failure); other OM bookkeeping is deliberately silent (Mastra
persists it itself) and never trips the unrecognized-chunk warning.

**Durable AND always visible.** The `brainstrike.tool-suspend` data part is
transient (aui-data, never persisted), so after a reload the notice is gone. The
run event is persisted to `brainstrike_assistant_run_events` and rehydrated as a
run-event data part, and `tool.resume.unsupported` is in
`isAlwaysVisibleRunEvent`, so the row renders at the DEFAULT (`standard`) detail
level, not just Developer.

`isAlwaysVisibleRunEvent` alone is NOT sufficient, and this is a settled ruling —
do not relitigate it by reverting the exemption. It only selects which component
renders the row; BOTH paths then consult the render plan, whose first suppression
rule (`hasToolCallPartForEvent` in `resolveAssistantRunEventRenderPlan`, mirrored
by `hasToolCard` in `initialRenderPlanKey`) hides ANY `tool.*` event whose
`toolCallId` has a `tool-call` part in the thread. `tool.resume.unsupported` is
the first `tool.*` kind ever added to the allowlist, and
`handleToolSuspendRequired` GUARANTEES that part exists for exactly that id — so
without an exemption the row would be hidden at every detail level. Both
functions therefore skip card suppression for always-visible kinds. The rule
still applies to every other `tool.*` row, because those genuinely duplicate a
status their card owns; this row does not (the card reports a client capability
error for one call, the row reports that the RUN is still suspended). Any test
covering this MUST put the mapper's `tool-call` part in the mock thread — a
fixture with only the run-event part is a shape the emitter cannot produce and
passes vacuously. `run.failed`/`run.cancelled` never needed the exemption: they
carry no `toolCallId` and are not `tool.*`.

`kind` is a plain `text` column (no CHECK/enum), so
the new kind needs no migration — but the read-path `requireRunEventKind` throws
on an unknown kind and `listThreadRunEvents` maps the whole list, so DOWNGRADING
to a build predating this enum entry fails that thread's entire run-event
hydration. Enum and emitter ship together here (same build reads what it wrote);
the constraint is one-directional and only bites on rollback.

**The tool card is SETTLED.** `handleToolSuspendRequired` emits a `tool-call`
part so the pause has a card; for a registered tool the missing result is
correct (resume supplies it), but for an unregistered one nothing ever will, so
the chunk carries `resumeSupported: false` and the mapper emits a terminal
`toolCallResult` with `isError: true`. Without it, dismissing the notice — the
only actionable control — would leave a permanently Running, unactionable card.
It is deliberately NOT recorded in `pendingToolErrorTexts`: that would append
"I couldn't complete the tool action because it failed" and mark the step
errored, both false.

**The APPROVAL DECLINE is the second terminal under that same rule (BST-1282,
@mastra/core 1.59 `tool-output-denied`).** It arrives as its own tool-event
status, `'declined'`, and `handleToolDeclined` settles the call — `toolCallResult`
+ `settledToolCallIds`, because a declined call left pending is a permanent
spinner — while recording NOTHING in `pendingToolErrorTexts` and setting no
`isError`. `pendingToolErrorTexts` clears only on a following `text-delta`, so an
error-path decline emitted the false sentence above whenever the model added no
visible text after the denial, or the user pressed Stop. The frame instead
carries the shared `DeclinedToolCallResult` envelope (`{kind: 'declined',
message, reason?}`), which is what `tool-fallback.tsx` reads to render the muted
`stopped` treatment: a settled result with no envelope earns a green Completed
for a tool that never ran, and `isError` paints destructive Failed chrome over
something that never broke. The two terminals differ only in what they say about
the RUN — this one is over (durable `tool.failed`, relabelled "Tool call
declined"), the resume-unsupported one is still suspended.

It is deliberately NOT the `makeUnsupportedApprovalChunks` idiom (`run.failed` +
error finish). **Mastra persists the suspended workflow snapshot BEFORE the
stream part is mapped**, so terminating the client stream removes nothing:
`listSuspendedRuns()` still returns the run and a later resume can revive it. A
durable `run.failed` claiming the run "was stopped" would be false. Leaving the
run suspended is INTENDED — a build that later registers the tool's resume UI can
still answer the same pause. `makeUnsupportedApprovalChunks` stays terminal
because a MALFORMED pause (missing toolCallId/runId) genuinely is unrecoverable.

`toolName` is resolved as `denormalizeNativeToolName(sanitizedNameMap?.get(raw) ??
raw)` — the same map-then-static-reverse-map order as
`resolveDiscoveredApprovalToolName`. The real stream part carries the SANITIZED id
(`brainstrike_askUser`) and `sanitizedNameMap` is optional at every call site, so
resolving on the dotted form alone would reject a perfectly resumable pause.

Previously such a pause rendered a generic "Waiting on input" card with no error
surface — a silent dead end. The renderer's `UnsupportedSuspendNotice` is the
matching surface: still no guessed typed action (no-silent-wrong-render), but a
`role="alert"` card that says the pause cannot be answered by this build, with a
Dismiss control. Its copy claims nothing about server-side state, because it must
also be true in a version skew where an older client renders a newer tool's pause.
`AssistantToolSuspendNotice` dispatches through a total
`Record<RegisteredSuspendResumeToolId, …>`, so adding an id to the registry
without a typed branch is a COMPILE error. `SUSPENDING_NATIVE_TOOL_IDS`
(plan-mode-tool-gate.ts) is DERIVED from the same registry. The REVERSE drift (a
tool that can `suspend()` with no registered resume UI) has no compile-time
guard, so `scripts/__tests__/suspending-tool-registry-contract.test.mjs` scans
source RECURSIVELY, comment-stripped, on the loose token `\bsuspendSchema\b` so
the `{ suspendSchema }` shorthand and a spread of a shared config object both
count. Two scopes, because the token alone cannot tell a DECLARATION from a
consumer that merely reads the property:

- the two declaration roots — `packages/agent/src/tools` (defined) and
  `apps/desktop/src/assistant-server` (registered, and it defines tools of its
  own) — drive an exact match against `REGISTERED_SUSPENDING_TOOL_MODULES`;
- a repo-wide sweep of `apps` + `packages` must equal that set plus an explicit
  `ACKNOWLEDGED_NON_DECLARING_MODULES` list (today just `plan-mode-tool-gate.ts`,
  which READS the property to detect suspending tools structurally).

The sweep exists because the root list was itself unguarded: `walkTypeScriptFiles`
swallows a missing directory, so a suspending tool in a NEW package, or a renamed
root, would have silently stopped being covered while the exact match still passed
on whatever the other root contained. Every scan root is additionally asserted to
exist and be non-empty. Known limitation, deliberate: `stripComments` has no
string-literal awareness, so a `suspendSchema` token after a `//` inside a string
on the same line is missed. It is control-tested in the same file against
subdirectory, shorthand, desktop-root, outside-every-declaration-root,
renamed-root, comment-only, and test-file fixtures. It lives in `test:scripts`
rather than a package spec because a package-scoped vitest reading a foreign
package's source is an unhashed turbo input (stale-green cache landmine).

`DataStreamMapper.handleToolSuspendRequired`
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
`createMastraAgentRuntime`'s tool pipeline (`runtime-assembly/tool-pipeline.ts`): it keeps risk ∈ {read, mcp} and
OMITS every edit/execute tool, so the model investigates read-only and proposes a
plan before any changes. **A suspend schema is NOT an admission ticket
(BST-1073)**: the filter used to keep any suspending tool BEFORE consulting its
risk, which was safe only because `submitPlan`/`askUser` are both classified
`read`. It became a hole the moment a mutation tool needed to suspend —
`run_python` requires a suspend schema for its per-call network escalation, and
that would have admitted an execute-risk arbitrary-code tool into plan mode.
Suspending tools now survive on their risk classification alone; an
unclassified tool still falls to `mcp`, which plan mode keeps. `manageTaskList` (`riskCategory:'read'`) DELIBERATELY
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
drops edit / keeps submitPlan); the non-terminal unregistered-resume-schema
rejection, the sanitized-id-with-NO-sanitizedNameMap regression guard, and the
registered-tools-unaffected cases in `mastra-tool-approval-chunks.spec.ts`; the
settle-the-tool-card + leave-a-resumable-pause-open cases in
`data-stream-session.spec.ts`; plan-mode-tool-gate.spec.ts (registry derivation +
every real factory registered) and
`scripts/__tests__/suspending-tool-registry-contract.test.mjs` (the
control-tested reverse-drift scan); the ledger-aggregation and
run-event-hydration cases in
`packages/assistant-data/src/__tests__/assistant-memory-repository.integration.test.ts`;
the `isAlwaysVisibleRunEvent`, default-detail data-part, duration-pairing and
`tool.started`-stays-running cases in the UI timeline specs; the streaming +
data-part-continuity + default-instructions plan-mode specs; the desktop
assistant-server resume-dispatch tests; and the UI suspend-notice tests.

When changing this flow, update this section and the paired tests.

---
