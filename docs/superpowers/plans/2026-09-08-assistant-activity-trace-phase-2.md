# Assistant Activity Trace — Phase 2 (cycling status row, verb summaries, motion) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the activity group's generic "Working / Worked for Ns · N steps" header with a Codex-style status row that names the current step while running, settles into a verb summary when done, and animates its transitions — without changing the cards inside the group (that is phase 3).

**Architecture:** A pure model (`activity-trace-model.ts`) turns a group's parts plus the message's tool durations into typed `ActivityStep`s and an `ActivitySummary { live, resting, counts }`, using a verb vocabulary keyed by native tool id (`activity-verbs.ts`). A new presentational `ActivityTrace` component (`activity-trace.tsx`) replaces `AssistantActivityGroup`: same container contract (test ids, `data-state`, `data-live`, `data-failed`, `data-failed-steps`, collapsed by default, user toggle sticks), new header grammar, a fixed-height detail line while running, and CSS-only motion. `ActivityGroup` in `assistant-activity-parts.tsx` feeds it; reasoning blocks gain "Thinking → Thought for Ns" labels from the same model. An optional `restingOverride` read from message metadata is the seam for a future model-written summary (no producer).

**Tech Stack:** TypeScript strict, React 19, `@assistant-ui/react ~0.15.18` (`MessagePrimitive.GroupedParts`, `useAuiState`), Vitest (unit `jsdom` + browser projects), Playwright, Biome/Ultracite. CSS only for motion (no animation library — strict pnpm catalog, repo rule).

Spec: `docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md` §4.2–§4.5, §4.7, phase 2 of §7. Phase 1 (BST-1677, PR #3061) established the grouping, the liveness contract, collapsed-by-default groups with the header as the live cycler (`Thinking` / `Working <tool> <arg>`), per-block reasoning disclosure, the `· N failed` count, the activity-parts-only headline rule, and the trailing-group indicator rule; this plan builds on that code as merged.

## Global Constraints

- TypeScript strict. Never `any` — `unknown` + narrowing. Annotate params and return types. Discriminated unions over enums.
- NO FALLBACKS / NO SILENT DEGRADATION: an unknown tool gets the honest verb `Using <name>`; never a guessed verb. An absent duration renders no duration.
- No new dependencies. No animation library. Motion is CSS under `.assistant-ui-panel` in `packages/assistant-ui/src/overrides.css` with `prefers-reduced-motion` and `forced-colors` blocks (house rule).
- Keys/props/interface members sorted alphabetically (Biome); filenames kebab-case; components PascalCase; `biome-ignore` comments carry a reason.
- Contracts that must keep holding (pinned by existing tests; do not weaken): groups collapsed by default at all times, user toggle sticks per mounted group; `data-state="running"|"done"`; `[data-live="true"]` only on animated indicators and none on a hydrated thread except a pending pause; `data-failed` only for the group's own incomplete status; `data-failed-steps`; the `Stopped` / `Activity failed` headline is derived from the group's ACTIVITY parts (running if any runs, else the last reasoning/tool-call part's status) — never from a transparent data member and never from the message status (a group whose tools all resolved reads `Worked` on a cancelled/errored message); the message-level indicator slot renders only while the trailing group holds no activity (`trailingGroupHasActivity`); BST-1656 chronology (text splits groups; earlier groups stay inactive; manual reasoning open survives later parts); e2e sync on `aria-expanded="false"` after a turn.
- Test ids kept: `assistant-activity-group`, `assistant-activity-summary`, `assistant-activity-body`, `assistant-activity-working`, `assistant-activity-failed-count`, `local-chain-of-thought`, `assistant-reasoning-indicator`, `assistant-reasoning-static-mark`. Labels `Show thinking`/`Hide thinking`, `Expand activity`/`Collapse activity` kept. `Stopped` / `Activity failed` remain the incomplete headlines. The resting headline text CHANGES (verb summary); `Worked for Ns` becomes the trailing meta — update the tests and e2e that read `Worked` as the headline (listed per task).
- Header height is FIXED across live/resting states (scroll-anchoring rule, spec §4.7); the running detail line is a fixed-height slot that collapses once on finish.
- Live label region is `aria-live="off"`; a visually hidden state phrase flips `polite` only on state change (spec §4.5).
- `assistant-ui-panel.tsx` line budget must not grow. New UI lands in the new modules.
- Run `pnpm dlx ultracite fix` before every commit. Unit: `cd packages/assistant-ui && pnpm vitest run --project unit <file>`; browser: `pnpm vitest run --project browser <file>`; types: `pnpm --filter @brainstrike/assistant-ui type-check`. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Live CDT verification with screenshots is the definition of done (final task).

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/assistant-ui/src/activity-verbs.ts` | **New.** Verb vocabulary: native tool id → `{ active, done, family }`, plus rules for delegation (`agent-*`), MCP (`server.tool`), and unknown tools. Pure. |
| `packages/assistant-ui/src/activity-trace-model.ts` | **New.** `ActivityStep`, `ActivitySummary`, `deriveActivitySteps(parts, durations)`, `summarizeActivity(steps, options)`. Pure. |
| `packages/assistant-ui/src/activity-trace.tsx` | **New.** `ActivityTrace` presentational container (header row, detail line, collapsible body) replacing `assistant-activity-group.tsx`; owns `useElapsedMs` (moved). |
| `packages/assistant-ui/src/assistant-activity-parts.tsx` | `ActivityGroup` derives steps/summary and renders `ActivityTrace`; reasoning block labels come from the model. |
| `packages/assistant-ui/src/overrides.css` | Motion grammar: label crossfade, grid-rows collapse, fade-up stagger, reduced-motion/forced-colors. |
| `packages/assistant-ui/src/assistant-activity-group.tsx` | **Deleted** in Task 5 (replacement lands in the same diff). |
| Tests | `activity-verbs.test.ts`, `activity-trace-model.test.ts`, `activity-trace.test.tsx`, `activity-trace.browser.test.tsx` (new); `assistant-activity-group.test.tsx` and `assistant-chat-polish.browser.test.tsx` group cases migrated; behavior/hydration/reasoning tests updated for the new headline; e2e text updates. |
| Docs | `docs/agents/assistant-runtime.md` ACTIVITY GROUPS section (header grammar, motion, seam); `docs/agents/ui-conventions.md` motion rule. |

---

### Task 1: Verb vocabulary

**Files:**
- Create: `packages/assistant-ui/src/activity-verbs.ts`
- Test: `packages/assistant-ui/src/__tests__/activity-verbs.test.ts`

**Interfaces:**
- Consumes: `NATIVE_TOOL_ID`, `NATIVE_TOOL_IDS` from `@brainstrike/assistant-contract` (the id catalog; keys are the id minus the `brainstrike.` prefix, e.g. `NATIVE_TOOL_ID.readWorkspaceFile === 'brainstrike.readWorkspaceFile'`); `denormalizeNativeToolName` from `@brainstrike/assistant-contract` (sanitized `brainstrike_grepSearch` → dotted); `SUBAGENT_DELEGATION_TOOL_PREFIX` from `@brainstrike/assistant-contract/personas`; `personaLabelForToolName` from `./subagent-persona-label`.
- Produces: `type VerbFamily = 'read' | 'search' | 'edit' | 'run' | 'web' | 'canvas' | 'tasks' | 'worktree' | 'skill' | 'ask' | 'delegate' | 'call' | 'other'`; `interface ActivityVerb { readonly active: string; readonly done: string; readonly family: VerbFamily }`; `verbForTool(toolName: string): ActivityVerb`; `TOOL_VERBS: Readonly<Record<NativeToolId, ActivityVerb>>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/assistant-ui/src/__tests__/activity-verbs.test.ts
import { NATIVE_TOOL_ID, NATIVE_TOOL_IDS } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { TOOL_VERBS, verbForTool } from '../activity-verbs';

describe('TOOL_VERBS', () => {
  it('covers every native tool id in the catalog with a non-empty active/done pair', () => {
    for (const id of NATIVE_TOOL_IDS) {
      const verb = TOOL_VERBS[id];
      expect(verb, id).toBeDefined();
      expect(verb.active.length, id).toBeGreaterThan(0);
      expect(verb.done.length, id).toBeGreaterThan(0);
      expect(verb.active, id).not.toBe(verb.done);
    }
  });

  it('spells the core verbs the design fixed', () => {
    expect(TOOL_VERBS[NATIVE_TOOL_ID.readWorkspaceFile]).toEqual({ active: 'Reading', done: 'Read', family: 'read' });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.grepSearch]).toEqual({ active: 'Searching', done: 'Searched', family: 'search' });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.writeWorkspaceFile]).toEqual({ active: 'Editing', done: 'Edited', family: 'edit' });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.executeCommand]).toEqual({ active: 'Running', done: 'Ran', family: 'run' });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.webSearch]).toEqual({ active: 'Searching the web', done: 'Searched the web', family: 'web' });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.manageCanvas]).toEqual({ active: 'Updating canvas', done: 'Updated canvas', family: 'canvas' });
    expect(TOOL_VERBS[NATIVE_TOOL_ID.askUser]).toEqual({ active: 'Asking', done: 'Asked', family: 'ask' });
  });
});

