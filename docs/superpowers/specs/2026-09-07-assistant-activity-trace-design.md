# Assistant activity trace: replace per-call "Worked · 1 step" rows with a Codex-style cycling status row

**Date:** 2026-09-07 · **Status:** draft for review · **Scope:** `packages/assistant-ui` thread rendering of reasoning, tool calls, subagents, approvals, and run events; hydration parity of live indicators. **Supersedes** the presentation half of BST-1656 (#2991); keeps its chronology rulings.

This document is the research-and-design output. The task-by-task implementation plan is written after this is approved (writing-plans step).

## 1. Problem, grounded

### 1.1 Why every tool call is its own "Worked · 1 step" row

The grouping is not Brainstrike code. `MessagePrimitive.Parts` with a `ChainOfThought` component uses `@assistant-ui/core`'s legacy `groupMessageParts`, which coalesces **adjacent** `tool-call` and `reasoning` parts and ends the group on **any other part type**:

```js
// @assistant-ui/core dist/react/primitives/message/MessageParts.js
if (type === "tool-call" || type === "reasoning") chainOfThoughtGroup.startGroup(i);
else { chainOfThoughtGroup.endGroup(i - 1, ranges); ranges.push({ type: "single", index: i }); }
```

Brainstrike puts a `data` part into `message.parts` for every run event (`brainstrike.run-event`: `tool.started`, `tool.completed`, `run.step.*`, `memory.*`, …), both live (the `aui-data` wire chunk becomes a `part-start` data part, `data-stream-runtime.ts:927`) and on reload (`weaveRunEventsIntoContent`, `assistant-memory-repository.ts:2018`, per the persistence contract). Three more `data` parts render `null` (shell output, context breakdown, child-run usage) and still split groups, because grouping runs on part `type` before any renderer is consulted.

So a turn with N tool calls is fenced into N one-step groups. The BST-1656 fixtures (`assistant-activity-timeline-fixtures.tsx`) contain no `data` parts, which is why its tests pass while the app shows the screenshots in this ticket. The missing elapsed on most rows ("Worked · 1 step") is the same cause: the group-local fallback needs two timestamped run events scoped to that group's own call ids.

### 1.2 Why it is not idiomatic

The current block is a generic collapsible ("Worked for 12s · 5 steps") whose body is a stack of full tool cards. Codex desktop, Claude Code desktop, and Cursor all converged on: **one status row per run that is replaced in place** while work happens, a **resting summary in verbs** when it finishes, and a **disclosure triangle** that opens a step list, then per-step detail. Repeated rows with a generic label force the reader to open each one to learn what happened.

### 1.3 Live animation after reload

The library makes the part path safe: `toMessagePartStatus` gives a resultless tool call the **message** status, and hydration hard-codes every assistant message to `{ type: 'complete', reason: 'stop' }` (`assistant-memory-repository.ts:2107`, `:2613`). A hydrated tool call or reasoning part therefore cannot spin. Every observed hanger comes from the **run-event path**, which derives status by pairing `.started` rows with terminals:

| Source | Live indicator | Why it can hang after reload |
| --- | --- | --- |
| `AssistantRunTimeline` (`assistant-run-timeline.tsx:186`) | `AssistantThinkingIndicator` on a `running` row | A `.started` row whose terminal never arrived (crash, kill, old bug) stays `running` forever. Shipped twice: hydrated `runId` pairing (fixed by `isRunAgnosticTerminalKind`), and a terminal-kind rename nothing emitted (BST-947). `tool.approval.requested` is always visible, so an abandoned pause shows "Awaiting your approval" + Thinking on every reload (BST-1417, accepted dead end). |
| `SubagentExecutionCard` (`subagent-execution-card.tsx:58-71`) | `CircleDashed animate-pulse` (card and child rows) | Child rows come from `subagent.tool.started` events; an interrupted delegation leaves rows with no terminal. No `motion-reduce:` guard either. |
| Reattachment replay (`assistant-run-reattachment.ts`) | temporary streaming message | A stored active-run record whose `/assistant/resume` fails leaves the temporary message until cleanup; the record is cleared on 404 but the visual window exists. |

The rule that closes the class: **a run-event row may only render as live when its message is live.** A `running` row inside a message whose status is not `running` is *interrupted*, rendered static. This is a renderer rule, not a persistence change; the durable rows stay as they are.

## 2. Research summary

### 2.1 Codex (open-source TUI, `openai/codex` @ `4b0f44d3`, plus app bug reports)

- **One ephemeral status row** above the composer: animated bullet, shimmer header (default "Working"), `(47s • esc to interrupt)`, optional `└ detail` lines. Replaced in place; reasoning-summary bold headers become the header text; the row disappears at turn end and a dim `Worked for 4m 07s · done 3:41 PM` separator is inserted (`status_indicator_widget.rs`, `history_cell/separators.rs`).
- **Exploration coalescing**: consecutive read/list/search commands merge into one `Exploring` → `Explored` cell with lines `Read a.rs, b.rs`, `List path`, `Search q in path`; other commands are `Running cmd` → `Ran cmd` with head/tail output; patches are `Edited path (+12 −3)` or `Edited 3 files (+82 −49)` with `└ path` children (`exec_cell/`, `diff_render.rs`).
- **Verb tense flips in place** (`Running` → `Ran`), bullet color swaps; completed items are never re-inserted. Shimmer is a 2 s cosine band; reduced motion renders plain text and a static bullet.
- **Approvals** are a modal in the bottom pane; the durable record is a history line `You approved codex to run …`.
- **App**: one collapsible block per turn, `Working`/`Thinking` → `Worked for 5s`; a global *Thread detail* setting controls what lands inside; expand state is **not** remembered (open feature request). The "Read files, ran commands" aggregation grammar and the `Step 1/6 · 68 files changed` footer are app-only and unverifiable from public sources.

### 2.2 assistant-ui (the library this thread already runs on, `~0.15.18`)

- The `ChainOfThought` component path is **documented as legacy**. The recommended API is `MessagePrimitive.GroupedParts` with a `groupBy` function; it is exported by the pinned version. `groupBy` receives every part, so `data` parts can be made group-transparent, and human-in-the-loop parts can be kept standalone (`standalone-tool-call` semantics; MCP apps detected via `getMcpAppFromToolPart`).
- The `elements` catalog documents the exact patterns wanted here, with runtime wiring recipes: **Thinking indicator** (label keyed on its own text so a change replays the fade), **Tool timeline** (one collapsed line → vertical trace of verb + icon + chip + file stats; only the last visible step shimmers), **Tool group** (count + spinner + chevron; ghost/outline/muted variants; scroll lock during height animation), **Agent status** (working / waiting / done, with `requires-action` → waiting rendered as a static outline dot), **Tool call**, **Reasoning** (auto-open while streaming, user toggle sticks, `Thought for Ns`), **Subagent list**, **Approval card**, **Stopped run**.
- Those elements ship through the shadcn registry with their own `surfaces.tsx` tokens. Brainstrike vendors components into its own packages and does not adopt registries at runtime, so they are **reference patterns to port**, not dependencies.

### 2.3 beautifului.dev

Single-author (Shane Levine, MIT, seven weeks old, 125 stars), shadcn-registry only, no npm package. The primitives (Thinking, Tool Chips, Task Rows, Approval Card, Loading State) are **demo-driven**: rows are revealed by internal timers, "Thought for 4 seconds" is a hardcoded string, there is no tool state union, and the token system (`--ink`, `--surface`, `--line`) parallels shadcn's. Nothing imports `motion`. What is worth lifting is the **CSS motion grammar**: `shimmer-text`, `fade-up` stagger (`i × 80–120 ms`), the `grid-template-rows: 0fr → 1fr` collapse, and the elapsed-timer formatting. Nothing is copied verbatim.

Vercel AI Elements is the canonical typed reference for tool state (`input-streaming | input-available | approval-requested | approval-responded | output-available | output-denied | output-error`) but is in maintenance mode; prompt-kit is dormant. Brainstrike's state comes from `@assistant-ui/react` part status plus its own run events, so the AI Elements union is a naming reference only.

### 2.4 Repo constraints that bind the design (from `docs/agents/*.md` and code)

- BST-1656 rulings stay: each contiguous activity run renders at its own position; never hoist later parts into an earlier group; group status derives from that group's parts; reasoning-only groups show no step count; incomplete status is authoritative (Stopped / Activity failed); turn-wide task list renders once in the first group; durations and shell output correlate by call id across the message.
- The repo owns thread scrolling (BST-896/897, two tiers). Header height changes are a scroll-anchoring hazard; `overflow-anchor` is scoped by `data-pinned`.
- No animation library exists anywhere in the monorepo (strict pnpm catalog). Every animation is CSS under `.assistant-ui-panel` with `prefers-reduced-motion` and `forced-colors` blocks. This stays.
- `assistant-ui-panel.tsx` has an enforced line budget; new UI lands in its own modules.
- `patchedDependencies` are banned; the library cannot be patched.
- Feature gating is capability-based; nothing here is desktop-only.
- CDT verification with screenshots is the definition of done for UI work; the hosted-mock recipe over CDP is the way to drive it.

## 3. Options

**A. Grouping fix only.** Move to `GroupedParts` with a `data`-transparent `groupBy`; keep today's block. Fixes the repeated rows and restores elapsed. Does not reach the Codex experience. Kept as **phase 1** because it is small, independently valuable, and de-risks the migration.

**B. Activity trace (recommended).** Phase 1 plus a new per-run block: cycling status row, verb summaries, three-level disclosure, reasoning and approvals as steps, CSS motion grammar, hydration-parity rule. Built on the library's recommended API and its documented element patterns, vendored into `@brainstrike/assistant-ui`.

**C. Adopt the assistant-ui `Thread` element wholesale.** Rejected: it owns the viewport and auto-scroll (which the repo deliberately took over), assumes registry tokens, and would replace the custom tool, subagent, MCP, approval, and suspend renderers that carry their own contracts.

## 4. Design (option B)

### 4.1 Grouping

`AssistantMessage` renders `MessagePrimitive.GroupedParts` with an inline `groupBy` (the helper cannot branch on data-part names):

| Part | Group path | Note |
| --- | --- | --- |
| `reasoning` | `['group-activity']` | |
| `tool-call` | `['group-activity']` | MCP-app calls stay inside the group in phase 1 (result-shape detection cannot classify a call before its result lands; moving standalone needs a call-start marker — deferred) |
| `data` `brainstrike.run-event` | `['group-activity']` | Group-transparent, EXCEPT always-visible kinds (`isAlwaysVisibleRunEvent`), which stay standalone so a collapsed group cannot hide them; they occur at run start, at a pause, or at run end, so they never fragment a run's tool calls |
| `data` shell-output, context-breakdown, child-run-usage | `['group-activity']` | Transparent, render `null` as today |
| `data` tool-approval, tool-suspend | `[]` | Standalone cards. A pause is a real boundary; the trace before it settles, the resumed leg starts a new trace |
| `text` | `[]` | Splits, as BST-1656 requires |

Always-visible event rows render standalone. A `group-activity` node holding only transparent data parts renders its children bare, with no group chrome.

A trailing `group-activity` node also counts as active while its owning message is still running and its own status has not resolved to `incomplete`, even once every part it currently holds reads complete — a tool call's result can land in the same streamed chunk that fences the next call into the same coalesced group, so a purely part-derived status would otherwise flash "Worked" for the model-latency gap between two calls of the same run; only the group holding the message's last part gets this treatment.

Group nodes are keyed by the library on the first part's id, so a trace stays mounted across streaming (BST-1656 "wrappers remain mounted").

### 4.2 Derived model

One pure module, `activity-trace-model.ts`, turns a group's parts plus the message-wide run events into:

```ts
interface ActivityStep {
  readonly id: string;                // toolCallId, reasoning part index, or event id
  readonly kind: 'tool' | 'reasoning' | 'subagent' | 'approval' | 'event';
  readonly verb: { active: string; done: string };   // "Reading" / "Read"
  readonly target: string | null;     // basename, pattern, command, persona, …
  readonly state: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  readonly durationMs: number | undefined;
  readonly partIndex: number | undefined;
  readonly stats: { added?: number; removed?: number } | undefined;
}
interface ActivitySummary {
  readonly live: string;     // "Reading tool-fallback.tsx" | "Thinking" | "Waiting for approval" | "Working"
  readonly resting: string;  // "Read files, ran commands, edited 2 files"
  readonly counts: { steps: number; failed: number; edited: number };
}
```

Rules:
- **State** maps from the library part status: `running` → running; `requires-action` → waiting; `complete` → done, or failed when `isError` / guarded error; `incomplete` → cancelled or failed by reason. Run-event-only steps (approval pause, hook notices) use the existing pairing derivation, then apply the interrupted rule (§4.6).
- **Live label**: the most recent running step's active verb + target (last running wins, as today); else "Thinking" when a reasoning part is running; else "Working". Waiting beats everything: "Waiting for approval" / "Waiting for your answer".
- **Resting label**: unique done verbs in first-occurrence order, at most three, sentence case, then `+N more`; edit verbs carry a file count ("edited 2 files"). Cancelled → `Stopped` prefix; any failed → `{summary} · 1 failed`.
- **Verb vocabulary** lives in `activity-verbs.ts`, keyed by native tool id (`NATIVE_TOOL_ID`), with a rule for delegation tools (`agent-*` → "Delegating to {persona}") and MCP tools ("Calling {tool}" with the sanitized name de-normalized). Unknown tools use "Using {name}". Targets come from the existing `extractPrimaryArg` (`tool-summaries.ts`), so the header and the row agree.

| Native tool | active / done | target |
| --- | --- | --- |
| readWorkspaceFile | Reading / Read | basename |
| readWorkspaceDirectory, globWorkspace | Listing / Listed, Finding / Found files | path / pattern |
| grepSearch, hybridSearch, queryEmbeddingSpace, querySelf | Searching / Searched | pattern / query |
| findWorkspaceSymbol, lspInspect, queryDiagnostics | Inspecting / Inspected | symbol / path |
| writeWorkspaceFile, stringReplaceWorkspaceFile | Editing / Edited | basename (+ stats when the result carries them) |
| deleteWorkspaceFile, renameWorkspaceFile | Deleting / Deleted, Renaming / Renamed | basename |
| executeCommand, manageCommandSession, runPython, runSkillScript | Running / Ran | command (capped, mono) |
| webSearch, webExtract, browser* | Searching the web / Searched the web, Fetching / Fetched, Opening / Opened | query / URL |
| manageCanvas, manageTaskList, manageWorktree | Updating / Updated canvas, tasks, worktree | title |
| skill, skillRead, skillSearch | Loading / Loaded skill | skill name |
| askUser, submitPlan | Asking / Asked, Proposing / Proposed plan | question / title |

The active/resting pair is the seam a future small-model summary plugs into: the trace accepts an optional `restingOverride` read from message `metadata.custom.brainstrikeActivitySummary`. No producer is built now; the seam is documented and typed.

**Status (phase 2, BST-1679) — where the shipped table differs from the one above.** The catalog is 39 native tool ids (36 `brainstrike.*` plus the unprefixed Agent Skills ids `skill` / `skill_read` / `skill_search`), and `TOOL_VERBS` is total over it by type. The three skill verbs ship as `Activating skill` / `Activated skill`, `Reading skill file` / `Read skill file` and `Searching skills` / `Searched skills` — not the single `Loading / Loaded skill` pair in the table. The file count is NOT a property of the `edit` family as written above: it is an explicit per-verb `countsFiles` flag (`'always'` for the four edit-style file verbs, `'plural'` for `readWorkspaceFile`), because the `read` family also covers directory listings, artifact reads and context reads, whose targets are not files. `ActivitySummary` also carries `waiting` (a gated step exists and no tool step still runs) — the clock/announcement gate, narrower than the `Waiting for approval` label.

### 4.3 Presentation

**Status (phase 2, BST-1679):** L0 shipped — status row, detail line, motion
— plus reasoning's `Thinking`/`Thought` labels. L1 (step list) and the L2
re-skin of the tool cards below are phase 3, not yet built.

**L0, status row** (always rendered, fixed height): disclosure triangle · state glyph · label · elapsed · trailing meta. While running: shimmering live label, ticking elapsed seeded from the group's run-event span (today's `useElapsedMs`, now fed by the whole group), and **one detail line** beneath in the Codex `└` style showing the current target, truncated. On finish the label crossfades to the resting summary (keyed on its text, per the thinking-indicator element), the detail line collapses, and the meta reads `Worked for 12.0s` (cancelled: headline `Stopped` with meta `after 4.0s`; failed tint destructive). Reasoning-only groups read `Thought` with the same `Worked for Ns` meta (durations always carry one decimal, per `formatActivityDuration`).

