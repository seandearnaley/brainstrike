# Activity trace header, labels and clock — evidence

Supports `docs/agents/assistant-runtime.md` § "ACTIVITY GROUPS".
Read before changing `ActivityTrace`, the live/resting label precedence, the elapsed clock pause, verb summaries, or the header a11y wiring. BST-1677, BST-1679, BST-1684, PR #3064.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1680-1830), extracted verbatim.

COLLAPSED BY DEFAULT (BST-1677 wave 3, Sean's request; header now
`ActivityTrace`, BST-1679): a group's body renders collapsed at ALL times —
running or done — `ActivityTrace`'s `expanded` derivation is
`userExpanded ?? false`, never `?? isActive`. An explicit user toggle sticks
for the life of the mounted trace, exactly as before — it can still be
expanded while running.

`ActivityTrace` (`activity-trace.tsx`) renders the header as two rows: the
status row (glyph, label, elapsed) and, only while active, a fixed-height
detail line (`bs-trace-detail`, one line, entirely removed from the DOM once
the group finishes — never a zero-height placeholder). That file owns the
MARKUP only (BST-1684): the phase and every string derived from it
(`phaseOf`, `headlineFor`, `metaFor`, `verbMetaFor`, `stepLabel`,
`isWaitingForUser`, `announcementFor`) live in `activity-trace-labels.ts`, and
its two hooks in `use-activity-trace-clock.ts` (`useElapsedMs`) /
`use-label-enter-class.ts` (`useLabelEnterClass`) — a `.tsx` file in this
package exports components and nothing else, or Vite's Fast Refresh loses the
boundary. While running, the
live label follows a fixed precedence in `summarizeActivity`'s `liveLabel`
(`activity-trace-model.ts`, over `deriveActivitySteps`'s step list):
`Waiting for approval` (any step `waiting`) > `<Verb-ing> <target>` (the last
running tool step) > `Thinking` (a running reasoning step, no tool running
yet) > `Working` (no step running yet). The detail line under it names only
the current running tool's target; it carries no label of its own.
`toolStepState` (`activity-trace-model.ts`) maps ANY `requires-action` status
— an approval gate's `interrupt`/`tool-calls` reason and a tool-suspend pause
alike — to the `waiting` step state, so `summarizeActivity` reads both as
`Waiting for approval`: this copy was already this broad, it only became
observable once `isActivityActive` kept the group live through the pause
(BST-1679 task 6, per the ruling above).

The elapsed clock (`useElapsedMs`, gated by `isActive && !waiting` where
`waiting` is the same `phase === 'running' && summary.waiting` test the
sr-announcement makes) pauses while the run is blocked on the user, so their
own deliberation time does not inflate the LIVE readout and an abandoned
in-session pause does not tick forever. `ActivitySummary.waiting`
(`activity-trace-model.ts`) is the single source for both consumers and is
deliberately NARROWER than the `Waiting for approval` label: a gated step
wins the label race even while a sibling tool call still executes, and that
run is not paused on anyone — `waiting` requires a gated step AND no tool
step still running, so genuine concurrent work keeps ticking under the
waiting headline. The elapsed badge itself stays visible but frozen — not
hidden — across the wait, so the header's height never shifts across the
running → waiting → running cycle (BST-1679 task 6).

Scope of that pause, precisely (do not overstate it): only the LIVE clock
pauses, and only for as long as the group stays mounted. The value that
survives a reload is `runEventsSpanMs` — the group's own run-event span,
wall-clock first-to-last — and it DOES include the time spent waiting, so a
reloaded turn's `Worked for Ns` reads longer than the live clock did. Within
a session the same span is the seed (`fallbackMs`), so a second pause
re-anchors the clock from whichever is larger — the run-event span or the
accumulated live time (`useElapsedMs` takes the max). Nothing subtracts wait
time from a persisted duration.

At rest the headline is the verb summary from `restingLabel`: unique
DONE-verb phrases in first-occurrence order, capped at three (`+N more` for
the rest). Verbs flagged `countsFiles` (`activity-verbs.ts`) — and ONLY those
— carry a distinct-target file count, deduped on the untruncated `targetKey`
rather than the display-capped `target` (so two long paths sharing a
head/tail after 64-char middle-ellipsising still count as two files).
`countsFiles: 'always'` counts from one (`Edited 1 file`), `'plural'` only
from two (`Read 2 files`, but a single read stays the bare `Read`). The flag
is a property of the VERB, never of its family: the `read` family also covers
directory listings, artifact reads and context reads, whose targets are not
files, and folding the family read "Listed 2 files" for them (review
finding). Exactly five ids carry it — `readWorkspaceFile` (`plural`),
`writeWorkspaceFile` / `stringReplaceWorkspaceFile` / `deleteWorkspaceFile` /
`renameWorkspaceFile` (`always`) — pinned by `activity-verbs.test.ts`. The
meta reads `· Worked for Ns · N steps · N failed` (each segment carries its
own `·`, since no whitespace separates the spans; `Stopped after Ns` is the
one exception, continuing its own headline as one phrase) (step/failed
counts from `summary.counts`, each segment omitted when zero). The headline
shrinks and ellipsises on one line (`.bs-activity-summary-label`,
`overrides.css`) so an unbounded model-written summary truncates instead of
pushing the meta out of the row; the row's flex line
(`.bs-activity-summary-row`) is stylesheet-owned for the same reason. `Stopped after
Ns` and `Activity failed` remain the headlines for the GROUP'S OWN incomplete
status (unchanged rule: cancelled → Stopped, any other reason → Activity
failed) — a failed tool step alone never fails the group, only its own
`incompleteReason` does — and whenever either headline wins, the verb summary
that would otherwise have been the headline is demoted to a
`· <verb summary>` meta segment instead of disappearing. That demotion reads
`summary.verbs`, NOT `summary.resting`: the model reports the verb summary
and the headline separately, and `verbs` is null when no tool step settled,
precisely so the `Worked`/`Thought` placeholder can never be demoted into the
meta as "Stopped after 4.0s · Worked · 1 step" (PR #3064 review finding 1).
`counts.failed` / `data-failed-steps` / the `· N failed` segment count tool
steps in state `failed` ONLY: a cancelled call is neither failed nor part of
the verb summary (phase 1's `summarizeToolActivity` folded any `incomplete`,
cancellations included, into its failed count). A reasoning-only
group (no settled tool step) reads `Thought` at rest; a live reasoning
block's own disclosure pill uses the same pair, `Thinking` while its part
streams and `Thought` once it settles (`ActivityReasoningBlock`,
`assistant-activity-parts.tsx`) — the identical `Thinking`/`Thought` pair
`deriveActivitySteps` assigns every reasoning step (`REASONING_VERB`).

The resting headline can be overridden by
`message.metadata.custom.brainstrikeActivitySummary`
(`readActivitySummaryOverride`, `assistant-activity-parts.tsx`): read-only
today, a non-empty (post-trim) string is used verbatim — validated AND
rendered trimmed, never with its padding; a non-string or blank value is
ignored, never coerced. It replaces the resting headline of a FINISHED
group only: a stopped or failed group keeps its `Stopped` / `Activity
failed` headline and never demotes the override into the `· <verbs>` meta
slot. No producer writes this key in this repo — it is a seam for a future
model-written summary (spec §4.2).

Layout is fixed-height by design (scroll-anchoring rule, §4.7 of the design
spec): the status row is `min-height: 2rem` and the phase glyph sits in a
`1rem` box (`bs-trace-phase-glyph`/`bs-trace-phase-icon`) regardless of
whether it holds a lucide icon or the animated mark, so swapping icons never
changes the row's height. The live label truncates on one line through
`.bs-activity-live-label` (`overrides.css`), the running counterpart of
`.bs-activity-summary-label` — stylesheet-owned for the same reason: the
browser test lane has no Tailwind utilities, so `truncate` on the span left
that invariant unverified. The live-label region carries `aria-live="off"` (a
cycling label would narrate every tool) plus a visually hidden
`aria-live="polite"` phrase that flips only on phase change: `Working` /
`Waiting for approval` (the one case whose text isn't just the phase's fixed
string) / `Finished` / `Stopped` / `Failed`. That live region is a SIBLING of
the disclosure button, never a child: a `button`'s children are presentational
per ARIA and several screen readers prune the subtree, so a live region inside
it may never fire. The button's own name stays `Expand activity` /
`Collapse activity`, with `aria-describedby` pointing at the summary row so
the verb summary, elapsed and counts that the static `aria-label` would
otherwise suppress still reach AT (PR #3064 review finding 3).

The disclosure's `.bs-trace-collapse` grid transition animates the OPEN
direction only: the body also carries the `hidden` attribute (which e2e and
role-based queries rely on — do not remove it), so closing applies
`display: none` in the same commit and is instant by design.

Every verb (`active`/`done`/icon family) lives in `activity-verbs.ts`'s
`TOOL_VERBS`, total over `NATIVE_TOOL_IDS` — 39 native tool ids (36
`brainstrike.*` desktop ids plus the three unprefixed Agent Skills ids
`skill`/`skill_read`/`skill_search`) — pinned both by
`activity-verbs.test.ts` and by the `Record<NativeToolId, ActivityVerb>` type
itself (a tool added to the catalog without a verb entry fails to compile).
Non-native tool names fall through `verbForTool`: a subagent delegation
(`agent-<persona>` prefix) reads `Delegating to <persona>` /
`Delegated to <persona>`; a dotted, non-`brainstrike.`-prefixed name (an MCP
tool, `server.tool`) reads `Calling server.tool` / `Called server.tool`;
anything else reads `Using <name>` / `Used <name>` rather than guessing.

Test ids and data attributes are unchanged from the pre-`ActivityTrace`
header: `assistant-activity-group`, `assistant-activity-summary`,
`assistant-activity-body`, `assistant-activity-working`,
`assistant-activity-failed-count`, `data-active`, `data-failed`,
`data-failed-steps`, `data-state`.