describe('verbForTool', () => {
  it('resolves native ids in dotted and sanitized form', () => {
    expect(verbForTool('brainstrike.readWorkspaceFile').done).toBe('Read');
    expect(verbForTool('brainstrike_readWorkspaceFile').done).toBe('Read');
  });

  it('describes a delegation by persona label', () => {
    expect(verbForTool('agent-explore')).toEqual({
      active: 'Delegating to Explorer',
      done: 'Delegated to Explorer',
      family: 'delegate',
    });
  });

  it('describes an MCP tool by its server.tool name', () => {
    expect(verbForTool('linear.get_issue')).toEqual({
      active: 'Calling linear.get_issue',
      done: 'Called linear.get_issue',
      family: 'call',
    });
  });

  it('never guesses for an unknown name', () => {
    expect(verbForTool('mystery')).toEqual({ active: 'Using mystery', done: 'Used mystery', family: 'other' });
  });
});
```

`NATIVE_TOOL_IDS` (all 36 ids, catalog order) and `NATIVE_TOOL_ID` are exported from the package root via `native-tool-catalog.ts`; `denormalizeNativeToolName` via the `tool-metadata.ts` re-export (also importable from `@brainstrike/assistant-contract/tool-metadata`, the path `run-lifecycle-notifications.ts` uses). The built-in Explorer persona has id `explore` and label `Explorer` (`BUILT_IN_PERSONAS` in `packages/assistant-contract/src/personas.ts`), so the delegation tool name is `agent-explore`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/activity-verbs.test.ts`
Expected: FAIL — `Cannot find module '../activity-verbs'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/assistant-ui/src/activity-verbs.ts
import {
  denormalizeNativeToolName,
  NATIVE_TOOL_ID,
  type NativeToolId,
} from '@brainstrike/assistant-contract';
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import { personaLabelForToolName } from './subagent-persona-label';

export type VerbFamily =
  | 'ask'
  | 'call'
  | 'canvas'
  | 'delegate'
  | 'edit'
  | 'other'
  | 'read'
  | 'run'
  | 'search'
  | 'skill'
  | 'tasks'
  | 'web'
  | 'worktree';

export interface ActivityVerb {
  /** Present participle while the step runs: "Reading". */
  readonly active: string;
  /** Past tense once it settled: "Read". */
  readonly done: string;
  /** Icon/colour family for the step row (phase 3) and summary grouping. */
  readonly family: VerbFamily;
}

const verb = (active: string, done: string, family: VerbFamily): ActivityVerb =>
  Object.freeze({ active, done, family });

/**
 * One entry per native tool id. The table is total over `NATIVE_TOOL_IDS`
 * (pinned by activity-verbs.test.ts), so adding a native tool without a verb
 * fails the suite instead of silently reading "Using brainstrike.x".
 */
export const TOOL_VERBS: Readonly<Record<NativeToolId, ActivityVerb>> = Object.freeze({
  [NATIVE_TOOL_ID.askUser]: verb('Asking', 'Asked', 'ask'),
  [NATIVE_TOOL_ID.browserGetPageText]: verb('Reading page text', 'Read page text', 'web'),
  [NATIVE_TOOL_ID.browserNavigate]: verb('Opening', 'Opened', 'web'),
  [NATIVE_TOOL_ID.browserReadPage]: verb('Reading page', 'Read page', 'web'),
  [NATIVE_TOOL_ID.deleteWorkspaceFile]: verb('Deleting', 'Deleted', 'edit'),
  [NATIVE_TOOL_ID.executeCommand]: verb('Running', 'Ran', 'run'),
  [NATIVE_TOOL_ID.findWorkspaceSymbol]: verb('Inspecting', 'Inspected', 'search'),
  [NATIVE_TOOL_ID.globWorkspace]: verb('Finding files', 'Found files', 'search'),
  [NATIVE_TOOL_ID.grepSearch]: verb('Searching', 'Searched', 'search'),
  [NATIVE_TOOL_ID.hybridSearch]: verb('Searching', 'Searched', 'search'),
  [NATIVE_TOOL_ID.inspectCommandSessions]: verb('Inspecting sessions', 'Inspected sessions', 'run'),
  [NATIVE_TOOL_ID.listEmbeddingSpaces]: verb('Listing embedding spaces', 'Listed embedding spaces', 'search'),
  [NATIVE_TOOL_ID.listWorkspaceContext]: verb('Listing context', 'Listed context', 'read'),
  [NATIVE_TOOL_ID.listWorktrees]: verb('Listing worktrees', 'Listed worktrees', 'worktree'),
  [NATIVE_TOOL_ID.lspInspect]: verb('Inspecting', 'Inspected', 'search'),
  [NATIVE_TOOL_ID.manageCanvas]: verb('Updating canvas', 'Updated canvas', 'canvas'),
  [NATIVE_TOOL_ID.manageCommandSession]: verb('Running', 'Ran', 'run'),
  [NATIVE_TOOL_ID.manageTaskList]: verb('Updating tasks', 'Updated tasks', 'tasks'),
  [NATIVE_TOOL_ID.manageWorktree]: verb('Updating worktree', 'Updated worktree', 'worktree'),
  [NATIVE_TOOL_ID.queryDiagnostics]: verb('Inspecting', 'Inspected', 'search'),
  [NATIVE_TOOL_ID.queryEmbeddingSpace]: verb('Searching', 'Searched', 'search'),
  [NATIVE_TOOL_ID.querySelf]: verb('Querying history', 'Queried history', 'search'),
  [NATIVE_TOOL_ID.readToolOutputArtifact]: verb('Reading output', 'Read output', 'read'),
  [NATIVE_TOOL_ID.readWorkspaceContext]: verb('Reading context', 'Read context', 'read'),
  [NATIVE_TOOL_ID.readWorkspaceDirectory]: verb('Listing', 'Listed', 'read'),
  [NATIVE_TOOL_ID.readWorkspaceFile]: verb('Reading', 'Read', 'read'),
  [NATIVE_TOOL_ID.renameWorkspaceFile]: verb('Renaming', 'Renamed', 'edit'),
  [NATIVE_TOOL_ID.runPython]: verb('Running', 'Ran', 'run'),
  [NATIVE_TOOL_ID.runSkillScript]: verb('Running skill script', 'Ran skill script', 'skill'),
  [NATIVE_TOOL_ID.stringReplaceWorkspaceFile]: verb('Editing', 'Edited', 'edit'),
  [NATIVE_TOOL_ID.submitPlan]: verb('Proposing plan', 'Proposed plan', 'ask'),
  [NATIVE_TOOL_ID.updateWorkspaceContextSelection]: verb('Updating context', 'Updated context', 'read'),
  [NATIVE_TOOL_ID.updateWorkspaceTapestrySelections]: verb('Updating selections', 'Updated selections', 'read'),
  [NATIVE_TOOL_ID.webExtract]: verb('Fetching', 'Fetched', 'web'),
  [NATIVE_TOOL_ID.webSearch]: verb('Searching the web', 'Searched the web', 'web'),
  [NATIVE_TOOL_ID.writeWorkspaceFile]: verb('Editing', 'Edited', 'edit'),
});

function isNativeToolId(name: string): name is NativeToolId {
  return Object.hasOwn(TOOL_VERBS, name);
}

/**
 * Verb for any tool name the thread can carry: native ids (dotted or the
 * Mastra-sanitized underscore form), `agent-<persona>` delegations, MCP tools
 * (`server.tool`, which contain a dot but never the `brainstrike.` prefix), and
 * anything else — which reads honestly as "Using <name>" rather than a guess.
 */
export function verbForTool(toolName: string): ActivityVerb {
  const dotted = denormalizeNativeToolName(toolName);
  if (isNativeToolId(dotted)) {
    return TOOL_VERBS[dotted];
  }
  if (toolName.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX)) {
    const label = personaLabelForToolName(toolName);
    return verb(`Delegating to ${label}`, `Delegated to ${label}`, 'delegate');
  }
  if (toolName.includes('.') && !toolName.startsWith('brainstrike.')) {
    return verb(`Calling ${toolName}`, `Called ${toolName}`, 'call');
  }
  return verb(`Using ${toolName}`, `Used ${toolName}`, 'other');
}
```