**L1, step list** (triangle open): one row per step in part order: icon by verb family, verb (tense follows state), target chip, duration, state glyph. Rows fade-up with a capped stagger when first revealed; rows already visible when a new one arrives do not re-animate. Only the last running step shimmers. Reasoning is a step ("Thinking" → "Thought"; a per-step duration is phase 3) whose body is the existing `AssistantReasoningPart`; the reasoning-collapsed default and the "expansion survives an intervening tool call" behaviour are preserved.

**L2, step body** (row click): the existing renderers, unchanged in phase 2: `ToolFallback` details, live shell output, run_python result, `SubagentExecutionCard` rows, the MCP task renderer, task-list card. MCP-app results are standalone (§4.1) and never inside a trace. Phase 3 re-skins `ToolFallback`'s own header into the row grammar so a step does not show two headers.

**Expand state**: `userOpen ?? false` per trace, session-only (Codex parity; the current auto-expand-while-running goes away because L0 already shows the current step). The four e2e specs that use `aria-expanded="false"` as their "turn finished" sync point keep working since the resting state is closed; they should move to the `data-state="done"` attribute the trace publishes.

**Detail level** keeps its meaning: compact → rows without result summaries; standard → rows with summaries; developer → run-event rows shown inside the trace and bodies open by default.

