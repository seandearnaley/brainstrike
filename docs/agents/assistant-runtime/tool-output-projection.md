# Raw/model tool-output split and projection budgets — evidence

Supports `docs/agents/assistant-runtime.md` § "ASSISTANT RESILIENCE (CRITICAL)".
Read before changing artifact settlement, `toModelOutput` projection, the token-calibration chunk, pre-request compaction, `ProjectionAwareTokenLimiter`, or `ProjectionSafeToolCallFilter`. BST-1206, BST-1219, BST-1232, BST-1655, BST-1095, and the 2026-08-23 ctx-explosion investigation.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 628-967), extracted verbatim.

**Raw/model tool-output split (LIVE):**

Persona children apply central artifact settlement after their own permission
gate and before projection at their own resolved model budget. Settlement
requires an eligible child reader and observed execution-thread identity;
ordinary native function tools expose that identity through Mastra's memory
RequestContext. Storage preserves root read authority while migration 129 keeps
sibling execution threads distinct, including reused native tool-call IDs.
The native desktop fixture reconstructs complete model-paged outputs and the
same content from hydrated envelopes after engine reconstruction.
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