The 36 entries above are exactly the ids under `packages/assistant-contract/src/native-tools/definitions/` as of 2026-09-08 (the catalog key is the id minus `brainstrike.`). If the catalog has since gained or lost a tool, the totality test and the `Record<NativeToolId, …>` type both say so: add or remove the entry, never weaken the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/activity-verbs.test.ts`
Expected: PASS (6 tests). Then `pnpm --filter @brainstrike/assistant-ui type-check` — the `Record<NativeToolId, …>` type is what makes a missing entry a compile error too.

- [ ] **Step 5: Mutate once** — delete the `grepSearch` entry: the totality test AND type-check fail. Revert.

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src/activity-verbs.ts packages/assistant-ui/src/__tests__/activity-verbs.test.ts
git add packages/assistant-ui/src/activity-verbs.ts packages/assistant-ui/src/__tests__/activity-verbs.test.ts
git commit -m "feat(assistant-ui): verb vocabulary for activity steps, total over the native tool catalog

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Activity step model and summaries

**Files:**
- Create: `packages/assistant-ui/src/activity-trace-model.ts`
- Test: `packages/assistant-ui/src/__tests__/activity-trace-model.test.ts`

**Interfaces:**
- Consumes: Task 1 `verbForTool`, `ActivityVerb`; `extractPrimaryArg` from `./tool-summaries`; `isToolCallPart` from `./tool-activity`; `isGuardedToolError` from `@brainstrike/assistant-contract` (the canonical guarded-error reader used by hydration).
- Produces:

```ts
export type ActivityStepState = 'cancelled' | 'done' | 'failed' | 'running' | 'waiting';
export type ActivityStepKind = 'reasoning' | 'tool';
export interface ActivityStep {
  readonly durationMs: number | undefined;
  readonly id: string;
  readonly kind: ActivityStepKind;
  readonly partIndex: number;
  readonly state: ActivityStepState;
  readonly target: string | null;   // extractPrimaryArg(...).display for tools; null for reasoning
  readonly verb: ActivityVerb;       // reasoning: { active: 'Thinking', done: 'Thought', family: 'other' }
}
export interface ActivityCounts { readonly failed: number; readonly steps: number }
export interface ActivitySummary {
  readonly counts: ActivityCounts;
  readonly live: string;     // current-step phrase
  readonly resting: string;  // verb summary
}
export function deriveActivitySteps(parts: readonly unknown[], durations: Readonly<Record<string, number>>): readonly ActivityStep[];
export function summarizeActivity(steps: readonly ActivityStep[]): ActivitySummary;
```

Rules (from spec §4.2, adjusted to the phase-1 code):
- Tool step state from the part: `status.type === 'running'` → `running`; `requires-action` → `waiting`; `incomplete` with reason `cancelled` → `cancelled`, other incomplete → `failed`; `complete` → `failed` when `isError === true` or the result is a guarded error, else `done`. A part with no `status` is `done` when it has a `result`, else `running` — mirrors `summarizeToolActivity`, which counts only canonical flags.
- Reasoning step: `status.type === 'running'` → `running`, else `done`; verb `Thinking` / `Thought`; `id` is `reasoning-<partIndex>`.
- `counts.steps` counts TOOL steps only (reasoning-only groups keep "no step count", BST-1656). `counts.failed` counts tool steps in `failed`.
- `live`: the LAST step whose state is `waiting` wins with `Waiting for approval` (a delegation waiting reads the same); else the last `running` tool step as `${verb.active} ${target}` (or just `verb.active` without a target); else a running reasoning step → `Thinking`; else `Working`.
- `resting`: unique `verb.done` of tool steps in `done`/`failed` state, first-occurrence order, up to three, joined `, `, first letter of the whole string upper-case, the rest lower-case-initial for verbs 2–3 (`Read files, searched, ran`); edit-family verbs carry a file count (`edited 2 files`, `edited 1 file`) computed from distinct targets of that family; read-family verbs with more than one distinct target read `read N files`; beyond three verbs append ` +N more` (N = remaining unique verbs). No tool steps → reasoning-only → `Thought`; no steps at all → `Worked`.
- Never derive state from arbitrary domain fields (repo rule).

- [ ] **Step 1: Write the failing test**

```ts
// packages/assistant-ui/src/__tests__/activity-trace-model.test.ts
import { describe, expect, it } from 'vitest';
import { deriveActivitySteps, summarizeActivity } from '../activity-trace-model';

const tool = (id: string, toolName: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  args,
  argsText: JSON.stringify(args),
  toolCallId: id,
  toolName,
  type: 'tool-call' as const,
  ...extra,
});
const complete = { status: { type: 'complete' }, result: { ok: true } };
const running = { status: { type: 'running' } };
const reasoning = (text: string, status: 'running' | 'complete') => ({ status: { type: status }, text, type: 'reasoning' as const });

describe('deriveActivitySteps', () => {
  it('maps tool parts to steps with verb, target, state, and duration', () => {
    const steps = deriveActivitySteps(
      [
        tool('a', 'brainstrike.readWorkspaceFile', { path: 'src/app.ts' }, complete),
        tool('b', 'brainstrike.grepSearch', { pattern: 'foo' }, running),
      ],
      { a: 1500 }
    );
    expect(steps).toEqual([
      expect.objectContaining({ durationMs: 1500, id: 'a', kind: 'tool', partIndex: 0, state: 'done', target: 'src/app.ts' }),
      expect.objectContaining({ durationMs: undefined, id: 'b', kind: 'tool', partIndex: 1, state: 'running', target: 'foo' }),
    ]);
    expect(steps[0]?.verb.done).toBe('Read');
    expect(steps[1]?.verb.active).toBe('Searching');
  });

  it('maps statuses: requires-action → waiting, incomplete cancelled → cancelled, isError/guarded → failed', () => {
    const steps = deriveActivitySteps(
      [
        tool('w', 'brainstrike.executeCommand', { command: 'ls' }, { status: { reason: 'interrupt', type: 'requires-action' } }),
        tool('c', 'brainstrike.executeCommand', { command: 'ls' }, { status: { reason: 'cancelled', type: 'incomplete' } }),
        tool('e', 'brainstrike.executeCommand', { command: 'ls' }, { isError: true, result: { error: 'boom' }, status: { type: 'complete' } }),
        tool('g', 'brainstrike.executeCommand', { command: 'ls' }, { result: { error: { code: 'tool_blocked_by_hook', message: 'blocked', toolName: 'brainstrike.executeCommand' }, ok: false }, status: { type: 'complete' } }),
      ],
      {}
    );
    expect(steps.map((step) => step.state)).toEqual(['waiting', 'cancelled', 'failed', 'failed']);
  });

  it('maps reasoning parts to Thinking/Thought steps that never count as tool steps', () => {
    const steps = deriveActivitySteps([reasoning('hmm', 'running'), reasoning('done', 'complete')], {});
    expect(steps.map((step) => [step.kind, step.state, step.verb.active, step.verb.done])).toEqual([
      ['reasoning', 'running', 'Thinking', 'Thought'],
      ['reasoning', 'done', 'Thinking', 'Thought'],
    ]);
    expect(summarizeActivity(steps).counts.steps).toBe(0);
  });

  it('ignores data and text parts', () => {
    expect(deriveActivitySteps([{ type: 'text', text: 'x' }, { data: {}, name: 'brainstrike.run-event', type: 'data' }], {})).toEqual([]);
  });
});