**Approvals and suspensions** stay standalone cards (§4.1) and the decision chip stays. Inside the trace, a paused call shows as a `waiting` step with a static outline glyph and "Waiting for approval"; the pre-pause trace's L0 reads "Waiting for approval" until the resume leg starts.

**Subagents**: a delegation is one step ("Delegating to Explorer" → "Explorer finished · 40 tool calls"); its body is the existing card's child rows.

**Turn end**: the trace is inside the message, so the final answer never lands inside it (a Codex app bug class worth not importing).

### 4.4 Motion (CSS only, `overrides.css`)

- Reuse `bs-thinking-shimmer` and `BrainstrikeThinkingMark` for the live label.
- Add `bs-activity-fade-up` (opacity + 4 px translate, 220 ms, `cubic-bezier(0.23, 1, 0.32, 1)`) with `--bs-stagger-index` capped at 5.
- Disclosure via `grid-template-rows: 0fr ↔ 1fr` + `overflow: hidden` inner (no measured heights, no `hidden` toggling), with the thread scroll lock during the transition on the static tier only.
- Label change: keyed span, `bs-activity-label-enter` 250 ms.
- `prefers-reduced-motion`: all of the above become instant; the live glyph is the static mark, as the existing blocks already do. `forced-colors` keeps text visible.
- `motion-reduce:` is added to the subagent card's `animate-pulse`.

