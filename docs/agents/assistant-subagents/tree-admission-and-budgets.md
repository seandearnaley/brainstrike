# Tree admission, refusals and per-child budgets — evidence

Supports `docs/agents/assistant-subagents.md` § "Recursive work admission and cancellation".

The BST-1751 start-admission ruling, the FIFO work queue, the user-settable child budgets, and the truncated-synthesis path.

Extracted verbatim from `docs/agents/assistant-subagents.md` lines 1716–1893 at commit 7c3eb8f38.

---

The root host owns invocation and output counters in migration 132. Host run,
resource, original turn and complete ancestry are validated inside the admission
transaction. Duplicate native admission does not consume another invocation;
deleting a child never refunds the root's spent allocation. Step reservations
survive database reload. A turn created before budget admission existed cannot
start fresh child inference or admit another sibling: the visible error asks for a new parent turn.
Existing invocation rows without their original budget must never seed fresh counters.

**Admission is answered at delegation START, and a refusal never kills the
root.** SETTLED 2026-09-14 (BST-1751). The durable checks (depth, invocations,
output summary reservation) used to run only inside `persist`, i.e. after Mastra
had started the child; a refusal there threw through the projection's
`authorize` and failed the root with the generic identity message while every
sibling was cancelled (thread-f6be9761). Now `DelegatedBudgetPort.admitInvocation`
(`delegated-tree-admission.ts`, `admitDelegatedInvocation`) evaluates the same
rules before any native child exists — it RESERVES nothing, but it does open
the root and the original turn's budget row idempotently and take the budget
row lock, so a turn whose first delegation is refused keeps an empty budget row
— and `createDelegationConfig` consults it in `onDelegationStart`: a refusal
returns `proceed: false` with the host's reason, which Mastra hands the model as
`[Delegation Rejected] …`. Only the deliberate budget refusals become that
answer; a database or schema fault propagates. A host identity refusal at start
(root not running, stopped ancestor, parent outside this root) is ALSO turned
into a rejection by the hook — nothing has run, so it costs one delegation,
never the root — while the host has already logged its reason; any other
failure propagates. The reservation at persist time remains the authority (the
same checks, now mutating), so a true sibling race can still refuse there — and
that refusal is non-fatal too: it runs inside the child's input processing,
before the child streams a single part, so the parent has nothing to bind and
Mastra turns it into that delegation's tool error (`subagent.failed`, no
`rejected` marker) while the root continues (scenario case "late reservation
at persist"). Two more rules make
any refusal survivable: Mastra streams a refused delegation's text through the
PARENT's writer under the parent's run id, so `resolveChildDelegation`
(`delegated-stream-projection.ts`) treats same-run-id nested output as not a
child stream and binds nothing; and every `DelegatedConversationIdentityError`
that escapes the desktop host is logged at error level with its bounded
`reason` (`delegated_conversation_identity_rejected`, method, host run) before
it propagates, so a debug pack names the refusing rule. The debug pack behind
the ticket showed 8 invocation rows for 8 counted invocations; the three
"missing" rows were admitted-but-never-bound (no child run id), not a counter
mismatch. Paired tests: `delegated-tree-limits.integration.test.ts` ("answers
admission at delegation start", "refuses a fourth descendant level"),
`delegated-conversation-host.integration.test.ts` ("logs the identity reason"),
`delegation-rejection.integration.spec.ts`.

The runtime shares a FIFO queue of two active model/tool operations across all
descendants. Model permits end before native tool/delegation execution; native
delegation waits do not acquire a permit. Up to eight child streams may be
admitted, while only two model/tool operations are runnable. The in-flight
backstop is disabled only when both the durable budget and shared queue exist.
Ordinary and deferred discovered tools
retain their native descriptors, projections, approval flags and guarded execution.
Synthesis forces toolChoice none and no active tools, and rejects a provider tool
call before execution even if the provider ignores that request.

**Child budgets are USER SETTINGS; a cut synthesis is a truncated completion.**
SETTLED 2026-09-15 (budgets plan, Workstream C; GLM pack 03-31-15Z; do not
relitigate). The four per-child allocations live in `RuntimeSubagentSettings`
(`assistant-contract/subagent-settings.ts`; defaults 32 steps / 2,048
synthesis / 32,768 child / 8,192 step; ranges in `SUBAGENT_SETTINGS_LIMITS`),
persisted by `assistant-subagent-preferences.v1`, edited in Settings → Models
→ Subagents (`subagent-settings-section.tsx`), sent on EVERY request as
`runtimeData.subagentSettings` (`buildAssistantRequestData`) and copied into
the turn's `brainstrike_delegation_budgets` row at first admission.
`parseRuntimeSubagentSettings` is the ONLY intake: absent → defaults, anything
else malformed → throws (the desktop host in `mastra-memory.ts` and the agent
runtime in `agent-runtime.ts` both call it). `DELEGATION_LIMITS` has no child
keys — a consumer reading a constant instead of the request's settings is a
compile error — and the admitted-configuration `maxSteps` ceiling is
`SUBAGENT_SETTINGS_LIMITS.maxChildSteps.max`. Read-only built-ins declare 32
steps; the effective budget is `effectiveChildStepBudget(persona, settings)`
and `delegationDescriptionForPersona` tells the model that number.

The host's synthesis reservation (`DelegatedStepReservation` with
`synthesis: true`) names its `cap` (`steps` / `child-output` / `tree-output`)
and the numbers behind it (`used` of `limit`, in that cap's unit). The budget
processor (`delegated-work-budget.ts`) sees Mastra's `finishReason` on
`processOutputStep`; on a synthesis step it records `{ cap, limit, used,
reservedOutputTokens, outputTokens, truncated: finishReason === 'length' }` in
the per-runtime `DelegatedSynthesisOutcomes` registry (keyed by native child
thread id) and streams the transient `data-brainstrike-delegated-synthesis`
part. Three readers, none of which can see the reservation:
`makeTerminalRunEvent` maps a `length` finish on a child whose synthesis was
TRUNCATED to `run.finished` / `outcome: 'truncated'` (a mid-run `length`, a
sibling's record, an untruncated synthesis and the root all still fail);
`onDelegationComplete` reads the REGISTRY (never the projected stream: the hook
runs before the parent consumer maps the child's parts), and
`resolveTruncatedAnswer` appends the `[Truncated summary]` note to `resultText`
— which Mastra applies on the foreground and background delegation paths alike
— and records the outcome, so the parent mapper emits `subagent.finished` with
`outcome: 'truncated'`; the projection turns the part into the persisted
`delegation.budget.exhausted` run event on the child conversation
(assistant-persistence.md, DELEGATION BUDGET EXHAUSTED KIND). Empty text stays
`no-answer` even when a synthesis was truncated. The delegation card reads
`outcome: 'truncated'` as "<persona> finished with a truncated summary" (amber
check, "Completed (truncated summary)"); the child tab header shows `steps N/M ·
used/limit tokens` from the durable child budget row
(`readDelegatedConversationInsights().budget`, refreshed at leg / pause /
terminal boundaries, not per token). Paired tests: `subagent-settings.test.ts`,
`personas.test.ts`, `delegated-persona-snapshots.spec.ts` (admitted ceiling),
`delegated-budget-settings.integration.test.ts`,
`subagent-settings-runtime.spec.ts`, `delegated-work-budget.integration.spec.ts`
("records a truncated synthesis outcome"), `delegated-synthesis-outcome.spec.ts`
(mutations: any recorded synthesis read as truncated; truncation resolved
before the empty-text check; the lifecycle outcome dropped),
`delegated-stream-projection.spec.ts` ("projects a synthesis part"),
`background-worker-policy.integration.spec.ts` ("a child whose synthesis is cut
returns a truncated summary the root can use"; mutation: no truncated terminal
branch), `assistant-ui-panel-wrapper-runtime.test.ts` ("carries the subagent
budget settings"), `delegated-conversation-insights.integration.test.ts`
("reads the child budget"), `delegated-conversation-toolbar.test.tsx`,
`subagent-settings-section.test.tsx`, and the truncated rows in
`subagent-tool-rows.test.ts` and `subagent-execution-card.test.tsx`.

A provider may cap visible text while billing reasoning in addition (BST-1771:
Grok 4.6/OpenRouter reported 1,999 total tokens for a 1,024-token request, including
975 reasoning tokens). Settlement still charges ALL reported tokens and throws
`DelegatedOutputReservationExceededError` only AFTER the transaction commits.
Only a reserved synthesis ending with `length` and no tool calls may retain its
already-produced partial findings after that specific error. It remains visibly
truncated, discloses actual versus reserved tokens to the parent, and cannot
reserve another child step. Working-step overages, tool calls, uncut summaries,
duplicate settlements and persistence failures still reject. This does not claim
an enforceable combined-token cap for that provider or omit reasoning cost.
Paired checks: `delegated-work-budget.integration.spec.ts`,
`background-worker-policy.integration.spec.ts`, `delegated-synthesis-outcome.spec.ts`
and desktop `delegated-budget-settings.integration.test.ts`.

Every child stream creates its own budget processor. A native same-persona sibling
barrier proves two models run concurrently with distinct child reservations and
exactly one settlement per matching reservation. Mastra 1.64 can omit the
processor abortSignal during unwind and does not call user onFinish on abort.
Therefore admission uses the invocation signal supplied by the conversation
binding (which already includes host-leg cancellation), composed with the
processor signal when present, and releases a held permit on abort. Admission
also includes the native executor deadline captured by the delegation hook;
otherwise a timed-out child can enter an unwinding model step and strand a work
permit while a sibling holds the other slot. The desktop deadline regression
starts a replacement after Alpha times out, proves its usage persists while
Beta remains running, and then completes Beta. The selected-Stop controller
remains separate, so a deadline stays failed/timed_out rather than cancelled.
Without a bound invocation it uses the host-leg signal. A native cancelled task alone does
not prove this release: the desktop regression "releases a stopped model permit
while Beta streams and Gamma completes" holds both model permits, stops Alpha,
and proves queued Gamma completes while Beta remains running. Using only the
host-leg signal strands Alpha's permit when native unwind omits its signal. The existing
native completion join still owns draining; no timeout or detached executor is
introduced. Cancellation is the existing subagent.failed event with cancelled
status, not a new event kind. The native recursive-worker integration checks
three-level Stop both during provider construction and after visible leaf text,
with no post-Stop reservation and no workspace effect.

Grandchild navigation before completion resolves the exact persisted invocation
from its subagent event's parent runtime/run-tool identity, within the selected
child's authorized root and parent thread. The card reads its owning message,
never a call-ID-only scan across turns; providers may reuse call IDs. Conflicting
addresses produce a local navigation error without unmounting the conversation.
The shared runtime DOM proof opens both same-ID calls to their respective runs.
Host child-event attribution must
not overwrite a nested subagent event's own parentToolCallId or personaId.
Nested events retain that identity and carry their owning conversation edge in
`delegatedConversationIdentity`; ordinary child run/tool events retain the
existing ownership metadata. Real PGlite and Electron tests cover publication,
nested card navigation, leaf approval reload, one workspace effect and parent
result propagation.

Native completion success=false is captured by parent native run and tool-call
identity, separately from no-answer. Mastra's projected delegation result can
omit finishReason even after a provider failure; the mapper must use that
authoritative hook outcome rather than label the tool-result completed. Child
mapper states share the outcome capture while retaining independent lifecycle
state. Failure produces a compact explicit parent explanation and a failed
subagent event; other ancestors may still complete after handling it.

Delegation cards resolve durable names and colors through the owning workspace repository, validating the actual parent rather than persona identity. Task text comes from the delegation tool input. Missing or contradictory authorized identity remains a visible local error; generic role labels before an address arrives are not fabricated child names.

A child-open request made before the workspace repository is available fails visibly and clears its session intent. Boot hydration still restores the saved root, but cannot replay that rejected child-open request; the user may explicitly open the child after storage is ready. The shared coordinator test covers this boundary.

2026-09-22 (BST-1799): `maxChildSteps` defaults to 100 (matching the root's
default step cap) with a 1000 ceiling, and built-ins declare that ceiling so the
setting governs. `maxChildRuntimeMs` joins the per-child settings (default Off);
see `mastra-boundary/subagent-host-lifetime.md`. The persisted store migrated
v1 → v2 so saved budgets survive the new field — including a saved 32 steps:
the store persists the whole settings object, so a user-chosen 32 cannot be told
from the old default, and only profiles with nothing saved start at 100.

2026-09-22 (BST-1801): the TREE limits are user settings too. The constant
`DELEGATION_LIMITS` (depth 3, 8 invocations, 2 runnable, 131,072 tree tokens)
starved long-horizon turns the same way the per-child constants had: 8
invocations also capped parent wakeups, and 131,072 tree tokens held only four
32,768-token children. `maxDepth`, `maxInvocations`, `maxConcurrentWork` and
`maxTreeOutputTokens` joined `RuntimeSubagentSettings` rather than a sibling
object because `maxChildOutputTokens <= maxTreeOutputTokens` is a cross-tier
rule one schema must check, and both tiers already share the store, the
`runtimeData.subagentSettings` field, the single intake and the budget row.
The constant is deleted, so a consumer reading one is a compile error (the
guarantee "has no child keys" used to give). Defaults and ranges, justified in
`subagent-settings.ts` against
docs/superpowers/research/2026-09-22-agent-timeout-and-budget-standards.md:
depth 3 (Claude Code's nesting default), 1..8 (the parent watchdog unwraps at
most eight delegation envelopes); 200 invocations (Claude Code's per-session
total before it removed that cap), 1..1000; 6 runnable operations (Codex's
thread default), 1..20 (Claude Code's concurrency default); tree output 200 x
32,768 = 6,553,600 so it never binds before the per-child and invocation caps
(run-ending token budgets are opt-in in every surveyed agent), 1,024..131,072,000
(every admissible invocation at the largest per-child allocation; fits int4).
Depth, invocations and tree output are copied into the existing budget-row
columns at first admission; `maxConcurrentWork` sizes each leg's FIFO queue
(`DelegatedWorkQueue`) and the in-flight backstop, like the runtime limit, so
it needed no column or migration. The persisted store migrated v2 -> v3,
starting the tree limits at the defaults and keeping every saved budget.
Paired tests: `subagent-settings.test.ts`, `personas.test.ts` (the model-facing
description states the request's tree limits),
`assistant-subagent-preferences-store.test.ts` (v2 upgrade),
`delegated-budget-settings.integration.test.ts` (row values, invocation, depth
and tree-output refusals from the request), `delegated-work-queue.spec.ts`,
`subagent-delegation.spec.ts`, `build-persona-subagents.spec.ts` (recursion
below `maxDepth`), `background-idle-loop.spec.ts` (wakeup bound),
`subagent-settings-section.test.tsx`, `subagent-personas-delegation-limits.test.tsx`
and `delegated-conversation-toolbar.test.tsx`. The admission suites pin the old
numbers explicitly (`BUDGETED_HOST_SETTINGS`) because they test exact races.

2026-09-22 (BST-1801 review, PR #3285): the row, not the leg's request, is the
turn's authority. `lockBudget` freezes depth, invocations, tree output and the
per-child budgets at first admission, yet the idle-loop wakeup bound, the
worker recursion gate and the model-facing delegation description read the
CURRENT leg's request, so lowering `maxInvocations` between an approval pause
and its resume failed the resume leg with `background_parent_wakeup_limit_exceeded`
although admission had allowed those tasks. `DelegatedBudgetPort.readTurnLimits`
(the desktop host reads the leg's turn row; `undefined` before first admission)
feeds `applyTurnSubagentLimits` once, in `createMastraAgentRuntime`, so every
consumer of `runtime.subagentSettings` sees the stored limits; the first leg's
values are its request's because it opens the row from that request. A stored
row the contract rejects throws. `maxConcurrentWork` (each leg's queue) and
`maxChildRuntimeMs` (each leg's task deadline) stay per request. The child
toolbar's "Level N of M" reads the same row (`budget.maxDepth` from
`readDelegatedConversationInsights`); a legacy child without a row states its
level alone. Paired tests: `subagent-settings.test.ts` (`applyTurnSubagentLimits`),
`subagent-settings-runtime.spec.ts` ("a later leg keeps the turn row's limits"),
`delegated-budget-settings.integration.test.ts` ("a later leg reads the turn's
limits from the row"), `delegated-conversation-insights.integration.test.ts`,
`delegated-conversation-toolbar.test.tsx`.