describe('summarizeActivity', () => {
  const done = (id: string, name: string, args: Record<string, unknown>) => tool(id, name, args, complete);

  it('names the last running tool with its target while live', () => {
    const steps = deriveActivitySteps([
      done('a', 'brainstrike.readWorkspaceFile', { path: 'a.ts' }),
      tool('b', 'brainstrike.grepSearch', { pattern: 'foo' }, running),
    ], {});
    expect(summarizeActivity(steps).live).toBe('Searching foo');
  });

  it('prefers a waiting step over a running one and reads Waiting for approval', () => {
    const steps = deriveActivitySteps([
      tool('w', 'brainstrike.executeCommand', { command: 'rm -rf x' }, { status: { reason: 'interrupt', type: 'requires-action' } }),
    ], {});
    expect(summarizeActivity(steps).live).toBe('Waiting for approval');
  });

  it('reads Thinking while only reasoning streams and Working when nothing is identifiable', () => {
    expect(summarizeActivity(deriveActivitySteps([reasoning('x', 'running')], {})).live).toBe('Thinking');
    expect(summarizeActivity([]).live).toBe('Working');
  });

  it('builds the resting summary from unique verbs in first-occurrence order, capped at three', () => {
    const steps = deriveActivitySteps([
      done('1', 'brainstrike.readWorkspaceFile', { path: 'a.ts' }),
      done('2', 'brainstrike.readWorkspaceFile', { path: 'b.ts' }),
      done('3', 'brainstrike.executeCommand', { command: 'pnpm test' }),
      done('4', 'brainstrike.writeWorkspaceFile', { path: 'a.ts' }),
      done('5', 'brainstrike.writeWorkspaceFile', { path: 'c.ts' }),
      done('6', 'brainstrike.webSearch', { query: 'x' }),
      done('7', 'brainstrike.manageCanvas', { title: 't' }),
    ], {});
    const summary = summarizeActivity(steps);
    expect(summary.resting).toBe('Read 2 files, ran, edited 2 files +2 more');
    expect(summary.counts).toEqual({ failed: 0, steps: 7 });
  });

  it('counts failed steps and still lists their verbs', () => {
    const steps = deriveActivitySteps([
      done('1', 'brainstrike.readWorkspaceFile', { path: 'a.ts' }),
      tool('2', 'brainstrike.grepSearch', { pattern: 'x' }, { isError: true, result: { error: 'no' }, status: { type: 'complete' } }),
    ], {});
    expect(summarizeActivity(steps)).toEqual({ counts: { failed: 1, steps: 2 }, live: 'Working', resting: 'Read, searched' });
  });

  it('reads Thought for a reasoning-only group and Worked for an empty one', () => {
    expect(summarizeActivity(deriveActivitySteps([reasoning('x', 'complete')], {})).resting).toBe('Thought');
    expect(summarizeActivity([]).resting).toBe('Worked');
  });
});
```

The guarded-error fixture uses the exact `GuardedToolError` envelope from `packages/assistant-contract/src/guarded-tool-error.ts` (`ok: false` plus `error.code` in `GUARDED_TOOL_ERROR_CODES`: `tool_input_invalid` | `tool_blocked_by_hook`). If the code set changes, adjust the fixture, never the reader.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/activity-trace-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/assistant-ui/src/activity-trace-model.ts
import { isGuardedToolError } from '@brainstrike/assistant-contract';
import { type ActivityVerb, verbForTool } from './activity-verbs';
import { isToolCallPart } from './tool-activity';
import { extractPrimaryArg } from './tool-summaries';

export type ActivityStepKind = 'reasoning' | 'tool';
export type ActivityStepState = 'cancelled' | 'done' | 'failed' | 'running' | 'waiting';

export interface ActivityStep {
  readonly durationMs: number | undefined;
  readonly id: string;
  readonly kind: ActivityStepKind;
  readonly partIndex: number;
  readonly state: ActivityStepState;
  readonly target: string | null;
  readonly verb: ActivityVerb;
}

export interface ActivityCounts {
  readonly failed: number;
  readonly steps: number;
}

export interface ActivitySummary {
  readonly counts: ActivityCounts;
  readonly live: string;
  readonly resting: string;
}

const REASONING_VERB: ActivityVerb = Object.freeze({ active: 'Thinking', done: 'Thought', family: 'other' });
const MAX_RESTING_VERBS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function statusOf(part: Record<string, unknown>): { reason?: unknown; type?: unknown } | undefined {
  const status = part['status'];
  return isRecord(status) ? status : undefined;
}

/** Canonical flags only (repo rule): status type/reason, `isError`, guarded error. */
function toolStepState(part: Record<string, unknown>): ActivityStepState {
  const status = statusOf(part);
  if (status?.type === 'running') {
    return 'running';
  }
  if (status?.type === 'requires-action') {
    return 'waiting';
  }
  if (status?.type === 'incomplete') {
    return status.reason === 'cancelled' ? 'cancelled' : 'failed';
  }
  if (part['isError'] === true || isGuardedToolError(part['result'])) {
    return 'failed';
  }
  if (status === undefined && part['result'] === undefined) {
    return 'running';
  }
  return 'done';
}

function reasoningStepState(part: Record<string, unknown>): ActivityStepState {
  return statusOf(part)?.type === 'running' ? 'running' : 'done';
}

export function deriveActivitySteps(
  parts: readonly unknown[],
  durations: Readonly<Record<string, number>>
): readonly ActivityStep[] {
  const steps: ActivityStep[] = [];
  for (const [partIndex, part] of parts.entries()) {
    if (isToolCallPart(part)) {
      const toolCallId = typeof part['toolCallId'] === 'string' ? part['toolCallId'] : `tool-${partIndex}`;
      const toolName = typeof part['toolName'] === 'string' && part['toolName'].length > 0 ? part['toolName'] : 'tool';
      const argsText = typeof part['argsText'] === 'string' ? part['argsText'] : undefined;
      steps.push({
        durationMs: durations[toolCallId],
        id: toolCallId,
        kind: 'tool',
        partIndex,
        state: toolStepState(part),
        target: extractPrimaryArg(part['args'], argsText)?.display ?? null,
        verb: verbForTool(toolName),
      });
      continue;
    }
    if (isRecord(part) && part['type'] === 'reasoning') {
      steps.push({
        durationMs: undefined,
        id: `reasoning-${partIndex}`,
        kind: 'reasoning',
        partIndex,
        state: reasoningStepState(part),
        target: null,
        verb: REASONING_VERB,
      });
    }
  }
  return steps;
}

function liveLabel(steps: readonly ActivityStep[]): string {
  const waiting = steps.findLast((step) => step.state === 'waiting');
  if (waiting) {
    return 'Waiting for approval';
  }
  const runningTool = steps.findLast((step) => step.kind === 'tool' && step.state === 'running');
  if (runningTool) {
    return runningTool.target ? `${runningTool.verb.active} ${runningTool.target}` : runningTool.verb.active;
  }
  if (steps.some((step) => step.kind === 'reasoning' && step.state === 'running')) {
    return 'Thinking';
  }
  return 'Working';
}

function lowerInitial(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function restingLabel(steps: readonly ActivityStep[]): string {
  const settled = steps.filter(
    (step) => step.kind === 'tool' && (step.state === 'done' || step.state === 'failed')
  );
  if (settled.length === 0) {
    return steps.some((step) => step.kind === 'reasoning') ? 'Thought' : 'Worked';
  }
  const targetsByVerb = new Map<string, Set<string>>();
  const familyByVerb = new Map<string, ActivityVerb['family']>();
  for (const step of settled) {
    const key = step.verb.done;
    const targets = targetsByVerb.get(key) ?? new Set<string>();
    if (step.target) {
      targets.add(step.target);
    }
    targetsByVerb.set(key, targets);
    familyByVerb.set(key, step.verb.family);
  }
  const phrases = [...targetsByVerb.entries()].map(([done, targets]) => {
    const family = familyByVerb.get(done);
    const fileCount = targets.size;
    if (family === 'edit' && fileCount > 0) {
      return `${done} ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
    }
    if (family === 'read' && fileCount > 1) {
      return `${done} ${fileCount} files`;
    }
    return done;
  });
  const shown = phrases.slice(0, MAX_RESTING_VERBS);
  const rest = phrases.length - shown.length;
  const joined = shown.map((phrase, index) => (index === 0 ? phrase : lowerInitial(phrase))).join(', ');
  return rest > 0 ? `${joined} +${rest} more` : joined;
}

export function summarizeActivity(steps: readonly ActivityStep[]): ActivitySummary {
  const toolSteps = steps.filter((step) => step.kind === 'tool');
  return {
    counts: {
      failed: toolSteps.filter((step) => step.state === 'failed').length,
      steps: toolSteps.length,
    },
    live: liveLabel(steps),
    resting: restingLabel(steps),
  };
}
```

`Array.prototype.findLast` is available: the shared `packages/config/tsconfig/base.json` sets `lib: ["DOM", "DOM.Iterable", "ESNext"]` and `data-stream-runtime.ts` already uses it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/activity-trace-model.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Mutate three guards, one at a time, revert each** — (a) make `toolStepState` return `'done'` for `isError` → the status-mapping and failed-count tests fail; (b) drop the `waiting` branch in `liveLabel` → the approval test fails; (c) set `MAX_RESTING_VERBS = 99` → the cap test fails. Record all three.

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src/activity-trace-model.ts packages/assistant-ui/src/__tests__/activity-trace-model.test.ts
git add packages/assistant-ui/src/activity-trace-model.ts packages/assistant-ui/src/__tests__/activity-trace-model.test.ts
git commit -m "feat(assistant-ui): pure activity step model with live and resting summaries

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Motion grammar (CSS only)

**Files:**
- Modify: `packages/assistant-ui/src/overrides.css` (add after the `.bs-activity-*` block; keep the existing rules)
- Test: `packages/assistant-ui/src/__tests__/activity-motion.browser.test.tsx` (new, browser project)

**Interfaces:**
- Produces the class names the components in Tasks 4–5 use: `bs-trace-label` (keyed crossfade), `bs-trace-collapse` + `bs-trace-collapse-inner` (grid-rows disclosure, `data-open="true"|"false"`), `bs-trace-reveal` (fade-up with `--bs-stagger` index, capped at 5), `bs-trace-detail` (fixed-height one-line slot), `bs-trace-glyph` (rotating chevron via `[aria-expanded="true"]`).

- [ ] **Step 1: Write the failing browser test**

```tsx
// packages/assistant-ui/src/__tests__/activity-motion.browser.test.tsx
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';

