# Assistant Activity Trace — Phase 3 (step rows, tool-card re-skin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the activity group's body into the spec's L1 step list — one row per step in the Codex row grammar (family icon · verb in tense · target chip · duration · state glyph) — by re-skinning every tool card's own header into that grammar, so a step never shows two headers, and fold in the phase-2 follow-ups.

**Architecture:** One presentational `StepRowHeader` (new `activity-step-row.tsx`) owns the row grammar and is used by every card that renders inside a group: `ToolFallback`, `SubagentExecutionCard`, `TaskListToolCard`, and the reasoning block. Card bodies (details panes, live shell output, run_python surface, subagent child rows, task list) are unchanged and open on row click (L2). The reveal stagger is pure CSS (`:nth-child` inside the group's step list), so no row needs to know its index; the one fact a card cannot derive alone — whether it is the LAST running step, the only row that shimmers — comes from a tiny pure module plus a context the group provides, mirroring `ToolDurationProvider`. Verbs and states come from phase 2's `activity-verbs.ts` / `activity-trace-model.ts`; family icons are a new total map.

**Tech Stack:** TypeScript strict, React 19, `@assistant-ui/react ~0.15.18` (`MessagePrimitive.GroupedParts`), lucide-react, Vitest (unit + browser projects), Playwright, Biome/Ultracite. CSS only for motion (`overrides.css`; no animation library).

Spec: `docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md` §4.3 (L1, L2, detail level, approvals, subagents), §4.4, §4.5, §7 phase 3. Phase 1 (#3061) and phase 2 (#3064) are merged; this plan builds on `main` at or after 79ec3cde5.

## Global Constraints

- TypeScript strict. Never `any` — `unknown` + narrowing. Annotate params and return types. Discriminated unions over enums.
- NO FALLBACKS / NO SILENT DEGRADATION: a step's verb, state and icon derive only from canonical fields (`verbForTool`, `resolveCardStatus`, `ActivityStepState`); an unknown family cannot exist (the icon map is total over `VerbFamily` and the `Record` type proves it).
- No new dependencies. No animation library. Motion lives in `overrides.css` under `.assistant-ui-panel` with `prefers-reduced-motion` blocks. The browser Vitest lane loads NO Tailwind utilities: any geometry a browser test measures must be owned by `overrides.css` (phase-2 landmine).
- Keys/props/interface members sorted alphabetically (Biome); nested ternaries disallowed; `biome-ignore` comments carry a reason; filenames kebab-case; components PascalCase.
- Contracts that must keep holding (pinned by existing tests; never weaken): groups collapsed by default, user toggle sticks; `data-state`, `data-live` (only animated indicators; none on a hydrated thread except a pending pause), `data-failed`, `data-failed-steps`; the activity-parts headline rule; the trailing-group indicator rule; BST-1656 chronology (text splits groups; a manual reasoning open survives later parts); the `hidden` attribute on the group body; the phase-2 header grammar (`Read, searched, edited 2 files +1 more · Worked for 19.5s · 5 steps · 1 failed`).
- Test ids and accessible names kept: `assistant-activity-group/summary/body/working/failed-count`, `local-chain-of-thought` + `Show thinking`/`Hide thinking`, `assistant-reasoning-indicator`, `assistant-reasoning-static-mark` (+ `bs-thinking-mark-static`, which the architecture test pins to `assistant-thinking-indicator.tsx`), `tool-fallback` + `data-tool-category`, the status `role="img"` names `Completed` / `Running` / `Failed` / `Stopped` (`Waiting for approval` replaces `Unknown` — Task 4), the `Expand details` / `Collapse details` button names, `checkpoint-*` test ids. e2e (`mcp-packaged-core`, `assistant-tool-card-visuals`, `assistant-retrieval`, web `assistant-ui-panel`) query exactly these — grep before renaming anything.
- A tool card must still CONTAIN its raw tool id as text (`assistant-retrieval` asserts `toContainText('brainstrike.retrieveContext')`; `mcp-packaged-core` filters `hasText: 'legacy.echo'`): the row shows verb + target visibly and carries the tool id in a visually hidden span and as the row's `title`.
- Nested interactive controls are invalid HTML: the step row is a `<button>`; the checkpoint revert button and any other control are siblings in the same flex line.
- `tool-fallback.tsx` (724 lines) must shrink, not grow — record the before/after line counts. `assistant-ui-panel.tsx` untouched.
- Every guard has a recorded mutation check. `pnpm dlx ultracite fix` before every commit. Unit: `cd packages/assistant-ui && pnpm vitest run --project unit <file>`; browser: `pnpm vitest run --project browser <file>`; types: `pnpm --filter @brainstrike/assistant-ui type-check`. Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Live CDT verification with screenshots is the definition of done (Task 8).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/assistant-ui/src/activity-step-meta.ts` | **New, pure.** `deriveStepMeta(steps)` → `{ lastRunningId }` — which tool step (by `toolCallId`) is the last running one. |
| `packages/assistant-ui/src/activity-step-context.tsx` | **New.** `ActivityStepMetaProvider` / `useIsLastRunningStep(id)` (pattern: `tool-duration-context.tsx`). |
| `packages/assistant-ui/src/activity-step-icons.tsx` | **New.** `FAMILY_ICONS: Record<VerbFamily, LucideIcon>` (total) and `StepStateGlyph` (state → named glyph; `data-live` only while running). |
| `packages/assistant-ui/src/activity-step-row.tsx` | **New.** `StepRowHeader`: the L1 row grammar as one presentational component. |
| `packages/assistant-ui/src/tool-fallback.tsx` | Header replaced by `StepRowHeader`; `unknown` status → `waiting` (`Waiting for approval`); body unchanged. Shrinks. |
| `packages/assistant-ui/src/subagent-execution-card.tsx` | Header replaced by `StepRowHeader` (`Delegating to Explorer` → `Explorer finished · 40 tool calls`); child rows unchanged. |
| `packages/assistant-ui/src/todo-progress.tsx` | `TaskListToolCard`'s `<details>` summary replaced by `StepRowHeader` (family `tasks`); body unchanged. |
| `packages/assistant-ui/src/assistant-activity-parts.tsx` | `ActivityReasoningBlock` renders through `StepRowHeader`; `ActivityGroup` provides step meta and wraps the body in `.bs-step-list`. |
| `packages/assistant-ui/src/activity-trace.tsx` | Phase-2 follow-up: the resting label's enter animation skips first mount. |
| `packages/assistant-ui/src/overrides.css` | `.bs-step-list` (nth-child stagger), `.bs-step-row*` grammar (stylesheet-owned geometry), reduced motion. |
| Tests | new `activity-step-meta.test.ts`, `activity-step-icons.test.tsx`, `activity-step-row.test.tsx` + `.browser.test.tsx`; migrated `tool-fallback*.test.tsx` (six files exist: `tool-fallback`, `-a11y`, `-detail-level`, `-duration`, `-panel`, `-progress`, plus `tool-fallback.browser.test.tsx`), `subagent-execution-card.test.tsx`, `todo-progress.test.tsx`, `assistant-activity-parts.test.tsx`, `assistant-reasoning-disclosure.behavior.test.tsx`, `assistant-activity-timeline.behavior.test.tsx`, `activity-trace.test.tsx` / `.browser.test.tsx`; e2e artifacts refreshed. |
| Docs | `docs/agents/assistant-runtime.md` ACTIVITY GROUPS (L1/L2, waiting step, detail level), `docs/agents/ui-conventions.md` (row grammar), spec §4.3 status note. |

---

### Task 1: Last-running step (pure) + context

**Files:**
- Create: `packages/assistant-ui/src/activity-step-meta.ts`, `packages/assistant-ui/src/activity-step-context.tsx`
- Test: `packages/assistant-ui/src/__tests__/activity-step-meta.test.ts`

**Interfaces:**
- Consumes: `ActivityStep` from `./activity-trace-model` (`id`, `kind`, `state`).
- Produces:

```ts
export interface ActivityStepMeta {
  /** `toolCallId` of the LAST tool step in part order whose state is `running`; null when none. Only that row shimmers (spec §4.3 L1). */
  readonly lastRunningId: string | null;
}
export function deriveStepMeta(steps: readonly ActivityStep[]): ActivityStepMeta;
export function ActivityStepMetaProvider(props: { children: ReactNode; meta: ActivityStepMeta }): ReactNode;
/** True iff `id` is the group's last running tool step. Outside a provider (no group) every id answers true, so a standalone running card still shimmers. */
export function useIsLastRunningStep(id: string | undefined): boolean;
```

Reasoning steps are excluded on purpose: a streaming reasoning part is always the last running step (a tool-call part closes it), and its row keeps its own indicator (Task 5).

- [ ] **Step 1: Write the failing test**

```ts
// packages/assistant-ui/src/__tests__/activity-step-meta.test.ts
import { describe, expect, it } from 'vitest';
import { deriveStepMeta } from '../activity-step-meta';
import type { ActivityStep } from '../activity-trace-model';
import { verbForTool } from '../activity-verbs';

const step = (id: string, state: ActivityStep['state'], partIndex: number, kind: ActivityStep['kind'] = 'tool'): ActivityStep => ({
  durationMs: undefined,
  id,
  kind,
  partIndex,
  state,
  target: null,
  targetKey: null,
  verb: verbForTool('brainstrike.readWorkspaceFile'),
});

describe('deriveStepMeta', () => {
  it('names the last running TOOL step in part order', () => {
    expect(deriveStepMeta([step('a', 'done', 0), step('b', 'running', 2), step('c', 'running', 3)])).toEqual({ lastRunningId: 'c' });
  });

  it('ignores reasoning steps and yields null when no tool step runs', () => {
    expect(deriveStepMeta([step('reasoning-0', 'running', 0, 'reasoning'), step('a', 'waiting', 1)])).toEqual({ lastRunningId: null });
    expect(deriveStepMeta([])).toEqual({ lastRunningId: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm vitest run --project unit src/__tests__/activity-step-meta.test.ts` → module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/assistant-ui/src/activity-step-meta.ts
import type { ActivityStep } from './activity-trace-model';

export interface ActivityStepMeta {
  /** `toolCallId` of the LAST tool step in part order whose state is `running`; null when none. */
  readonly lastRunningId: string | null;
}

/**
 * The one presentation fact a card cannot derive from its own props: whether
 * it is the group's last running step — the only row that shimmers (spec
 * §4.3 L1). Pure; the group computes it once per snapshot and hands it down
 * through `ActivityStepMetaProvider`. Reasoning steps are excluded: a
 * streaming reasoning part is always last (a tool-call part closes it) and
 * its row keeps its own indicator.
 */
export function deriveStepMeta(steps: readonly ActivityStep[]): ActivityStepMeta {
  const last = steps.findLast((step) => step.kind === 'tool' && step.state === 'running');
  return { lastRunningId: last?.id ?? null };
}
```

```tsx
// packages/assistant-ui/src/activity-step-context.tsx
import { createContext, type ReactNode, use } from 'react';
import type { ActivityStepMeta } from './activity-step-meta';

/**
 * Per-group step facts (see `deriveStepMeta`). The group provides them; the
 * nested cards read their own answer without needing the AUI runtime (which
 * keeps them unit-testable in isolation). Undefined by default: a card
 * rendered outside any group answers "yes, I am the last running step", so a
 * standalone running card still shimmers.
 */
const ActivityStepMetaContext = createContext<ActivityStepMeta | undefined>(undefined);

export function ActivityStepMetaProvider({
  children,
  meta,
}: {
  children: ReactNode;
  meta: ActivityStepMeta;
}): ReactNode {
  return <ActivityStepMetaContext.Provider value={meta}>{children}</ActivityStepMetaContext.Provider>;
}

export function useIsLastRunningStep(id: string | undefined): boolean {
  const meta = use(ActivityStepMetaContext);
  if (meta === undefined) {
    return true;
  }
  return id !== undefined && meta.lastRunningId === id;
}
```

- [ ] **Step 4: Run test to verify it passes** (2 tests). Type-check.
- [ ] **Step 5: Mutate once** — return the FIRST running step → the first test fails. Revert. Record.
- [ ] **Step 6: Commit** — `feat(assistant-ui): last-running step fact and context for the activity step list` + trailer.

---

### Task 2: Family icons and the state glyph

**Files:**
- Create: `packages/assistant-ui/src/activity-step-icons.tsx`
- Test: `packages/assistant-ui/src/__tests__/activity-step-icons.test.tsx`

**Interfaces:**
- Consumes: `VerbFamily` from `./activity-verbs`; `ActivityStepState` from `./activity-trace-model`; `BrainstrikeThinkingMark` from `./assistant-thinking-indicator` (`live`, `testId`).
- Produces:

```ts
export const FAMILY_ICONS: Readonly<Record<VerbFamily, LucideIcon>>;
export type StepGlyphState = ActivityStepState | 'no-answer';
export const STEP_STATE_LABELS: Readonly<Record<StepGlyphState, string>>; // cancelled: Stopped, done: Completed, failed: Failed, 'no-answer': No answer, running: Running, waiting: Waiting for approval
export function StepFamilyIcon(props: { readonly family: VerbFamily; readonly icon?: LucideIcon }): ReactNode; // `icon` overrides the family icon (reasoning passes Brain)
export function StepStateGlyph(props: { readonly state: StepGlyphState }): ReactNode;
```

`StepStateGlyph` renders `<span aria-label={STEP_STATE_LABELS[state]} className="bs-step-glyph" role="img">…</span>`: `running` → `<BrainstrikeThinkingMark className="size-4" testId="step-running-mark" />` (live, carries `data-live="true"`); `done` → `CheckCircle` (`text-green-600 dark:text-green-500`, as the cards use today); `failed` → `AlertCircle` `text-destructive`; `cancelled` → `CircleSlash` muted; `waiting` → `CircleDashed` muted, static (no `data-live`); `no-answer` → `AlertCircle` amber (`text-amber-600 dark:text-amber-500`, the subagent card's existing choice). Icons: `read` FileText, `search` Search, `edit` Pencil, `run` Terminal, `web` Globe, `canvas` LayoutTemplate, `tasks` ListChecks, `worktree` GitBranch, `skill` Sparkles, `ask` MessageCircle (lucide 0.4xx has no `MessageCircleQuestion`; `MessageCircle` exists), `delegate` Users, `call` Plug, `other` Wrench. All verified present in the installed lucide-react. Every icon gets `aria-hidden="true"`.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/assistant-ui/src/__tests__/activity-step-icons.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FAMILY_ICONS, STEP_STATE_LABELS, StepStateGlyph } from '../activity-step-icons';
import type { VerbFamily } from '../activity-verbs';

const FAMILIES: readonly VerbFamily[] = ['ask', 'call', 'canvas', 'delegate', 'edit', 'other', 'read', 'run', 'search', 'skill', 'tasks', 'web', 'worktree'];

describe('FAMILY_ICONS', () => {
  it('has an icon for every verb family', () => {
    for (const family of FAMILIES) {
      expect(FAMILY_ICONS[family], family).toBeDefined();
    }
  });
});

describe('StepStateGlyph', () => {
  it('names every state for assistive tech and is live only while running', () => {
    const { rerender } = render(<StepStateGlyph state="running" />);
    expect(screen.getByRole('img', { name: STEP_STATE_LABELS.running })).toBeInTheDocument();
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(1);
    for (const state of ['done', 'failed', 'cancelled', 'waiting', 'no-answer'] as const) {
      rerender(<StepStateGlyph state={state} />);
      expect(screen.getByRole('img', { name: STEP_STATE_LABELS[state] })).toBeInTheDocument();
      expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(0);
    }
  });

  it('spells the labels the e2e specs query', () => {
    expect(STEP_STATE_LABELS).toEqual({ cancelled: 'Stopped', done: 'Completed', failed: 'Failed', 'no-answer': 'No answer', running: 'Running', waiting: 'Waiting for approval' });
  });
});
```

If `VerbFamily` gains a member, the `Record` type fails to compile before the runtime loop can miss it — that is the totality guard.

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** per the interface (one file; keys alphabetical; `StepFamilyIcon` renders `<span aria-hidden="true" className="bs-step-family-icon"><Icon className="size-4" /></span>`).
- [ ] **Step 4: Run to verify it passes.** Mutate: give `waiting` a live mark → the data-live assertion fails. Revert. Record.
- [ ] **Step 5: Commit** — `feat(assistant-ui): verb-family icons and the step state glyph` + trailer.

---

### Task 3: `StepRowHeader` (the row grammar) + CSS

**Files:**
- Create: `packages/assistant-ui/src/activity-step-row.tsx`
- Modify: `packages/assistant-ui/src/overrides.css` (append after the `bs-trace-*` block)
- Test: `packages/assistant-ui/src/__tests__/activity-step-row.test.tsx` (jsdom), `packages/assistant-ui/src/__tests__/activity-step-row.browser.test.tsx`

**Interfaces:**
- Consumes: Task 1 `useIsLastRunningStep`; Task 2 `StepFamilyIcon`, `StepStateGlyph`, `StepGlyphState`; `VerbFamily`; `cn` from `@brainstrike/ui`.
- Produces:

```ts
export interface StepRowHeaderProps {
  /** id of the body this row toggles; omit when the row has no body (renders a non-interactive row: no button, no chevron, no aria-expanded). */
  readonly bodyId?: string;
  readonly expanded?: boolean;
  readonly family: VerbFamily;
  /** Replaces the state glyph (the reasoning row passes its own indicator / static mark so the phase-1 test ids stay put). */
  readonly glyph?: ReactNode;
  /** Overrides the family icon (reasoning passes `Brain`). */
  readonly icon?: LucideIcon;
  /** Accessible name of the toggle: "Expand details" / "Collapse details" (kept for e2e), or "Show thinking" / "Hide thinking". */
  readonly label: string;
  readonly onToggle?: () => void;
  readonly state: StepGlyphState;
  /** Step id (`toolCallId`) for the last-running lookup; omit for reasoning. */
  readonly stepId?: string;
  /** Target chip (primary arg display); null when none. */
  readonly target: string | null;
  /** Untruncated target for the tooltip. */
  readonly targetTitle?: string;
  /** `data-testid` of the row element (default `activity-step-row`; the reasoning row keeps `local-chain-of-thought`). */
  readonly testId?: string;
  /** Timing slot: live progress label or settled duration — the caller decides (ToolFallback keeps `ToolRunTiming`). */
  readonly timing?: ReactNode;
  /** Raw tool id (visually hidden text + `title`) — the e2e text contract. Omit for reasoning. */
  readonly toolName?: string;
  /** Extra trailing content inside the row (result summary, root name); spans only, never controls. */
  readonly trailing?: ReactNode;
  /** The verb in tense: `Reading` while running, `Read` once settled. */
  readonly verb: string;
}
export function StepRowHeader(props: StepRowHeaderProps): ReactNode;
```

Markup contract (the interactive form; the non-interactive form is the same content in a `<div className="bs-step-row" role="group" …>` without `aria-expanded`/chevron — build it with a small `RowShell` helper, no nested ternaries):

```tsx
<button
  aria-controls={bodyId} aria-describedby={contentId} aria-expanded={expanded} aria-label={label}
  className="bs-step-row bs-trace-reveal" data-state={state} data-testid={testId ?? 'activity-step-row'}
  onClick={onToggle} title={toolName} type="button"
>
  <StepFamilyIcon family={family} icon={icon} />
  <span className="bs-step-row-content" id={contentId}>
    <span className={cn('bs-step-row-verb', shimmer && 'bs-thinking-shimmer')}>{verb}</span>
    {target ? <span className="bs-step-row-target" title={targetTitle ?? target}>{target}</span> : null}
    {toolName ? <span className="sr-only">{toolName}</span> : null}
    {trailing}
  </span>
  <span className="bs-step-row-timing">{timing}</span>
  {glyph ?? <StepStateGlyph state={state} />}
  {bodyId ? <ChevronRight aria-hidden="true" className="bs-trace-glyph size-3.5" /> : null}
</button>
```

`shimmer = state === 'running' && useIsLastRunningStep(stepId)`. The stagger needs no JS: the group body is `.bs-step-list` and the CSS below assigns `--bs-stagger` by `:nth-child`.

CSS to add (stylesheet-owned geometry — the browser lane has no Tailwind):

```css
/* ACTIVITY STEP ROWS (phase 3, spec §4.3 L1). One row per step in the group
   body: family icon · verb (tense follows state) · target chip · timing ·
   state glyph · chevron. Geometry lives here, not in utilities, so the
   browser lane measures the real thing (phase-2 landmine). The reveal
   stagger is positional: `.bs-step-list` children pick up `--bs-stagger`
   from their nth-child index (capped at 5), so no row needs to know its
   index and a row already visible never re-animates (the animation runs
   once per mount). */
.assistant-ui-panel .bs-step-list > :nth-child(2) { --bs-stagger: 1; }
.assistant-ui-panel .bs-step-list > :nth-child(3) { --bs-stagger: 2; }
.assistant-ui-panel .bs-step-list > :nth-child(4) { --bs-stagger: 3; }
.assistant-ui-panel .bs-step-list > :nth-child(5) { --bs-stagger: 4; }
.assistant-ui-panel .bs-step-list > :nth-child(n + 6) { --bs-stagger: 5; }

.assistant-ui-panel .bs-step-row-line {
  align-items: center;
  display: flex;
  gap: 0.375rem;
  min-width: 0;
}

.assistant-ui-panel .bs-step-row {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 0.375rem;
  color: inherit;
  display: flex;
  flex: 1 1 auto;
  font: inherit;
  gap: 0.5rem;
  min-height: 2rem;
  min-width: 0;
  padding: 0.25rem 0.5rem;
  text-align: left;
}

.assistant-ui-panel button.bs-step-row:hover {
  background: hsl(var(--muted) / 0.35);
}

.assistant-ui-panel .bs-step-row-content {
  align-items: baseline;
  display: flex;
  flex: 1 1 auto;
  gap: 0.5rem;
  min-width: 0;
}

.assistant-ui-panel .bs-step-row-verb {
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 500;
}

.assistant-ui-panel .bs-step-row-target {
  color: hsl(var(--muted-foreground));
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.6875rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-ui-panel .bs-step-row-meta,
.assistant-ui-panel .bs-step-row-timing {
  color: hsl(var(--muted-foreground));
  flex-shrink: 0;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}

.assistant-ui-panel .bs-step-glyph,
.assistant-ui-panel .bs-step-family-icon {
  block-size: 1rem;
  display: inline-flex;
  flex-shrink: 0;
  inline-size: 1rem;
}

.assistant-ui-panel .bs-step-row[data-state="failed"] .bs-step-row-verb {
  color: hsl(var(--destructive));
}
```

`prefers-reduced-motion` needs nothing new (`bs-trace-reveal` and `bs-thinking-shimmer` are already covered); the failed verb colour is plain text — the existing `forced-colors` block for `.bs-thinking-shimmer` still applies to the shimmer.

- [ ] **Step 1: Write the failing unit test** — (a) interactive row: `role=button` named `Expand details`, `aria-expanded="false"`, `aria-describedby` → an element containing the verb and target, `getByText('brainstrike.readWorkspaceFile')` present (sr-only), `data-state="done"`, glyph `Completed`, chevron present; (b) no `bodyId`: no button, no chevron; (c) `state="running"` outside a provider → the verb has `bs-thinking-shimmer` and exactly one `[data-live="true"]`; (d) two running rows under `ActivityStepMetaProvider meta={{ lastRunningId: 'b' }}` → only row `b`'s verb shimmers; (e) `glyph` override renders instead of `StepStateGlyph` (assert the override's test id and that no `bs-step-glyph` exists).
- [ ] **Step 2: Run to verify it fails.** Implement per the contract. Run to verify it passes.
- [ ] **Step 3: Browser test** (`activity-step-row.browser.test.tsx`, imports `@brainstrike/ui/globals.css` + `../overrides.css`): (a) a 300-char target in a 480 px `.bs-step-list` container keeps the timing slot and glyph inside the row's right edge and the row on one line (`getBoundingClientRect().height < 40`); (b) six rows in a `.bs-step-list`: `getComputedStyle(row).animationDelay` for rows 1, 2 and 7 equals 0, one step, and five steps (the cap). Run; fix CSS, never the assertion.
- [ ] **Step 4: Mutations** — (a) drop `min-width: 0` on `.bs-step-row-target` → (a) fails; (b) shimmer every running row → unit case (d) fails; (c) delete the `:nth-child(n + 6)` rule → browser (b) fails. Revert each. Record.
- [ ] **Step 5: Commit** — `feat(assistant-ui): StepRowHeader — the activity step row grammar (icon · verb · target · timing · glyph)` + trailer.

---

### Task 4: `ToolFallback` header becomes the step row

**Files:**
- Modify: `packages/assistant-ui/src/tool-fallback.tsx`
- Modify tests: `tool-fallback.test.tsx`, `tool-fallback-a11y.test.tsx`, `tool-fallback-detail-level.test.tsx`, `tool-fallback-duration.test.tsx`, `tool-fallback-panel.test.tsx`, `tool-fallback-progress.test.tsx`, `tool-fallback.browser.test.tsx`, `assistant-activity-parts.test.tsx`, `assistant-activity-timeline.behavior.test.tsx`, `assistant-chat-polish.browser.test.tsx` (any assertion that read the raw tool name as VISIBLE text, the separate `Expand details` button, or the `Unknown` status name).

**Interfaces:**
- Consumes: Task 3 `StepRowHeader`; Task 2 `StepGlyphState`; `verbForTool` (`./activity-verbs`); existing `resolveCardStatus`, `ToolRunTiming`, `extractPrimaryArg`, `summarizeResult`, `CheckpointRevertButton`, `ToolDetailsPane`, `LiveShellOutputRegion`, `RunPythonResultRegion`, the display policy.
- Produces: the same `ToolFallback: ToolCallMessagePartComponent` export; `data-testid="tool-fallback"` + `data-tool-category` on the card root; the status `role="img"` name via `StepStateGlyph`; the toggle is the ROW BUTTON named `Expand details` / `Collapse details` (the separate `DetailsToggleButton` and the status `Tooltip` are deleted); the checkpoint revert button follows the row button as a sibling inside `.bs-step-row-line`.

Mapping `DisplayStatus` → `StepGlyphState`: `running` → `running`, `success` → `done`, `error` → `failed`, `stopped` → `cancelled`, `unknown` → `waiting`. The `unknown` case is exactly the resultless call on a settled/paused message that BST-1678 describes as a grey "Unknown" — it now reads `Waiting for approval` with a static outline glyph (spec §4.3 "Approvals"). Rename the `DisplayStatus` member `unknown` → `waiting` and `STATUS_LABELS.waiting = 'Waiting for approval'` so the card and the trace agree; delete `STATUS_ICONS` if nothing else consumes it (grep).

Verb: `const verb = verbForTool(toolName); const verbLabel = glyphState === 'running' ? verb.active : verb.done;` (a waiting/cancelled/failed step reads the past tense with the glyph carrying the state — consistent with `restingLabel`, which lists failed verbs in the done tense).

- [ ] **Step 1: Write the failing tests** (in `tool-fallback.test.tsx`, real renders, no mocks):
  - running `brainstrike.readWorkspaceFile` with `args: { path: 'src/app.ts' }`: no details pane exists while running (`showDetails` false), so the row is NON-interactive — assert no `button` in the card, verb `Reading`, target `src/app.ts`, glyph `Running`, exactly one `[data-live="true"]`.
  - the same call with a result: verb `Read`, glyph `Completed`, row button `Expand details` with `aria-expanded="false"` and `aria-describedby` → content containing `Read` and `src/app.ts`; sr-only text `brainstrike.readWorkspaceFile`; `data-tool-category` unchanged; clicking the row opens the details pane (`aria-expanded="true"`, the Arguments label visible) and renames the button `Collapse details`.
  - a resultless call with `status: { type: 'complete' }` → glyph `Waiting for approval`, static (0 live).
  - an `isError` result → done-tense verb, glyph `Failed`, error line still rendered under the row.
  - a revertible mutation with a captured checkpoint (copy the fixture from the existing checkpoint test) → the checkpoint button is a SIBLING after the row (`row.nextElementSibling` contains `checkpoint-revert`), not a descendant.
- [ ] **Step 2: Run to verify they fail.** Implement: replace the header block (`<div className="flex min-w-0 items-center gap-2 px-2 py-1">` … status tooltip, tool name, primary arg, `ToolRunTiming`, result summary, root name, checkpoint button, `DetailsToggleButton` … `</div>`) with:

```tsx
<div className="bs-step-row-line px-1">
  <StepRowHeader
    bodyId={showDetails ? detailsId : undefined}
    expanded={showDetails ? !isCollapsed : undefined}
    family={verb.family}
    label={isCollapsed ? 'Expand details' : 'Collapse details'}
    onToggle={showDetails ? () => setUserCollapsed(!isCollapsed) : undefined}
    state={glyphState}
    stepId={toolCallId}
    target={primaryArg?.display ?? null}
    targetTitle={primaryArg?.full}
    timing={
      <ToolRunTiming
        argsStreaming={argsStreaming}
        durationLabel={durationLabel}
        isRunning={isRunning}
        progressLabel={progressLabel}
      />
    }
    toolName={toolName}
    trailing={
      <>
        {resultSummary ? <span className="bs-step-row-meta">{resultSummary}</span> : null}
        {resolvedRootName ? (
          <span className="bs-step-row-meta" title={`Resolved workspace root: ${resolvedRootName}`}>
            in {resolvedRootName}
          </span>
        ) : null}
      </>
    }
    verb={verbLabel}
  />
  {isRunning || isError ? null : <CheckpointRevertButton toolCallId={toolCallId} toolName={toolName} />}
</div>
```

Keep the card root (`bs-tool-timeline`, tint, `data-testid`, `data-tool-category`), the error line, `LiveShellOutputRegion`, `RunPythonResultRegion`, `ToolDetailsPane` exactly as they are. `ToolRunTiming`'s running branch renders `AssistantThinkingIndicator` (a second live mark next to the glyph). Give `AssistantThinkingIndicator` an optional `showMark?: boolean` prop (default `true`; when `false` it renders only the shimmer label, keeps `data-testid="assistant-thinking-indicator"` and `data-args-streaming`, and emits NO `data-live` element) and pass `showMark={false}` from `ToolRunTiming`, so the row carries exactly ONE live mark (the glyph). `tool-fallback-progress.test.tsx` reads `assistant-thinking-indicator` by test id and its text — both stay; add one assertion there that the timing slot has no `[data-live="true"]` of its own.

- [ ] **Step 3: Run the ToolFallback suites, then the FULL package (`pnpm test && pnpm test:browser`)** — migrate every assertion that depended on the old header. Type-check. `wc -l src/tool-fallback.tsx` must be lower than 724 (record both numbers).
- [ ] **Step 4: Mutations** — (a) map `unknown` → `done` → the waiting case fails; (b) put the checkpoint button inside the row button → the sibling case fails; (c) always `verb.done` → the running case (`Reading`) fails; (d) pass `showMark` (true) from `ToolRunTiming` → the "exactly one live" assertion fails. Revert each. Record.
- [ ] **Step 5: Commit** — `feat(assistant-ui): ToolFallback's header is the activity step row; a paused call reads Waiting for approval` + trailer.

---

### Task 5: Reasoning, subagent and task-list steps; the group provides step meta

**Files:**
- Modify: `packages/assistant-ui/src/assistant-activity-parts.tsx` (`ActivityReasoningBlock`, `ActivityGroup`), `packages/assistant-ui/src/subagent-execution-card.tsx`, `packages/assistant-ui/src/todo-progress.tsx` (`TaskListToolCard`)
- Tests: `assistant-reasoning-disclosure.behavior.test.tsx`, `assistant-activity-parts.test.tsx`, `subagent-execution-card.test.tsx`, `todo-progress.test.tsx`, `assistant-activity-timeline.behavior.test.tsx`.

**Interfaces:**
- Consumes: Tasks 1–3; `personaLabelForToolName`; the `steps` `ActivityGroup` already derives.
- Produces: `ActivityGroup` computes `const stepMeta = useMemo(() => deriveStepMeta(steps), [steps])` and renders `<ActivityStepMetaProvider meta={stepMeta}><ActivityTrace …><div className="bs-step-list">{children}</div></ActivityTrace></ActivityStepMetaProvider>` (the provider wraps the trace so the reasoning block and every card are inside it; `ActivityPartLayout`'s wrapper div is what `:nth-child` counts — keep one wrapper per step).

Per card:
- **Reasoning** (`ActivityReasoningBlock`): `StepRowHeader` with `bodyId={panelId}`, `expanded={open}`, `family="other"`, `icon={Brain}`, `label={reasoningToggleLabel(open)}` (`Show thinking` / `Hide thinking`), `state={isStreaming ? 'running' : 'done'}`, `testId="local-chain-of-thought"`, `verb={isStreaming ? 'Thinking' : 'Thought'}`, and `glyph=` the EXISTING markup — while streaming `<AssistantThinkingIndicator className="min-w-0" markClassName="size-4" textClassName="sr-only" />`? NO: the verb already reads `Thinking`, so pass `glyph={<BrainstrikeThinkingMark className="size-4" testId="assistant-reasoning-live-mark" />}` while streaming and `<span className="bs-thinking-indicator" data-testid="assistant-reasoning-indicator"><BrainstrikeThinkingMark className="size-4" live={false} testId="assistant-reasoning-static-mark" /></span>` once settled — the phase-1 tests read `assistant-reasoning-indicator` / `assistant-reasoning-static-mark` and the `Thought` text (now the verb; keep `getByText('Thought', { exact: true })` satisfied by rendering the verb span only once). The body (`AssistantReasoningPart` when open, `bs-chain-of-thought-panel`) is unchanged.
- **Subagent** (`SubagentExecutionCard`): `family="delegate"`; verb `Delegating to <Label>` while running, `<Label> finished` on success, `<Label> gave no answer` (glyph `no-answer`), `<Label> failed` (glyph `failed`); `target={null}`; `trailing` = `<span className="bs-step-row-meta">· {rows.length} tool {calls}</span>`; `timing` = elapsed; `bodyId` only when `hasRows`; `label` `Expand details` / `Collapse details`; `toolName={toolName}` (sr-only `agent-explore`). Child rows unchanged. The card's own `STATUS_ICONS`/`STATUS_LABELS` go away (the glyph owns them); `ROW_ICONS` for child rows stay.
- **Task list** (`TaskListToolCard`): replace `<details>`/`<summary>` with local `useState(false)` + `StepRowHeader` (`family="tasks"`, verb `Updating tasks` while `status.type === 'running'` else `Updated tasks`, `bodyId`, `label` `Expand details`/`Collapse details`, `toolName={NATIVE_TOOL_ID.manageTaskList}`) above the existing body, rendered only when open.

- [ ] **Step 1: Write the failing tests** (RED against the current cards):
  - behaviour (runtime harness): a group `[reasoning, tool a (done), tool b (running)]`, after expanding, renders three rows in part order — `local-chain-of-thought`, then two `activity-step-row` — and ONLY tool b's verb carries `bs-thinking-shimmer`.
  - reasoning: the existing disclosure suite passes unchanged (ids/labels are the contract); add `data-state="running"` while streaming and `done` after.
  - subagent: running → `Delegating to Explorer` + glyph `Running`; done with 3 rows → `Explorer finished`, `· 3 tool calls`, glyph `Completed`; no-answer → `Explorer gave no answer`, glyph `No answer`.
  - task list: `Updated tasks`, `Expand details` opens the list.
- [ ] **Step 2: Implement; full package suites; type-check; ultracite.** `assistant-activity-parts.tsx` may grow only by the provider wiring; `ActivityReasoningBlock`'s markup shrinks.
- [ ] **Step 3: Mutations** — (a) omit the provider in `ActivityGroup` → both running rows shimmer → the behaviour case fails; (b) subagent verb always `Delegating to` → the finished case fails. Revert; record.
- [ ] **Step 4: Commit** — `feat(assistant-ui): reasoning, subagent and task-list steps render the step row; the group provides the last-running fact` + trailer.

---

### Task 6: Detail level, waiting step end-to-end, and the phase-2 follow-ups

**Files:**
- Modify: `packages/assistant-ui/src/activity-trace.tsx`, `packages/assistant-ui/src/overrides.css`, `packages/assistant-ui/src/__tests__/activity-trace.browser.test.tsx`, `packages/assistant-ui/src/__tests__/assistant-activity-parts.test.tsx`, `packages/assistant-ui/src/__tests__/tool-fallback-detail-level.test.tsx`.

- [ ] **Step 1: Detail level (verify, then pin).** `compact` → rows without result summaries (`policy.showResultSummary=false` → `trailing` empty); `standard` → with summaries; `developer` → bodies open by default (`policy.defaultExpanded=true` → `isCollapsed=false` on mount; the row's `aria-expanded="true"` at mount) and run-event rows inside the group (the `data` parts render through `part.dataRendererUI`, whose renderer already gates on `shouldShowBackgroundActivity`). Add one case per level to `tool-fallback-detail-level.test.tsx` (it already wraps in `AssistantDetailLevelProvider`) asserting compact → no `bs-step-row-meta`; standard → the summary present; developer → `aria-expanded="true"` on mount. If a level does not behave as the spec says, that is a finding — report it, do not paper over it.
- [ ] **Step 2: Waiting step inside the trace.** Runtime test in `assistant-activity-parts.test.tsx`: a `requires-action` message with a resultless call inside a group, after expanding: the row reads the done-tense verb, glyph `Waiting for approval`, static; the header reads `Waiting for approval` (phase 2) — exactly one `[data-live="true"]` in the whole group (the header mark). Mutation: give the waiting glyph a live mark → fails.
- [ ] **Step 3: Label enter animation only on change** (phase-2 follow-up): in `activity-trace.tsx` track `const mountedRef = useRef(false)` set true in a `useEffect`, and apply `bs-trace-label` to the keyed label only when the component had already mounted at render time (first render gets `bs-trace-label-static`: `animation: none`, added to `overrides.css`). Browser test in `activity-trace.browser.test.tsx`: on first mount `getComputedStyle(label).animationName === 'none'`; after `rerender` with a new `summary.live`, it is `bs-trace-label-enter`. Mutation: always animate → fails.
- [ ] **Step 4: Glyph-box parity** (phase-2 follow-up): in `activity-trace.browser.test.tsx` add `expect(px(getComputedStyle(glyphBox).blockSize)).toBe(16)` for both states, so the header's height parity is proven structurally, not only through `min-height`.
- [ ] **Step 5: Commit** — `fix(assistant-ui): detail-level pins, waiting step in the trace, label enters only on change, glyph-box parity` + trailer.

---

### Task 7: Docs

**Files:** `docs/agents/assistant-runtime.md` (ACTIVITY GROUPS), `docs/agents/ui-conventions.md` (Motion → add "Step rows"), `docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md` (§4.3 status note).

- [ ] **Step 1: ACTIVITY GROUPS.** Add an "L1 step rows / L2 bodies" subsection stating, with the code line for each claim: one `StepRowHeader` row per step in part order (family icon · verb in tense · target · timing · state glyph · chevron); the row IS the card's header (no second header) and the toggle for the card's body (`Expand details` / `Collapse details`; `aria-describedby` exposes the content); the raw tool id is visually hidden text (e2e text contract) and the row `title`; state glyphs are named (`Completed | Running | Failed | Stopped | Waiting for approval | No answer`) and never colour-only; a resultless call on a settled/paused message reads `Waiting for approval` (was `Unknown`; BST-1678 context); exactly one live mark per running row (the glyph; `ToolRunTiming` is text-only now); only the LAST running tool row shimmers (`deriveStepMeta` / `useIsLastRunningStep`; reasoning keeps its own indicator); rows reveal with `bs-trace-reveal` and a positional `:nth-child` stagger capped at 5 — a row already visible does not re-animate; reasoning/subagent/task-list rows and their verbs; the checkpoint revert control is a sibling of the row (nested interactives are invalid); detail level → summaries / bodies-open / run-event rows.
- [ ] **Step 2: ui-conventions.** "Step rows" paragraph: the grammar, stylesheet-owned geometry (`.bs-step-row*`, `.bs-step-list` stagger), the `role="img"` naming rule for state glyphs.
- [ ] **Step 3: Spec §4.3 status note:** L1/L2 shipped; per-step reasoning duration still not derivable (no reasoning duration source); `Unknown` → `Waiting for approval`; stagger is positional CSS rather than a JS index.
- [ ] **Step 4: Commit** — `docs(agents): activity step rows (L1/L2), waiting step, detail-level mapping` + trailer. Confirm heading structure unchanged (`grep -n "^## \|^### "`).

---

### Task 8: Gates, e2e refresh, CDT

- [ ] **Step 1:** `pnpm --filter @brainstrike/assistant-ui type-check`; `cd packages/assistant-ui && pnpm test && pnpm test:browser`; `pnpm run lint:ci`; `npx react-doctor . --scope changed --base origin/main` (0 new errors).
- [ ] **Step 2: e2e.** Desktop `assistant-tool-card-visuals` (refresh the `e2e-artifacts/tool-card-*.png` screenshots it writes — artifacts, not assertions), `assistant-retrieval`, `assistant-approval-reload-linearity`, `assistant-network-decision`, `mcp-packaged-core` (`--project=regression`; it uses `getByRole('img', { name: 'Completed' })` and the `Expand details` button inside a `tool-fallback` — both preserved); `pnpm build:web` then web e2e `keeps streamed tool details collapsed` (`PORT=8090` if 8080 is held).
- [ ] **Step 3: CDT (definition of done).** Reuse the phase-2 driver family from the session scratchpad (`launch-vite-p2.sh` / `launch-electron-p2.sh` pointed at this worktree, `drive-p8.mjs` + `scenario-p8.js` + `measure-p8.js`, `seed-p8.js` for the reload proof; recipe in `docs/agents/assistant-runtime.md` and the BST-1677 CDT report); extend the measurement with the rows (`[data-testid="activity-step-row"]` count, per-row `data-state`, computed `animation-delay`, which row carries `bs-thinking-shimmer`, live count per row). Screenshots: (50) expanded mid-run — rows revealed with the stagger, only the last running row shimmering, earlier rows settled with `Completed` glyphs; (51) a failed row (grep) with the destructive verb + `Failed` glyph and the error line beneath; (52) row click → L2 body (Arguments/Result panes) with `Collapse details`; (53) a paused call reading `Waiting for approval` in both header and row, one live mark total (use phase 1's abandoned-approval seed or a `tools: false` mock); (54) a subagent row `Explorer finished · N tool calls` (seed the `subAgentToolResults` shape from `subagent-execution-card.test.tsx` through the db bridge if the mock cannot stream one — say which); (55) reduced motion — no reveal/shimmer animation; (56) seeded reload: rows hydrate with `Completed`/`Failed` glyphs, 0 live. Paste the measured numbers into the report.
- [ ] **Step 4:** Open the PR (title `feat(BST-<n>): activity step rows — tool cards re-skinned into the L1 row grammar (phase 3)`, body per the phase-2 PR's shape with follow-ups), one push per review round, evidence-backed replies to every bot finding.
