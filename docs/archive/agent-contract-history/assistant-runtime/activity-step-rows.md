# L1 step rows and L2 bodies — evidence

Supports `docs/agents/assistant-runtime.md` § "ACTIVITY GROUPS".
Read before changing `StepRowHeader`, step state derivation, glyphs, the reveal stagger, `ToolFallback`'s composition, or detail-level policy. BST-1681, BST-1682, BST-1684, BST-1686.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 1831-2047), extracted verbatim.

L1 STEP ROWS / L2 BODIES (BST-1681 phase 3, `activity-step-row.tsx` /
`activity-trace-model.ts`): each entry in `deriveActivitySteps`'s part-order
list (tool calls and reasoning parts) renders as one `StepRowHeader`
(`activity-step-row.tsx`) row inside `.bs-step-list`: family icon
(`StepFamilyIcon`) · verb in tense (`Reading` while running, `Read` once
settled — the same `active`/`done` pair every `ActivityVerb` carries,
`activity-verbs.ts`) · target chip · timing slot · state glyph
(`StepStateGlyph`) · chevron. The ACTIVE tense covers `running` AND `waiting`
(`ACTIVE_TENSE_STATES`, `tool-fallback-state.ts`): a call paused at its approval
gate is in flight, so "Ran rm -rf build" under a Waiting glyph would assert an
outcome that does not exist — the glyph is what says why the step is standing
still. Only the settled states (`done`, `failed`, `cancelled`) read the done
tense; the subagent card's `STEP_VERB` has always mapped waiting to its active
form. The target chip falls back to the TOOL ID when the args name no primary
arg (`ToolFallback` passes `primaryArg?.display ?? toolName`), so an
argument-less MCP call reads "Called legacy.echo · legacy.echo" rather than
leaving the slot empty; `targetTitle` stays the untruncated primary arg, never
the id. The timing slot renders only when the caller supplies timing — the
reasoning and task-list rows pass none, and an empty flex item would still
spend its gap. The row IS the card's own header —
`ToolFallback`, `SubagentExecutionCard` and `TaskListToolCard` all render it
in place of a second header, so a step never shows its verb twice. `RowShell`
(`activity-step-row.tsx`) splits into the two forms a step can take: a card
with something to expand renders the row as a real
`<button aria-controls aria-expanded aria-label>`. Its accessible name
CONTAINS its visible label (BST-1682, WCAG 2.5.3 Label in Name): the verb and
target lead, the toggle affordance trails as a clause with only its first
character lowered — `Read src/app.ts, expand details` — so a speech-input user
can say what they see and no AT configuration can lose the step's identity
along with a suppressed description. The affordance wording itself
(`Expand details` / `Collapse details`) is unchanged and still the e2e
contract, but the e2e specs now match it as a SUBSTRING
(`getByRole('button', { name: /expand details/i })` in
`apps/desktop/e2e/mcp-packaged-core.desktop.test.ts` and
`apps/web/e2e/assistant-ui-panel.test.ts`) — an `exact: true` equality on the
bare affordance can never resolve again. `aria-describedby` goes with it:
content that is already IN the name must not also be a description, or AT
reads the row twice. The one opt-out is `nameFromContent={false}`, which the
reasoning row passes because its `label` ALREADY names the step —
`Show thinking` / `Hide thinking` stays its whole name (an e2e and BST-1656
behaviour contract; `Thinking, show thinking` would only stutter) and it keeps
`aria-describedby` on its content. The prop defaults to the ACCESSIBLE
behaviour on purpose, so a row added later is compliant without its author
knowing the rule exists. `aria-expanded` is always present; `aria-controls` is
emitted ONLY while the element it names is mounted — the convention every
other disclosure in the package already follows
(`assistant-run-timeline.tsx`, `assistant-tool-approval-notice.tsx`) — so the
tool / subagent / task cards, which unmount their body while collapsed, drop
it there rather than leave a dangling IDREF. A row whose body stays in the
DOM either way opts back in with `controlsAlwaysMounted`: only the reasoning
row does, since its `bs-chain-of-thought-panel` is always mounted and only
its CONTENT is gated on `open` (pinned by `tool-fallback-a11y.test.tsx` and
the BST-1656 fingerprint in
`assistant-reasoning-disclosure.behavior.test.tsx`, which compares
`aria-controls` across a manual toggle). A card with nothing to expand (no body — e.g. a subagent
delegation with zero child rows) renders the non-interactive form instead, a
`<div role="group" aria-labelledby>` with no chevron and no `aria-expanded`.
The raw tool id is visually hidden text OUTSIDE the row's named content span,
plus the row's own `title` — the e2e text contract — never INSIDE the
content span, which would otherwise fold `brainstrike.readWorkspaceFile` into
the non-interactive row's `aria-labelledby` name alongside its verb and
target. `trailing` (`StepRowHeader`'s prop for the result-summary chip, the
resolved-root chip, and the subagent card's `· N tool calls` count) renders
in that same OUTSIDE position, right after the content span
(`activity-step-row.tsx`) — it used to sit inside the content span, which
named a zero-row delegation "Delegating to Explorer · 0 tool calls" instead
of just its verb (BST-1686). The chip stays visible row text; it just plays
no part in naming or describing the step, same as the sr-only id beside it.

The interactive row's three a11y-reachable surfaces are deliberately
disjoint, ruled in BST-1682 review round 2: NAME is `<verb> <target>,
<affordance>` (`contentAccessibleName`, `activity-step-row.tsx`) — the
content-composed string above, nothing else. DESCRIPTION is the raw tool id,
and only that: with `aria-describedby` no longer emitted on a content-named
row, the button's `title` attribute becomes its accessible description per
HTML-AAM, so a screen reader announces "Read src/app.ts, expand details,
collapsed, button — brainstrike.readWorkspaceFile" on focus. This is kept
deliberately, not an oversight — the `title` is the one place the raw id
still reaches AT, and it does so honestly, as a description rather than
competing with the visible label for the name. Pinned in
`activity-step-row.test.tsx` (`toHaveAccessibleDescription`, both the
carries-it and the has-none case). TRAILING content (result summary, root
name, `· N tool calls`) sits inside `.bs-step-row-content` today but in
NEITHER the name nor the description — it is result metadata a user did not
ask to hear announced on every focus, not the label they would speak. It
stays reachable in browse mode (screen-reader users can still read it as
text) even though focus mode skips it. BST-1686 (PR #3067) moves `trailing`
out of the content span entirely; this paragraph does not need updating for
that move, since trailing's a11y treatment (reachable, not named) is
unchanged either way.

State glyphs are named, never colour-only: `STEP_STATE_LABELS`
(`activity-step-tokens.ts`) is the total `role="img"`/`aria-label` map —
`Completed | Running | Failed | Stopped | Waiting for approval | No answer`
— over `StepGlyphState` (`ActivityStepState` plus the subagent-only
`no-answer` arm). A step's state is derived by ONE function only,
`toolStepStateFor` (`activity-trace-model.ts`): the trace headline
(`deriveActivitySteps`), `ToolFallback` (`resolveCardStatus`,
`tool-fallback-state.ts`),
`SubagentExecutionCard` (`resolveDelegationState`) and `TaskListToolCard` all
consume it, so a step can never read two different states on two surfaces.
The two refinements layered on top of a generic `done` both live INSIDE that
function — a declined-envelope result reads `cancelled`
(`settledResultOverride`), and a settled `run_python` result reads
done/failed/cancelled by kind (`runPythonStepState`) — plus one refinement
outside it that only the subagent card may make: `resolveDelegationState`
reads `no-answer` off the delegation's OWN result shape, strictly on top of a
generic `done`. `Waiting for approval` is a LIVE pause only:
`toolStepStateFor` maps `status.type === 'requires-action'` to `waiting`,
nothing else — a resultless call on a settled (`complete`) message falls
through to `settledResultOverride` and reads `Completed` on every surface
(not `Unknown`; the reload-after-abandoned-approval residue is persistence
work, BST-1678, never a renderer guess). A result that STATES its own
failure is `failed` on every surface too, and `readResultError`
(`activity-trace-model.ts`) is the ONE reader of that — it answers both
"does this result state an error" (the state machine's `statesResultError`
wrapper) and "what does it say" (`ToolFallback`'s error line, via
`resolveErrorMessage`, `tool-fallback-state.ts`), because two copies of that
shape list had already
drifted. It reads the success discriminator FIRST: an `ok: true` result stays
`done` and shows no error line however its `error` member is shaped (string or
record) — that is advisory domain data. Otherwise it recognises a non-empty
`error` string, an `ok: false` envelope whose `error.message` explains it, or
a result-level `isError: true` (which states no message of its own and takes
`TOOL_EXECUTION_FAILED_MESSAGE`). The part-level `isError` flag is a separate
branch in the card: a signal about the CALL, not something the result states,
so it supplies only the generic message. Ordering hazard inside
`toolStepStateFor`: this branch runs BEFORE `settledResultOverride`, so a
tool-specific reading can never soften a result that states an error — one
that must win has to move above the branch, not into the override.

Exactly one live mark renders per running row: the state glyph
(`StepStateGlyph`'s `running` arm renders `BrainstrikeThinkingMark`, which
carries `data-live="true"` by default). `ToolRunTiming` (`tool-fallback-row.tsx`)
passes `showMark={false}` into its `AssistantThinkingIndicator` so the timing
slot's own progress label never grows a second live mark, and the reasoning
row's `ReasoningGlyph` (`assistant-activity-parts.tsx`) keeps its own
pre-existing `assistant-reasoning-indicator` / `assistant-reasoning-static-mark`
pair rather than the generic glyph. Only the group's LAST running tool row
shimmers: `ActivityGroup` computes `deriveStepMeta(steps)`
(`activity-step-meta.ts`) once per snapshot and hands it down through
`ActivityStepMetaProvider` (`activity-step-context.tsx`, over the context
object in `activity-step-meta-context.ts`); `useIsLastRunningStep`
(`use-is-last-running-step.ts`) answers `true` outside any provider, so a
standalone running card (rendered without a group) still shimmers. Rows
reveal with `bs-trace-reveal` and a positional `:nth-child` stagger on
`.bs-step-list`, capped at 5 (`overrides.css`) — no row carries its own
index, and a row already visible when a new one arrives does not re-animate
(the animation runs once per mount). The `:nth-child` rules set
`--bs-stagger` on the list's DIRECT children, which are the WRAPPERS
(`ActivityPartLayout`'s div; two more levels for `ToolFallback`), and the row
reads it by INHERITANCE — so `.bs-trace-reveal` must default through
`var(--bs-stagger, 0)` and never declare the property on itself, which would
shadow the inherited value and flatten every delay to 0.

Reasoning is a step with its own verb pair, `Thinking` / `Thought`
(`ActivityReasoningBlock`, `assistant-activity-parts.tsx`), rendered through
the shared row with `family="other"` and `icon={Brain}`. A subagent
delegation is a step whose verb names the PERSONA, not the assistant —
`STEP_VERB` (`subagent-execution-card.tsx`) is total over `StepGlyphState`:
`Delegating to <Label>` (running AND waiting — a gate has not started the
child either way), `<Label> finished`, `<Label> gave no answer`, `<Label>
failed`, `<Label> stopped` (cancelled). `TaskListToolCard`
(`todo-progress.tsx`) reads the same shared row with `family="tasks"` and its
own verb pair, `Updating tasks` / `Updated tasks`. The checkpoint revert
control (`CheckpointRevertButton`, `tool-fallback-row.tsx`) is a SIBLING of the
row inside `.bs-step-row-line`, never nested inside its `<button>` — nested
interactives are invalid HTML — and it hides only for the `running`/`failed`
states; a CANCELLED edit keeps its revert control, since a captured
checkpoint means the mutation landed regardless of how the call itself
settled.

`ToolFallback` (`tool-fallback.tsx`) is the composition ROOT only (BST-1684,
splitting the React Doctor complexity warning the phase-3 re-skin left
behind): the `.bs-step-row-line` — `StepRowHeader` + `ToolRunTiming` + the
`CheckpointRevertButton` sibling — is `ToolFallbackRow`
(`tool-fallback-row.tsx`); everything below the row (error line, live shell
pane, `run_python` surface, details pane) is `ToolFallbackBody`
(`tool-fallback-body.tsx`); and the pure derivations (`resolveCardStatus`,
`resolveErrorMessage`, `ACTIVE_TENSE_STATES`, `formatResult`,
`extractResolvedRootName`) are `tool-fallback-state.ts`. The card's DOM, test
ids and prop rules are unchanged by that split — it is a file boundary, not a
behaviour one. `@brainstrike/assistant-ui/tool-fallback` stays the subpath
`mcp-app-host-ui` imports; only `ToolFallback` is exported from it.

Detail level maps to concrete row behaviour via `resolveToolDisplayPolicy`
(`assistant-detail-level.ts`): `compact` hides the details expander and the
result-summary chip (`showDetailsExpander: false`, `showResultSummary:
false`); `standard` shows both, collapsed by default; `developer` auto-opens
the body (`defaultExpanded: true`) and adds raw I/O (`showRawIo: true`).
`SubagentExecutionCard`'s own trailing chip, `· N tool calls`
(`subagent-execution-card.tsx`), reads the SAME `policy.showResultSummary`
gate as `ToolFallback`'s result-summary chip (BST-1686) — it is a result
summary too, and used to be the one trailing chip in the trace the Detail
control never touched. The card deliberately adopts only that one flag:
`expanded` is its own `useState`, never `policy.defaultExpanded` or
`showDetailsExpander` (`subagent-execution-card.tsx`), because the
delegation rows ARE the card's substance, not raw I/O to gate. One row chip
is NEVER gated by detail level: `ToolFallback`'s `in <root>` chip
(`extractResolvedRootName`, target disambiguation in a multi-root
workspace) renders whenever a result carries a `rootName`, unconditional on
the policy — unlike the result-summary chips beside it, which
`policy.showResultSummary` gates. Only `developer` shows run-event rows
inside the trace: `AssistantRunTimelineDataPart`
(`assistant-run-timeline-data-part.tsx`) reads
`shouldShowBackgroundActivity(detailLevel)` and renders the full
`AssistantRunTimeline` row only there (every other level still shows the
`isAlwaysVisibleRunEvent` kinds standalone, per the grouping rule above).
Those run-event rows are direct children of `.bs-step-list` too — they are
group-transparent (`groupAssistantActivityPart`), so `AssistantActivityParts`
renders their `dataRendererUI` straight into the list alongside the
`ActivityPartLayout`-wrapped step rows. They CONSUME `:nth-child` slots —
shifting the reveal delay of every step row after them one step along — but
carry no `.bs-trace-reveal` of their own and do not animate;
`.bs-step-list`'s own row rhythm (`> * + *` block
margins) makes an exception for them (`.bs-run-timeline`, `overrides.css`) —
see ui-conventions.md's "Step rows" paragraph for the geometry.