function px(value: string): number {
  return Number.parseFloat(value);
}

test('grid-rows disclosure opens to content height and closes to zero, with a transition declared', () => {
  const { container, rerender } = render(
    <div className="assistant-ui-panel">
      <div className="bs-trace-collapse" data-open="false" data-testid="collapse">
        <div className="bs-trace-collapse-inner">
          <div style={{ height: 40 }} />
        </div>
      </div>
    </div>
  );
  const collapse = container.querySelector('[data-testid="collapse"]') as HTMLElement;
  expect(getComputedStyle(collapse).gridTemplateRows).toBe('0px');
  rerender(
    <div className="assistant-ui-panel">
      <div className="bs-trace-collapse" data-open="true" data-testid="collapse">
        <div className="bs-trace-collapse-inner">
          <div style={{ height: 40 }} />
        </div>
      </div>
    </div>
  );
  expect(px(getComputedStyle(collapse).gridTemplateRows)).toBeGreaterThanOrEqual(40);
  expect(getComputedStyle(collapse).transitionProperty).toContain('grid-template-rows');
});

test('reveal rows carry a bounded stagger delay', () => {
  const { container } = render(
    <div className="assistant-ui-panel">
      {[0, 1, 7].map((index) => (
        <div className="bs-trace-reveal" data-testid={`row-${index}`} key={index} style={{ ['--bs-stagger' as string]: String(index) }} />
      ))}
    </div>
  );
  const delay = (index: number) => px(getComputedStyle(container.querySelector(`[data-testid="row-${index}"]`) as HTMLElement).animationDelay) * 1000;
  expect(delay(0)).toBe(0);
  expect(delay(1)).toBeGreaterThan(0);
  expect(delay(7)).toBe(delay(1) * 5);
});