### 4.5 Accessibility

Trigger is a `<button aria-expanded aria-controls>`; step rows with bodies are buttons too. The live label is `aria-live="off"` (a cycling label would narrate every tool); a visually hidden status ("Working", "Waiting for approval", "Finished") flips only on state change and is `aria-live="polite"`. Glyph state is duplicated as hidden text, never colour-only. Under the virtual tier the viewport's own live region is already off.

### 4.6 Hydration parity rule

- Every live indicator component gains `data-live="true|false"`. One selector answers "is anything animating".
- New renderer rule in `assistant-run-event-derivation.ts`: a `running` run-event row whose owning message is not running resolves to `interrupted` (label "Interrupted", static glyph). Subagent child rows follow the same rule. `tool.approval.requested` remains always visible but reads "Approval was pending" when interrupted and "Awaiting your approval" only while the message is live or a suspended pause is rediscovered.
- Invariant test: render hydrated fixtures that mirror real persisted rows (the persistence doc forbids hand-written shapes) for a completed turn, a cancelled turn, an approval answered on a second leg, an abandoned approval, and an interrupted subagent. Assert `[data-live="true"]` is empty in all five. Render the same turns live through the runtime harness and assert the resting markup equals the hydrated markup.
- Threads-panel glyph behaviour (BST-1417) is out of scope and unchanged.

