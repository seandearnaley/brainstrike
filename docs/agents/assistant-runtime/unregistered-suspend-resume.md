# Unregistered suspend resume and the settled tool card — evidence

Supports `docs/agents/assistant-runtime.md` § "PLAN MODE & TOOL SUSPENSION (ask-user / submit-plan)".
Read before changing `tool.resume.unsupported`, the always-visible exemption, the declined-tool terminal, or the unsupported-suspend notice. BST-558, BST-940, BST-1282.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 4306-4456), extracted verbatim.

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
message, reason?}`), which is what `settledResultOverride`
(`activity-trace-model.ts`) reads to render the muted
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