test('the detail slot has a fixed one-line height', () => {
  const { container } = render(
    <div className="assistant-ui-panel">
      <div className="bs-trace-detail" data-testid="detail" />
    </div>
  );
  const detail = container.querySelector('[data-testid="detail"]') as HTMLElement;
  expect(px(getComputedStyle(detail).height)).toBeGreaterThan(0);
  expect(getComputedStyle(detail).overflow).toBe('hidden');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/assistant-ui && pnpm vitest run --project browser src/__tests__/activity-motion.browser.test.tsx`
Expected: FAIL (no rules; `gridTemplateRows` is `none`).

- [ ] **Step 3: Add the CSS**

```css
/**
 * ACTIVITY TRACE MOTION (phase 2). CSS-only by repo rule. Four primitives:
 * - .bs-trace-label: a keyed span that fades/slides in when its text changes
 *   (the caller re-keys the element on the label string).
 * - .bs-trace-collapse[data-open]: grid-rows disclosure, no measured heights.
 * - .bs-trace-reveal: one-shot fade-up with a --bs-stagger index capped at 5.
 * - .bs-trace-detail: a fixed one-line slot under the header while running,
 *   so the header itself never changes height (scroll-anchoring rule).
 */
@keyframes bs-trace-label-enter {
  from {
    opacity: 0;
    transform: translateY(2px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes bs-trace-reveal {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.assistant-ui-panel .bs-trace-label {
  animation: bs-trace-label-enter 250ms cubic-bezier(0.23, 1, 0.32, 1) both;
  display: inline-block;
  min-width: 0;
}

.assistant-ui-panel .bs-trace-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 220ms cubic-bezier(0.23, 1, 0.32, 1);
}

.assistant-ui-panel .bs-trace-collapse[data-open="true"] {
  grid-template-rows: 1fr;
}

.assistant-ui-panel .bs-trace-collapse-inner {
  min-height: 0;
  overflow: hidden;
}

.assistant-ui-panel .bs-trace-reveal {
  --bs-stagger: 0;
  animation: bs-trace-reveal 220ms cubic-bezier(0.23, 1, 0.32, 1) both;
  animation-delay: calc(min(var(--bs-stagger), 5) * 40ms);
}

.assistant-ui-panel .bs-trace-detail {
  color: hsl(var(--muted-foreground));
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.7rem;
  height: 1.25rem;
  line-height: 1.25rem;
  overflow: hidden;
  padding-inline: 0.6rem 0.6rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-ui-panel .bs-trace-glyph {
  transition: transform 160ms ease;
}

.assistant-ui-panel [aria-expanded="true"] > .bs-trace-glyph {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: reduce) {
  .assistant-ui-panel .bs-trace-label,
  .assistant-ui-panel .bs-trace-reveal {
    animation: none;
  }

  .assistant-ui-panel .bs-trace-collapse,
  .assistant-ui-panel .bs-trace-glyph {
    transition: none;
  }
}
```

`grid-template-rows` transitions require the inner element to have `min-height: 0` and `overflow: hidden`, which the inner class provides; `calc(min(var(--bs-stagger), 5) * 40ms)` is valid CSS (`min()` on unitless numbers) in Chromium.

- [ ] **Step 4: Run the browser test** — Expected: PASS (3 tests). If `transitionProperty` reads `all` under a global reset, assert `transitionDuration` is not `0s` instead and note it.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src/overrides.css packages/assistant-ui/src/__tests__/activity-motion.browser.test.tsx
git add packages/assistant-ui/src/overrides.css packages/assistant-ui/src/__tests__/activity-motion.browser.test.tsx
git commit -m "feat(assistant-ui): CSS motion grammar for the activity trace (label crossfade, grid-rows collapse, staggered reveal)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `ActivityTrace` container (header row + detail line + body)

**Files:**
- Create: `packages/assistant-ui/src/activity-trace.tsx`
- Test: `packages/assistant-ui/src/__tests__/activity-trace.test.tsx` (unit), `packages/assistant-ui/src/__tests__/activity-trace.browser.test.tsx` (browser)

**Interfaces:**
- Consumes: `ActivitySummary` (Task 2); `formatActivityDuration` (`./tool-durations`); `BrainstrikeThinkingMark` (`./assistant-thinking-indicator`, with its `live` prop); lucide `AlertCircle`, `CheckCircle`, `ChevronRight`, `CircleSlash`, `Square`.
- Produces:

```ts
export interface ActivityTraceProps {
  readonly children?: ReactNode;
  readonly detail: string | null;            // current target for the running detail line
  readonly fallbackMs: number | undefined;   // elapsed seed (group run-event span) — same semantics as before
  readonly incompleteReason: Extract<MessageStatus, { type: 'incomplete' }>['reason'] | undefined;
  readonly isActive: boolean;
  readonly restingOverride: string | null;   // model-written summary seam; null today
  readonly summary: ActivitySummary;
}
export function ActivityTrace(props: ActivityTraceProps): ReactNode;
```

Header contract (mirrors what `AssistantActivityGroup` exposes today so every existing test id keeps working):
- Root `div.bs-activity-group` with `data-testid="assistant-activity-group"`, `data-active`, `data-state`, `data-failed` (group's OWN incomplete status, not cancelled), `data-failed-steps={summary.counts.failed}`.
- Header `<button data-testid="assistant-activity-summary" aria-expanded aria-controls aria-label="Expand activity|Collapse activity">`: a `ChevronRight.bs-trace-glyph` (rotates when open) — the triangle; the state glyph (`BrainstrikeThinkingMark` live while active; `CheckCircle` green done; `Square` muted cancelled; `AlertCircle` destructive failed); the label span; trailing meta.
- Live: `<span data-testid="assistant-activity-working" aria-live="off"><span className="bs-thinking-shimmer bs-trace-label" key={summary.live}>{summary.live}</span></span>` and the ticking elapsed on the right. NOTE `assistant-activity-working` must contain the text `Working` only when the live label is `Working` — tests that asserted "Working" while a tool was running now read the verb phrase; update them (Task 5 lists which).
- Resting: headline = `restingOverride ?? summary.resting` inside `bs-activity-summary-label` with `bs-trace-label` keyed on its text; meta = `Worked for 12.0s` (cancelled: `Stopped after 12.0s` as the HEADLINE with the verb summary demoted to meta; failed: `Activity failed` headline, verbs in meta) then `· N steps` (tool steps only) then `· N failed` (`bs-activity-summary-failed`, `data-testid="assistant-activity-failed-count"`).
- A visually hidden `<span className="sr-only" aria-live="polite">{state phrase}</span>` whose text is `Working`, `Waiting for approval`, `Finished`, `Stopped`, or `Failed` — changes only on state transitions.
- Detail line: while active render `<div className="bs-trace-detail">{detail ?? ''}</div>` beneath the header (fixed height); when done render nothing (one-time collapse at finish).
- Body: `<div className="bs-trace-collapse" data-open={expanded}><div className="bs-trace-collapse-inner"><div className="bs-activity-body" data-testid="assistant-activity-body" id={bodyId} hidden={!expanded}>{children}</div></div></div>` — keep the `hidden` attribute so `getByRole` queries and the e2e sync keep working; the grid transition animates the wrapper.
- `expanded = userExpanded ?? false` (collapsed by default, wave 3 rule); `useElapsedMs` moved here verbatim from `assistant-activity-group.tsx`.

- [ ] **Step 1: Write the failing unit test**

```tsx
// packages/assistant-ui/src/__tests__/activity-trace.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ActivityTrace } from '../activity-trace';
import type { ActivitySummary } from '../activity-trace-model';

const live: ActivitySummary = { counts: { failed: 0, steps: 2 }, live: 'Searching foo', resting: 'Read, searched' };
const done: ActivitySummary = { counts: { failed: 0, steps: 3 }, live: 'Working', resting: 'Read 2 files, ran' };

describe('ActivityTrace', () => {
  it('names the current step while active, ticks elapsed, and stays collapsed', () => {
    render(<ActivityTrace detail="foo" fallbackMs={1500} incompleteReason={undefined} isActive restingOverride={null} summary={live}><div>body</div></ActivityTrace>);
    expect(screen.getByTestId('assistant-activity-working')).toHaveTextContent('Searching foo');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-state', 'running');
    expect(screen.getByTestId('assistant-activity-body')).toHaveAttribute('hidden');
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(1);
    expect(screen.getByText('foo')).toHaveClass('bs-trace-detail');
  });

  it('settles into the verb summary with Worked for as meta', () => {
    render(<ActivityTrace detail={null} fallbackMs={12_000} incompleteReason={undefined} isActive={false} restingOverride={null} summary={done} />);
    const summary = screen.getByTestId('assistant-activity-summary');
    expect(summary).toHaveTextContent('Read 2 files, ran');
    expect(summary).toHaveTextContent('Worked for 12.0s');
    expect(summary).toHaveTextContent('3 steps');
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(0);
    expect(screen.queryByText('foo')).not.toBeInTheDocument();
  });

  it('prefers a model-written override for the resting headline', () => {
    render(<ActivityTrace detail={null} fallbackMs={undefined} incompleteReason={undefined} isActive={false} restingOverride="Checked the three configs" summary={done} />);
    expect(screen.getByTestId('assistant-activity-summary')).toHaveTextContent('Checked the three configs');
    expect(screen.getByTestId('assistant-activity-summary')).not.toHaveTextContent('Read 2 files');
  });

  it('keeps Stopped and Activity failed as headlines for the group\'s own incomplete status', () => {
    const { rerender } = render(<ActivityTrace detail={null} fallbackMs={4000} incompleteReason="cancelled" isActive={false} restingOverride={null} summary={done} />);
    expect(screen.getByTestId('assistant-activity-summary')).toHaveTextContent('Stopped after 4.0s');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    rerender(<ActivityTrace detail={null} fallbackMs={4000} incompleteReason="error" isActive={false} restingOverride={null} summary={done} />);
    expect(screen.getByTestId('assistant-activity-summary')).toHaveTextContent('Activity failed');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'true');
  });

  it('shows the failed count without failing the group', () => {
    render(<ActivityTrace detail={null} fallbackMs={1000} incompleteReason={undefined} isActive={false} restingOverride={null} summary={{ ...done, counts: { failed: 1, steps: 3 } }} />);
    expect(screen.getByTestId('assistant-activity-failed-count')).toHaveTextContent('1 failed');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed', 'false');
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-failed-steps', '1');
  });

  it('expands on click and the toggle sticks', async () => {
    const user = userEvent.setup();
    render(<ActivityTrace detail={null} fallbackMs={1000} incompleteReason={undefined} isActive={false} restingOverride={null} summary={done}><div>body</div></ActivityTrace>);
    await user.click(screen.getByRole('button', { name: 'Expand activity' }));
    expect(screen.getByTestId('assistant-activity-body')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Collapse activity' })).toHaveAttribute('aria-expanded', 'true');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Write the component** (move `useElapsedMs` from `assistant-activity-group.tsx` verbatim into this file; do not delete the old file yet — Task 5 does):

```tsx
// packages/assistant-ui/src/activity-trace.tsx
import type { MessageStatus } from '@assistant-ui/react';
import { AlertCircle, CheckCircle, ChevronRight, Square } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { ActivitySummary } from './activity-trace-model';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';
import { formatActivityDuration } from './tool-durations';

/* useElapsedMs: paste the existing implementation from assistant-activity-group.tsx here unchanged, including its doc comment. */

export interface ActivityTraceProps {
  readonly children?: ReactNode;
  readonly detail: string | null;
  readonly fallbackMs: number | undefined;
  readonly incompleteReason: Extract<MessageStatus, { type: 'incomplete' }>['reason'] | undefined;
  readonly isActive: boolean;
  readonly restingOverride: string | null;
  readonly summary: ActivitySummary;
}

type TracePhase = 'cancelled' | 'done' | 'failed' | 'running';

function phaseOf(isActive: boolean, incompleteReason: ActivityTraceProps['incompleteReason']): TracePhase {
  if (isActive) {
    return 'running';
  }
  if (incompleteReason === 'cancelled') {
    return 'cancelled';
  }
  return incompleteReason === undefined ? 'done' : 'failed';
}

const PHASE_ANNOUNCEMENT: Record<TracePhase, string> = {
  cancelled: 'Stopped',
  done: 'Finished',
  failed: 'Failed',
  running: 'Working',
};

function PhaseGlyph({ phase }: { readonly phase: TracePhase }): ReactNode {
  if (phase === 'running') {
    return <BrainstrikeThinkingMark className="size-4" testId="assistant-activity-working-mark" />;
  }
  if (phase === 'cancelled') {
    return <Square className="size-4 text-muted-foreground" />;
  }
  if (phase === 'failed') {
    return <AlertCircle className="size-4 text-destructive" />;
  }
  return <CheckCircle className="size-4 text-emerald-600 dark:text-emerald-500" />;
}

function stepLabel(count: number): string {
  return count > 0 ? `${count} ${count === 1 ? 'step' : 'steps'}` : '';
}

/**
 * The activity group's status row. Live: one label that names the current
 * step (re-keyed so a change crossfades) plus a ticking elapsed; resting: the
 * verb summary as the headline with "Worked for Ns" as meta. Stopped / Activity
 * failed remain the headline for the group's OWN incomplete status; a failed
 * step count never fails the group. Collapsed by default; a toggle sticks.
 */
export function ActivityTrace({
  children,
  detail,
  fallbackMs,
  incompleteReason,
  isActive,
  restingOverride,
  summary,
}: ActivityTraceProps): ReactNode {
  const bodyId = useId();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? false;
  const elapsedMs = useElapsedMs(isActive, fallbackMs);
  const elapsedLabel = elapsedMs === undefined ? null : formatActivityDuration(elapsedMs);
  const phase = phaseOf(isActive, incompleteReason);
  const failed = phase === 'failed';
  const announcement = phase === 'running' && summary.live === 'Waiting for approval' ? 'Waiting for approval' : PHASE_ANNOUNCEMENT[phase];
  const restingHeadline = restingOverride ?? summary.resting;
  const steps = stepLabel(summary.counts.steps);

  return (
    <div
      className="bs-activity-group"
      data-active={isActive ? 'true' : 'false'}
      data-failed={failed ? 'true' : 'false'}
      data-failed-steps={summary.counts.failed}
      data-state={isActive ? 'running' : 'done'}
      data-testid="assistant-activity-group"
    >
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse activity' : 'Expand activity'}
        className="bs-activity-summary"
        data-testid="assistant-activity-summary"
        onClick={() => setUserExpanded(!expanded)}
        type="button"
      >
        <ChevronRight className="bs-trace-glyph size-3.5 shrink-0 text-muted-foreground" />
        <span className="inline-flex shrink-0 items-center">
          <PhaseGlyph phase={phase} />
        </span>
        {phase === 'running' ? (
          <span aria-live="off" className="bs-thinking-indicator min-w-0" data-testid="assistant-activity-working">
            <span className="bs-thinking-shimmer bs-trace-label truncate" key={summary.live}>
              {summary.live}
            </span>
          </span>
        ) : (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="bs-activity-summary-label bs-trace-label truncate" key={phase === 'done' ? restingHeadline : phase}>
              {phase === 'cancelled' ? 'Stopped' : phase === 'failed' ? 'Activity failed' : restingHeadline}
            </span>
            {elapsedLabel && phase !== 'failed' ? (
              <span className="bs-activity-summary-meta">
                {phase === 'cancelled' ? `after ${elapsedLabel}` : `Worked for ${elapsedLabel}`}
              </span>
            ) : null}
            {phase !== 'done' && summary.counts.steps > 0 ? (
              <span className="bs-activity-summary-meta">· {restingHeadline}</span>
            ) : null}
            {steps ? <span className="bs-activity-summary-meta">· {steps}</span> : null}
            {summary.counts.failed > 0 ? (
              <span className="bs-activity-summary-meta bs-activity-summary-failed" data-testid="assistant-activity-failed-count">
                · {summary.counts.failed} failed
              </span>
            ) : null}
          </span>
        )}
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
        <span className="bs-activity-right">
          {isActive && elapsedLabel ? <span className="bs-activity-elapsed">{elapsedLabel}</span> : null}
        </span>
      </button>
      {isActive ? (
        <div className="bs-trace-detail" title={detail ?? undefined}>
          {detail ?? ''}
        </div>
      ) : null}
      <div className="bs-trace-collapse" data-open={expanded ? 'true' : 'false'}>
        <div className="bs-trace-collapse-inner">
          <div className="bs-activity-body" data-testid="assistant-activity-body" hidden={!expanded} id={bodyId}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

ActivityTrace.displayName = 'ActivityTrace';
```

Notes: nested ternaries are disallowed by Biome — extract `headlineFor(phase, restingHeadline)` and `metaFor(phase, elapsedLabel)` helpers instead of the inline conditionals shown; `sr-only` exists in the Tailwind preset (`@brainstrike/ui` globals). Sort JSX props alphabetically.

- [ ] **Step 4: Run unit test** — PASS (6 tests). Then write the browser test:

```tsx
// packages/assistant-ui/src/__tests__/activity-trace.browser.test.tsx
import '@brainstrike/ui/globals.css';
import '../overrides.css';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { ActivityTrace } from '../activity-trace';

const live = { counts: { failed: 0, steps: 1 }, live: 'Reading app.ts', resting: 'Read' };
const done = { counts: { failed: 0, steps: 1 }, live: 'Working', resting: 'Read' };

test('the header keeps one height across live and resting states', () => {
  const { rerender } = render(<div className="assistant-ui-panel"><ActivityTrace detail="src/app.ts" fallbackMs={1000} incompleteReason={undefined} isActive restingOverride={null} summary={live} /></div>);
  const liveHeight = screen.getByTestId('assistant-activity-summary').getBoundingClientRect().height;
  rerender(<div className="assistant-ui-panel"><ActivityTrace detail={null} fallbackMs={1000} incompleteReason={undefined} isActive={false} restingOverride={null} summary={done} /></div>);
  const doneHeight = screen.getByTestId('assistant-activity-summary').getBoundingClientRect().height;
  expect(Math.abs(liveHeight - doneHeight)).toBeLessThan(1);
});

test('the detail slot renders only while active and the chevron rotates when open', async () => {
  render(<div className="assistant-ui-panel"><ActivityTrace detail="src/app.ts" fallbackMs={1000} incompleteReason={undefined} isActive restingOverride={null} summary={live}><div>x</div></ActivityTrace></div>);
  expect(screen.getByText('src/app.ts')).toBeVisible();
  const button = screen.getByTestId('assistant-activity-summary');
  const glyph = button.querySelector('.bs-trace-glyph') as HTMLElement;
  expect(getComputedStyle(glyph).transform).toBe('none');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(getComputedStyle(glyph).transform).not.toBe('none');
});
```

Run: `pnpm vitest run --project browser src/__tests__/activity-trace.browser.test.tsx` — PASS. If the height differs by the elapsed badge, give `.bs-activity-summary` a fixed `min-height: 2rem` in `overrides.css` (that is the fix, not loosening the assertion).

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src
git add packages/assistant-ui/src/activity-trace.tsx packages/assistant-ui/src/__tests__/activity-trace.test.tsx packages/assistant-ui/src/__tests__/activity-trace.browser.test.tsx packages/assistant-ui/src/overrides.css
git commit -m "feat(assistant-ui): ActivityTrace status row — current-step label while running, verb summary at rest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Wire the trace into the activity group; delete `AssistantActivityGroup`

**Files:**
- Modify: `packages/assistant-ui/src/assistant-activity-parts.tsx` (`ActivityGroup`, the reasoning block labels)
- Delete: `packages/assistant-ui/src/assistant-activity-group.tsx`
- Modify tests: `assistant-activity-group.test.tsx` → delete the component cases (keep `summarizeToolActivity`/`runEventsSpanMs`/`formatActivityDuration` cases; move them to `tool-activity.test.ts` if the file would otherwise be empty), `assistant-chat-polish.browser.test.tsx` (group cases → render `ActivityTrace`), `assistant-activity-timeline.behavior.test.tsx`, `assistant-hydration-liveness.test.tsx`, `assistant-activity-parts.test.tsx`, `assistant-reasoning-disclosure.behavior.test.tsx`, `assistant-ui-panel-architecture.test.ts`; e2e: `apps/desktop/e2e/assistant-tool-card-visuals.desktop.test.ts` (`Worked` → the verb text is now the headline; sync on `aria-expanded="false"` / `data-state="done"`), `apps/desktop/e2e/mcp-packaged-core.desktop.test.ts` and `apps/web/e2e/assistant-ui-panel.test.ts` (grep for `Worked` / `steps` text assertions; switch to `data-state="done"`).

**Interfaces:**
- Consumes: Task 2 `deriveActivitySteps`, `summarizeActivity`; Task 4 `ActivityTrace`; existing `useChainActivityDerivations` (for `toolDurations`, `activityFallbackMs`, `shellOutputs`, `taskList`), the activity-parts headline rule (`activityStatus` → `toIncompleteReason`) and `isActivityActive` from wave 3 — keep both exactly as they are; `ActivityTrace` only changes what the header SAYS, not when the group is active or failed.
- Produces: `ActivityGroup` renders `<ActivityTrace detail=… fallbackMs=… incompleteReason=… isActive=… restingOverride=… summary=…>`; reasoning blocks read `Thinking` while streaming and `Thought for 4.0s` when settled if a duration is derivable, else `Thought` — from the group's steps (the block receives its step by `partIndex`).

- [ ] **Step 1: Write the failing behaviour tests** (append to `assistant-activity-timeline.behavior.test.tsx`; the harness and fixtures already exist):

```tsx
  it('names the running tool in the header and settles into a verb summary', async () => {
    const finish = deferred();
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: completedPartsWithEvents.slice(0, 9) };
        await finish.promise;
        yield { content: completedPartsWithEvents };
      },
    };
    const user = userEvent.setup();
    render(<Harness adapter={adapter} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    const [, second] = screen.getAllByTestId('assistant-activity-group');
    expect(within(second as HTMLElement).getByTestId('assistant-activity-working')).toHaveTextContent('Calling linear.list_comments');
    await act(async () => { finish.release(); });
    await screen.findByText('Review complete.');
    await waitFor(() => expect(second).toHaveAttribute('data-state', 'done'));
    expect(within(second as HTMLElement).getByTestId('assistant-activity-summary')).toHaveTextContent('Called linear.list_comments, called linear.list_relations');
    expect(within(second as HTMLElement).getByTestId('assistant-activity-summary')).toHaveTextContent('Worked for');
    expect(within(second as HTMLElement).getByTestId('assistant-activity-summary')).toHaveTextContent('2 steps');
  }, 20_000);

  it('reads a model-written resting summary from message metadata when present', async () => {
    render(
      <Harness
        adapter={neverRunAdapter}
        initialMessages={[{ content: completedParts, metadata: { custom: { brainstrikeActivitySummary: 'Pulled the issue and its comments' } }, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const [first] = screen.getAllByTestId('assistant-activity-group');
    expect(within(first as HTMLElement).getByTestId('assistant-activity-summary')).toHaveTextContent('Pulled the issue and its comments');
  });
```

Note the fixture tools are named `linear_get_issue` / `linear_list_comments` (underscore form, no dot) — `verbForTool` reads those as unknown (`Using linear_list_comments`). Either rename the fixture tools to dotted MCP names (`linear.list_comments`) — preferred, it mirrors real MCP names — and update the handful of assertions that read the old names, or assert `Using …`. The test above assumes the rename.

`neverRunAdapter` = the `{ async run() { throw … } }` adapter the file already uses inline; extract it once at module scope.

Add to `assistant-reasoning-disclosure.behavior.test.tsx`: after `stream.finish()` and `Done.`, the settled block's button text contains `Thought` (and `Thought for` only if the reasoning duration is derivable; in the harness there are no run events, so assert `Thought` exactly).

- [ ] **Step 2: Run to verify they fail** — headline text still `Worked`; metadata override unread.

- [ ] **Step 3: Implement in `assistant-activity-parts.tsx`**

Inside `ActivityGroup` (after the existing derivations):

```tsx
  const steps = useMemo(() => deriveActivitySteps(groupParts, toolDurations), [groupParts, toolDurations]);
  const summary = useMemo(() => summarizeActivity(steps), [steps]);
  const detail = useMemo(() => {
    const running = steps.findLast((step) => step.kind === 'tool' && step.state === 'running');
    return running?.target ?? null;
  }, [steps]);
  const restingOverride = useAuiState((state) => readActivitySummaryOverride(state.message));
```

with, at module scope:

```ts
const ACTIVITY_SUMMARY_METADATA_KEY = 'brainstrikeActivitySummary';

/**
 * Seam for a future model-written resting summary (spec §4.2). Read-only today:
 * nothing writes it. A non-string or empty value is ignored — never coerced.
 */
function readActivitySummaryOverride(message: unknown): string | null {
  if (!(message && typeof message === 'object')) {
    return null;
  }
  const metadata = (message as { readonly metadata?: unknown }).metadata;
  if (!(metadata && typeof metadata === 'object')) {
    return null;
  }
  const custom = (metadata as { readonly custom?: unknown }).custom;
  if (!(custom && typeof custom === 'object')) {
    return null;
  }
  const value = (custom as Record<string, unknown>)[ACTIVITY_SUMMARY_METADATA_KEY];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
```

Replace the `<AssistantActivityGroup fallbackMs incompleteReason isActive reasoningActive summary={toolActivity}>` element with `<ActivityTrace detail={detail} fallbackMs={activityFallbackMs} incompleteReason={incompleteReason} isActive={isActivityActive} restingOverride={restingOverride} summary={summary}>`; drop the `reasoningActive` prop and the `toolActivity` usage (keep `useChainActivityDerivations` for durations/shell outputs/task list; if `toolActivity` becomes unused there, remove it from the hook's return and from `use-chain-activity-derivations.ts` + its test). Delete `assistant-activity-group.tsx` and its import. The reasoning block: pass `label={step?.state === 'running' ? 'Thinking' : 'Thought'}` computed from `steps.find((s) => s.partIndex === index)`; the block's static-label span reads that label.

Migrate tests per the Files list: every assertion that read `Worked` as the headline now reads the verb summary; keep `Stopped` / `Activity failed` cases. In the architecture test replace `assistant-activity-group.tsx` references with `activity-trace.tsx`. e2e: replace `toContainText('Worked')` with `toHaveAttribute('data-state', 'done')` and, for `tool-card-visuals`, `toContainText('Read')` after expanding.

- [ ] **Step 4: Run the whole package**: `cd packages/assistant-ui && pnpm test && pnpm test:browser`; `pnpm --filter @brainstrike/assistant-ui type-check`. All green. Then the four desktop e2e specs + web e2e from the phase-1 gate list.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src apps/desktop/e2e apps/web/e2e
git add -A packages/assistant-ui/src apps/desktop/e2e apps/web/e2e
git commit -m "feat(assistant-ui): activity groups render the ActivityTrace status row; delete AssistantActivityGroup

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Approval and delegation live states end-to-end

**Files:**
- Test: `packages/assistant-ui/src/__tests__/assistant-activity-parts.test.tsx` (append), `packages/assistant-ui/src/__tests__/assistant-hydration-liveness.test.tsx` (append)

No production change is expected; this task pins the two live states the model already produces against the real runtime and hydration, and fixes the model if either fails.

- [ ] **Step 1: Write the tests**

```tsx
  it('reads Waiting for approval while a call is paused at its gate, with a static glyph', async () => {
    render(<Harness adapter={neverRun} initialMessages={[{ content: [tool('x', { toolName: 'brainstrike.executeCommand', args: { command: 'rm x' }, argsText: '{"command":"rm x"}', result: undefined })], role: 'assistant', status: { reason: 'interrupt', type: 'requires-action' } }]} />);
    const group = await screen.findByTestId('assistant-activity-group');
    expect(within(group).getByTestId('assistant-activity-working')).toHaveTextContent('Waiting for approval');
    expect(group).toHaveAttribute('data-state', 'running');
  });

  it('reads Delegating to <persona> while a delegation runs and Delegated once done', async () => {
    /* live adapter: yield a tool-call `agent-explore` without result, then with result { text: 'ok', subAgentToolResults: [] } */
  });
```

Write the delegation case fully with the deferred-adapter pattern used elsewhere in the file (yield the part without a result, assert the header reads `Delegating to Explorer`, release, assert the summary reads `Delegated to Explorer`). The tool name is `agent-explore` (persona id `explore`).

Hydration case: a hydrated `requires-action` message is not something persistence produces (hydrated messages are `complete`), so add instead: a hydrated message with a delegation tool call that has a result → header `Delegated to Explorer · 1 step`, zero `[data-live="true"]`.

- [ ] **Step 2: Run, fix the model only if a case fails (state mapping is in `toolStepState`; the label in `liveLabel`), commit**

```bash
git commit -am "test(assistant-ui): pin approval-wait and delegation labels in the activity trace

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Use explicit `git add` of the two test files rather than `-am`.)

---

### Task 7: Docs

**Files:**
- Modify: `docs/agents/assistant-runtime.md` ACTIVITY GROUPS section
- Modify: `docs/agents/ui-conventions.md` (new short subsection "Motion")
- Modify: `docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md` §4.3 (mark what phase 2 shipped vs phase 3)

- [ ] **Step 1: Runtime contract.** Replace the header-grammar sentences with: the group renders `ActivityTrace` (`activity-trace.tsx`); the header names the current step while running (`Waiting for approval` > `<Verb-ing> <target>` > `Thinking` > `Working`, from `summarizeActivity` in `activity-trace-model.ts` over `deriveActivitySteps`), and at rest reads the verb summary (unique done-verbs, first-occurrence order, three max, edit/read file counts, `+N more`) with `Worked for Ns · N steps · N failed` as meta; `Stopped after Ns` and `Activity failed` remain the headlines for the group's own incomplete status; a reasoning block reads `Thinking` / `Thought`; the resting headline can be overridden by `message.metadata.custom.brainstrikeActivitySummary` (string; no producer exists; non-strings ignored); the header height is fixed and the running detail line is a fixed-height slot that collapses once at finish; the live label is `aria-live="off"` with a visually hidden polite state phrase; verbs live in `activity-verbs.ts`, total over the native catalog (pinned).
- [ ] **Step 2: ui-conventions.** Add: motion in the assistant thread is CSS-only (no animation library; strict catalog), lives under `.assistant-ui-panel` in `overrides.css`, uses the four `bs-trace-*` primitives (keyed label crossfade, grid-rows collapse, bounded stagger reveal, fixed-height detail slot), and every animation has `prefers-reduced-motion` and, where text is involved, `forced-colors` fallbacks.
- [ ] **Step 3: Spec §4.3.** Add a one-line status note: phase 2 shipped L0 (status row, detail line, motion) and reasoning labels; L1 step rows and the L2 re-skin of the tool cards are phase 3.
- [ ] **Step 4: Commit** `docs(agents): activity trace header grammar, summary seam, and motion conventions` (+ trailer).

---

### Task 8: Gates and live CDT verification

- [ ] **Step 1:** `pnpm --filter @brainstrike/assistant-ui type-check`; `cd packages/assistant-ui && pnpm test && pnpm test:browser`; `pnpm run lint:ci`; `npx react-doctor . --scope changed --base origin/main` (0 new errors).
- [ ] **Step 2:** Desktop e2e `assistant-tool-card-visuals`, `assistant-retrieval`, `assistant-approval-reload-linearity`, `assistant-network-decision` (`--project=regression`); `pnpm build:web` then web e2e `keeps streamed tool details collapsed` (use `PORT=8090` if 8080 is held).
- [ ] **Step 3: CDT (definition of done).** Reuse the pass-1 CDP driver and fetch mock from `.superpowers/sdd/bst1677-cdt-report.md`. Scenario: reasoning → read (1.5 s) → grep (1.5 s, ERROR) → edit ×2 → command, with run-event fences. Screenshots: (30) header mid-run reading `Reading src/app.ts` with the detail line beneath, collapsed; (31) header reading `Thinking` while a reasoning block streams; (32) resting header `Read, searched, edited 2 files +1 more · Worked for 9.0s · 5 steps · 1 failed`, collapsed, `data-state="done"`, `[data-live="true"]` 0; (33) expanded, cards revealed with the stagger (screenshot mid-animation acceptable); (34) reduced motion (`--force-prefers-reduced-motion` or `matchMedia` emulation via CDP `Emulation.setEmulatedMedia`) — no animation, static mark; (35) seeded reload of a completed turn: same resting header, 0 live. Evaluate and paste the `getBoundingClientRect().height` of the summary button live vs resting (must match).
- [ ] **Step 4:** File the phase-2 BST ticket if not yet filed, branch `feat/bst-<n>-activity-trace-status-row` from `origin/main` (after #3061 merged), open the PR with the screenshots, referencing this plan and the spec.