### 4.7 Scroll safety

L0 has a fixed height in both states; the only height change at turn end is the detail line collapsing, which happens while the follow engine is pinned (streaming just finished) or above the viewport where native anchoring holds. Opening a trace uses the scroll lock the library elements use. Nothing else in the thread contract changes.

## 5. Testing

- **Pure model**: `activity-trace-model.test.ts` (state mapping incl. `requires-action` → waiting, live/resting grammar, verb table coverage for every `NATIVE_TOOL_ID`, +N more, edit counts, cancelled/failed prefixes). Mutate each rule once per the repo's guard discipline.
- **Grouping**: extend `assistant-activity-timeline-fixtures.tsx` with run-event `data` parts around each call (shapes copied from `mastra-memory-persistence.integration.spec.ts` output, not invented) and assert one trace per contiguous run, text still splits, standalone cards split.
- **Behaviour through the real runtime** (`useLocalRuntime` harness): label cycling order, resting summary, no remount of earlier traces, cancellation → Stopped on the active trace only, reasoning expansion surviving a tool call, approval waiting state.
- **Browser (real CSS)**: fixed L0 height across states, stagger classes present, reduced-motion renders no animation, chevron rotation, focus order.
- **Hydration parity**: §4.6.
- **E2E**: update `assistant-tool-card-visuals`, `assistant-retrieval`, `mcp-packaged-core`, web `assistant-ui-panel` to the new test ids and `data-state`; keep `assistant-approval-reload-linearity` green and extend it with the interrupted-approval reload case.
- **Architecture tests**: `assistant-ui-panel-architecture.test.ts` invariants move from `ChainOfThought: LocalChainOfThought` to `GroupedParts` + the new module names; the panel line budget must go down, not up.
- **CDT**: hosted-mock recipe over CDP; screenshots of live (shimmer + detail line), resting, expanded L1, L2 body, waiting-for-approval, reloaded thread, reduced motion. Those screenshots are the done criterion.

## 6. Docs to update in the same PRs

- `docs/agents/assistant-runtime.md`: rewrite the BST-1656 paragraph into an "Activity trace" section (grouping table, live/resting grammar, interrupted rule, `data-live` invariant); adjust "In-flight tool card progress" when the header moves.
- `docs/agents/ui-conventions.md`: the CSS motion grammar and reduced-motion rule.
- `docs/agents/assistant-persistence.md`: no change expected; hydration status stays `complete`. If phase 1 finds a producer that stamps anything else, that is a bug to file, not a contract change.

## 7. Phasing (three stacked PRs, each independently green and CDT-verified)

1. **Grouping migration + parity rule.** `GroupedParts` with the §4.1 `groupBy`; today's `AssistantActivityGroup` visuals kept. Leaving the legacy path also leaves the library's `chainOfThought` scope behind, so `LocalChainOfThought`'s reads of `state.chainOfThought.{parts,status,collapsed}` move to the group node's `status` and `indices` plus a local reasoning-collapsed state, and `ChainOfThoughtPrimitive.Parts` is replaced by the `GroupedParts` render function (`part.toolUI ?? <ActivityToolPart/>`, reasoning → the existing reasoning part or hidden). Fixtures gain data parts; `data-live` everywhere; interrupted rule; hydration invariant test; e2e sync attribute. Outcome: one "Worked for 20s · 6 steps" per run, elapsed always present, no hangers after reload. Ships value alone.
2. **Activity trace.** `activity-trace-model.ts`, `activity-verbs.ts`, `activity-trace.tsx` (L0/L1), CSS motion, reasoning/approval/subagent steps, detail-level mapping, docs. Replaces `AssistantActivityGroup` and `LocalChainOfThought`; deletes their tests in favour of the new ones (replacement in the same diff, per the squash-merge deletion rule).
3. **Step-row re-skin of the tool cards.** `ToolFallback` header becomes the row grammar; MCP, subagent, task-list and run_python bodies adopt it; `assistant-tool-card-visuals` screenshots refreshed; polish pass with `verify-rendered-ui`.

Each phase gets its own BST ticket; the epic references this document.

## 8. Decisions folded in (defaults chosen; say so if you want them changed)

1. **Resting wording**: primary text is the verb summary; `Worked for 12s` becomes the trailing meta rather than the headline. Alternative: keep `Worked for 12s` as the headline and put verbs in the detail line.
2. **Auto-expand while running**: off (Codex parity; L0 shows the current step). Alternative: keep today's auto-expand.
3. **Expand state persistence**: session-only per trace, not persisted. Codex does not persist it either.
4. **Where approvals live**: standalone cards outside the trace, unchanged, plus a waiting step inside. Alternative: fold the approval card into the trace as an inline step, which the library guidance argues against for human-in-the-loop UI.
5. **Vendoring**: port the assistant-ui element patterns onto `@brainstrike/ui` tokens; do not import `surfaces.tsx` or the beautifului foundation CSS (parallel token systems, unlayered base rules).
6. **Small-model summary**: seam only (`restingOverride` from message metadata), no producer.
7. **Phase 1 alone** is a legitimate stopping point if the trace work needs to wait.
