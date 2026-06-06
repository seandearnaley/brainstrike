# Tool-Call & Run-Event UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the assistant's tool-call and run-event cards correct and compact — fix the stuck generation-step spinner, collapse each card to a single-line header with details in the fold, drop the redundant status badge (icon + tooltip instead), and tint cards by tool type (memory / internal / mcp / lifecycle).

**Architecture:** One pure classifier module drives tinting; the two existing card components (`tool-fallback.tsx`, `assistant-run-timeline.tsx`) are refactored to compact headers using it; a one-line resolution fix unblocks step spinners; CSS gives the left rail a category accent. Verified by pure-unit + component tests, plus a desktop Playwright screenshot test for visual confirmation.

**Tech Stack:** TypeScript (strict), React 19, `@assistant-ui/react`, Tailwind v4, Radix Tooltip, Vitest + Testing Library (`--project unit`), Playwright (desktop e2e). pnpm + Turborepo.

**Spec:** `docs/superpowers/specs/2026-06-05-tool-call-run-event-ui-refresh-design.md`

**Conventions verified in repo:**
- UI component tests: `*.test.tsx` under `__tests__/`, `@testing-library/react` + jest-dom (wired in `packages/ui/vitest.setup.ts`); run one file: `cd packages/ui && pnpm vitest run --project unit <path>`.
- Radix components need ResizeObserver + pointer-capture mocks in jsdom (see `packages/ui/src/model-picker/__tests__/model-picker.test.tsx` lines ~7-19 for the exact mocks) and a `TooltipProvider` wrapper around rendered output.
- Tooltip primitives: `import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip'`.
- `AssistantRunTimeline` takes `data: unknown` (an `AssistantRunEvent`) + optional `statusOverride`. `resolveAssistantRunEventStatus` and (after Task 1) the kind helpers are exported from the same file.
- Run-event tool metadata: tool events carry `metadata.toolName` (set by `makeToolEventMetadata` in agent-runtime).
- Internal tool names appear as `brainstrike.x` (contract/e2e mock) OR `brainstrike_x` (Mastra-sanitized — `sanitizeToolNameBase` replaces `.` with `_`).
- Desktop e2e: `apps/desktop/e2e/*.desktop.test.ts`; assistant mock `setupAssistantMock(window, { variant })` with variants `tool`, `tool-error`, `stream-error`; helpers in `assistant-retrieval.desktop.test.ts`. Run via `node ../../scripts/run-env.mjs ... -- pnpm exec playwright test e2e/<file> --project=regression --workers=1`.
- Repo uses ultracite (`pnpm dlx ultracite fix`); accept its alphabetization.
- Commits end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `packages/ui/src/assistant-ui-panel/tool-visual-classification.ts` | Pure: classify tool/run-event → category; category → tint classes; status tooltip label | New |
| `packages/ui/src/assistant-ui-panel/__tests__/tool-visual-classification.test.ts` | Classifier unit tests | New |
| `packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx` | Spinner fix + compact header + drop badge + tint | Modify |
| `packages/ui/src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx` | Resolution + render tests | New |
| `packages/ui/src/assistant-ui-panel/tool-fallback.tsx` | Compact header + drop badge + tint | Modify |
| `packages/ui/src/assistant-ui-panel/__tests__/tool-fallback.test.tsx` | Render tests | New |
| `packages/ui/src/assistant-ui-panel/overrides.css` | Left-rail accents + density | Modify |
| `apps/desktop/e2e/assistant-tool-card-visuals.desktop.test.ts` | Screenshots + structural assertions | New |

---

## Task 1: Fix the stuck generation-step spinner

**Files:**
- Modify: `packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx` (`getMatchingCompletedKind`, ~line 117; export it for testing)
- Test: `packages/ui/src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx
import { describe, expect, it } from 'vitest';
import {
  getMatchingCompletedKind,
  resolveAssistantRunEventStatus,
} from '../assistant-run-timeline';

function runEventPart(event: Record<string, unknown>) {
  return { name: 'brainstrike.assistant-run-event', data: event };
}

describe('getMatchingCompletedKind', () => {
  it('maps run.step.started to run.step.finished (not .completed)', () => {
    expect(getMatchingCompletedKind('run.step.started')).toBe('run.step.finished');
  });
  it('keeps run.started -> run.finished and tool.started -> tool.completed', () => {
    expect(getMatchingCompletedKind('run.started')).toBe('run.finished');
    expect(getMatchingCompletedKind('tool.started')).toBe('tool.completed');
  });
  it('maps non-run *.started to *.completed', () => {
    expect(getMatchingCompletedKind('memory.semantic.started')).toBe('memory.semantic.completed');
  });
});

describe('resolveAssistantRunEventStatus', () => {
  it('resolves a running generation step to completed when a finished event follows', () => {
    const started = {
      id: 'e1',
      kind: 'run.step.started',
      label: 'Generation step started',
      status: 'running',
      timestamp: '2026-06-05T00:00:00.000Z',
    };
    const finished = {
      id: 'e2',
      kind: 'run.step.finished',
      label: 'Generation step completed',
      status: 'completed',
      timestamp: '2026-06-05T00:00:01.000Z',
    };
    const messages = [{ role: 'assistant', parts: [runEventPart(started), runEventPart(finished)] }];
    expect(resolveAssistantRunEventStatus(messages, started as never)).toBe('completed');
  });
});
```

NOTE: confirm the exact `ASSISTANT_RUN_EVENT_DATA_NAME` value and use it for the part `name` (read the import in `assistant-run-timeline.tsx`; replace `'brainstrike.assistant-run-event'` with the real constant, or import and use it in the test).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx`
Expected: FAIL — `getMatchingCompletedKind` is not exported AND/OR `run.step.started` resolves to `running` (the bug).

- [ ] **Step 3: Implement the fix + export**

In `assistant-run-timeline.tsx`, replace `getMatchingCompletedKind` with:

```ts
export function getMatchingCompletedKind(
  kind: AssistantRunEventKind
): AssistantRunEventKind | null {
  if (kind === 'run.started') {
    return 'run.finished';
  }
  if (kind === 'tool.started') {
    return 'tool.completed';
  }
  if (kind.startsWith('run.') && kind.endsWith('.started')) {
    return kind.replace(/\.started$/, '.finished') as AssistantRunEventKind;
  }
  if (kind.endsWith('.started')) {
    return kind.replace(/\.started$/, '.completed') as AssistantRunEventKind;
  }
  return null;
}
```

(The function may currently be a non-exported `function`; add `export`. `resolveAssistantRunEventStatus` is already exported.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx packages/ui/src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx
git add packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx packages/ui/src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx
git commit -m "fix(ui): resolve generation-step run events so spinners stop spinning

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Tool visual classification module

**Files:**
- Create: `packages/ui/src/assistant-ui-panel/tool-visual-classification.ts`
- Test: `packages/ui/src/assistant-ui-panel/__tests__/tool-visual-classification.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/ui/src/assistant-ui-panel/__tests__/tool-visual-classification.test.ts
import { describe, expect, it } from 'vitest';
import {
  categoryTintClasses,
  classifyRunEvent,
  classifyToolName,
  isInternalToolName,
} from '../tool-visual-classification';

describe('isInternalToolName', () => {
  it('matches brainstrike. and brainstrike_ prefixes, case-insensitively', () => {
    expect(isInternalToolName('brainstrike.readWorkspaceFile')).toBe(true);
    expect(isInternalToolName('brainstrike_readWorkspaceFile')).toBe(true);
    expect(isInternalToolName('Brainstrike.queryEmbeddingSpace')).toBe(true);
  });
  it('does not match external/mcp tool names', () => {
    expect(isInternalToolName('searchDocs')).toBe(false);
    expect(isInternalToolName('filesystem_read_file')).toBe(false);
  });
});

describe('classifyToolName', () => {
  it('returns internal for brainstrike tools and mcp otherwise', () => {
    expect(classifyToolName('brainstrike.queryEmbeddingSpace')).toBe('internal');
    expect(classifyToolName('some_mcp_tool')).toBe('mcp');
  });
});

describe('classifyRunEvent', () => {
  it('classifies by kind and tool metadata', () => {
    expect(classifyRunEvent('memory.working.loaded')).toBe('memory');
    expect(classifyRunEvent('tool.started', 'brainstrike.readWorkspaceFile')).toBe('internal');
    expect(classifyRunEvent('tool.completed', 'searchDocs')).toBe('mcp');
    expect(classifyRunEvent('run.step.started')).toBe('lifecycle');
    expect(classifyRunEvent('run.finished')).toBe('lifecycle');
  });
  it('falls back to lifecycle for a tool event without a tool name', () => {
    expect(classifyRunEvent('tool.started')).toBe('lifecycle');
  });
});

describe('categoryTintClasses', () => {
  it('returns distinct, non-empty class strings per category', () => {
    const cats = ['memory', 'internal', 'mcp', 'lifecycle'] as const;
    const rails = cats.map((c) => categoryTintClasses(c).rail);
    expect(new Set(rails).size).toBe(cats.length);
    for (const c of cats) {
      expect(categoryTintClasses(c).card.length).toBeGreaterThan(0);
      expect(categoryTintClasses(c).rail.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel/__tests__/tool-visual-classification.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/ui/src/assistant-ui-panel/tool-visual-classification.ts
export type ToolVisualCategory = 'memory' | 'internal' | 'mcp' | 'lifecycle';

const INTERNAL_TOOL_PREFIX = /^brainstrike[._]/i;

/** Internal Brainstrike tools render as `brainstrike.x` or (Mastra-sanitized) `brainstrike_x`. */
export function isInternalToolName(name: string): boolean {
  return INTERNAL_TOOL_PREFIX.test(name);
}

/** Classify a per-tool card by its tool name. */
export function classifyToolName(name: string): 'internal' | 'mcp' {
  return isInternalToolName(name) ? 'internal' : 'mcp';
}

/** Classify a run-event card from its kind and optional tool metadata. */
export function classifyRunEvent(kind: string, toolName?: string): ToolVisualCategory {
  if (kind.startsWith('memory.')) {
    return 'memory';
  }
  if (kind.startsWith('tool.')) {
    return toolName ? classifyToolName(toolName) : 'lifecycle';
  }
  return 'lifecycle';
}

interface CategoryTint {
  /** Border + faint background applied to the card (non-failure state). */
  card: string;
  /** Left-rail accent color. */
  rail: string;
}

const TINTS: Record<ToolVisualCategory, CategoryTint> = {
  memory: { card: 'border-violet-300/50 bg-violet-500/5', rail: 'text-violet-500' },
  internal: { card: 'border-sky-300/50 bg-sky-500/5', rail: 'text-sky-500' },
  mcp: { card: 'border-teal-300/50 bg-teal-500/5', rail: 'text-teal-500' },
  lifecycle: { card: 'border-border bg-background/70', rail: 'text-muted-foreground' },
};

/** Subtle, theme-aware tint per category. Failure (red) is applied by the caller and overrides this. */
export function categoryTintClasses(category: ToolVisualCategory): CategoryTint {
  return TINTS[category];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel/__tests__/tool-visual-classification.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/ui/src/assistant-ui-panel/tool-visual-classification.ts packages/ui/src/assistant-ui-panel/__tests__/tool-visual-classification.test.ts
git add packages/ui/src/assistant-ui-panel/tool-visual-classification.ts packages/ui/src/assistant-ui-panel/__tests__/tool-visual-classification.test.ts
git commit -m "feat(ui): tool/run-event visual classification + tint mapping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Compact, badge-free per-tool card

**Files:**
- Modify: `packages/ui/src/assistant-ui-panel/tool-fallback.tsx`
- Test: `packages/ui/src/assistant-ui-panel/__tests__/tool-fallback.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// packages/ui/src/assistant-ui-panel/__tests__/tool-fallback.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '../tooltip';
import { ToolFallback } from '../tool-fallback';

// Radix tooltip needs these in jsdom.
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

function renderTool(props: Record<string, unknown>) {
  // ToolFallback is an assistant-ui ToolCallMessagePartComponent; cast minimal props.
  const Comp = ToolFallback as unknown as (p: Record<string, unknown>) => JSX.Element;
  return render(
    <TooltipProvider>
      <Comp {...props} />
    </TooltipProvider>
  );
}

describe('ToolFallback', () => {
  it('renders an internal tool with category attr and no redundant status badge', () => {
    renderTool({
      toolName: 'brainstrike.queryEmbeddingSpace',
      argsText: '{"q":"x"}',
      result: { ok: true },
      status: { type: 'complete' },
    });
    const card = screen.getByTestId('tool-fallback');
    expect(card.getAttribute('data-tool-category')).toBe('internal');
    // The status pill text must NOT be present as a standalone badge.
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('reveals arguments and result when expanded', () => {
    renderTool({
      toolName: 'searchDocs',
      argsText: '{"q":"x"}',
      result: { answer: 42 },
      status: { type: 'complete' },
    });
    const card = screen.getByTestId('tool-fallback');
    expect(card.getAttribute('data-tool-category')).toBe('mcp');
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText(/Arguments/i)).toBeInTheDocument();
    expect(screen.getByText(/Result/i)).toBeInTheDocument();
  });
});
```

NOTE: the `status` literal must match assistant-ui's `ToolCallMessagePartComponent` status type — read the existing `resolveDisplayStatus` to confirm the success/running/incomplete `type` values (`'running'`, `'incomplete'`, and the completed variant) and adjust the literal so `displayStatus` is `success`/`running` as intended. Keep the structural assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel/__tests__/tool-fallback.test.tsx`
Expected: FAIL — no `data-tool-category`, and "Completed" badge text is present.

- [ ] **Step 3: Implement the refactor**

Edit `tool-fallback.tsx`:
1. Import the classifier + tooltip:
```ts
import { categoryTintClasses, classifyToolName } from './tool-visual-classification';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
```
2. Remove the `STATUS_LABELS` pill usage (delete the `<span class="...rounded-full...">{statusText}</span>` in the header). Keep `STATUS_LABELS` (now used only for the icon tooltip label) or inline it.
3. Compute the category + tint:
```ts
const category = classifyToolName(toolName);
const tint = categoryTintClasses(category);
```
4. Card className: failure keeps red and overrides; otherwise use `tint.card`:
```tsx
className={`bs-tool-timeline my-1.5 rounded-lg border ${
  isError ? 'border-destructive/50 bg-destructive/5' : tint.card
}`}
data-testid="tool-fallback"
data-tool-category={category}
```
5. Wrap the status icon in a tooltip (status conveyed by icon, not pill) and add an sr-only label:
```tsx
<div className={`bs-tool-timeline-rail ${isError ? 'text-destructive' : tint.rail}`}>
  <Tooltip>
    <TooltipTrigger asChild>
      <span aria-label={statusText} className="inline-flex">{statusIcon}</span>
    </TooltipTrigger>
    <TooltipContent>{statusText}</TooltipContent>
  </Tooltip>
  <span className="sr-only">{statusText}</span>
</div>
```
6. Single-line header: keep `Used {toolName}` (with the wrench icon) but remove the badge; tighten padding (`px-3 py-2`). Keep the running hint + error message + the existing args/result expander unchanged (it already lives in the fold).

- [ ] **Step 4: Run test + full ui assistant-panel suite**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel`
Expected: new tests pass; existing assistant-panel tests still pass.

- [ ] **Step 5: Type-check + lint + commit**

```bash
cd packages/ui && pnpm exec tsc --noEmit
pnpm dlx ultracite fix packages/ui/src/assistant-ui-panel/tool-fallback.tsx packages/ui/src/assistant-ui-panel/__tests__/tool-fallback.test.tsx
git add packages/ui/src/assistant-ui-panel/tool-fallback.tsx packages/ui/src/assistant-ui-panel/__tests__/tool-fallback.test.tsx
git commit -m "feat(ui): compact, badge-free tool card with per-type tint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Compact, badge-free run-event card

**Files:**
- Modify: `packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx`
- Test: add to `packages/ui/src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx`

- [ ] **Step 1: Add the failing render test**

```tsx
// append to assistant-run-timeline.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '../tooltip';
import { AssistantRunTimeline } from '../assistant-run-timeline';

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});

function renderTimeline(data: Record<string, unknown>) {
  return render(
    <TooltipProvider>
      <AssistantRunTimeline data={data} />
    </TooltipProvider>
  );
}

describe('AssistantRunTimeline render', () => {
  it('tints a memory event and omits the standalone status badge; kind is only in the fold', () => {
    renderTimeline({
      id: 'm1',
      kind: 'memory.working.loaded',
      label: 'Working memory loaded',
      status: 'completed',
      timestamp: '2026-06-05T00:00:00.000Z',
      detail: 'Loaded 3 notes',
    });
    const card = screen.getByTestId('assistant-run-timeline');
    expect(card.getAttribute('data-tool-category')).toBe('memory');
    expect(screen.queryByText('Completed')).toBeNull(); // no pill
    expect(screen.queryByText('memory.working.loaded')).toBeNull(); // kind hidden until expanded
    fireEvent.click(screen.getByRole('button', { name: /expand/i }));
    expect(screen.getByText('memory.working.loaded')).toBeInTheDocument();
  });

  it('classifies a tool run event by its tool metadata', () => {
    renderTimeline({
      id: 't1',
      kind: 'tool.completed',
      label: 'Tool completed',
      status: 'completed',
      timestamp: '2026-06-05T00:00:00.000Z',
      metadata: { toolName: 'brainstrike.queryEmbeddingSpace' },
    });
    expect(screen.getByTestId('assistant-run-timeline').getAttribute('data-tool-category')).toBe('internal');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx`
Expected: FAIL — no `data-tool-category`; "Completed" pill present; `kind` shown outside the fold.

- [ ] **Step 3: Implement the refactor**

Edit `assistant-run-timeline.tsx`:
1. Import: `import { categoryTintClasses, classifyRunEvent } from './tool-visual-classification';` and `import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';`
2. Compute category from kind + tool metadata:
```ts
const toolName = typeof event.metadata?.['toolName'] === 'string' ? event.metadata['toolName'] : undefined;
const category = classifyRunEvent(event.kind, toolName);
const tint = categoryTintClasses(category);
```
3. Card className: failed overrides to red; else `tint.card`; add `data-tool-category={category}`; tighten margin (`my-1.5`).
4. Wrap the status icon in a Tooltip with `aria-label={statusLabel}` + `sr-only` span (same pattern as Task 3); rail uses `tint.rail` (failed → destructive).
5. Remove the `STATUS_LABELS` pill `<span class="...rounded-full...">{statusLabel}</span>`.
6. Single-line header: keep `<label>` + inline time (`formatTimestamp`), small/muted. MOVE `event.kind` and `durationLabel` OUT of the always-visible header and INTO `AssistantRunTimelineDetails` (render them as the first rows of the fold). Update `hasDetails` to also be true when `event.kind` should be shown — i.e. always show the expander when there is a kind/duration/detail/metadata (kind is always present, so the expander is effectively always available). Render kind + duration inside `AssistantRunTimelineDetails`.

Concretely, change `AssistantRunTimelineDetails` to also accept `kind` and `durationLabel` and render them:
```tsx
<div className="border-t border-dashed px-3 py-2" id={detailsId}>
  <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
    <div className="contents"><dt className="font-medium text-muted-foreground">kind</dt><dd className="text-foreground/90">{kind}</dd></div>
    {durationLabel ? (<div className="contents"><dt className="font-medium text-muted-foreground">duration</dt><dd className="text-foreground/90">{durationLabel}</dd></div>) : null}
    {/* existing metadata rows */}
  </dl>
  {detail ? <p className="mt-2 text-muted-foreground text-xs">{detail}</p> : null}
</div>
```
and set `const hasDetails = true;` (kind always provides fold content) so the chevron is always present.

- [ ] **Step 4: Run test + full ui assistant-panel suite**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel`
Expected: all pass.

- [ ] **Step 5: Type-check + lint + commit**

```bash
cd packages/ui && pnpm exec tsc --noEmit
pnpm dlx ultracite fix packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx packages/ui/src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx
git add packages/ui/src/assistant-ui-panel/assistant-run-timeline.tsx packages/ui/src/assistant-ui-panel/__tests__/assistant-run-timeline.test.tsx
git commit -m "feat(ui): compact, badge-free run-event card with per-type tint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: CSS density + left-rail accent

**Files:**
- Modify: `packages/ui/src/assistant-ui-panel/overrides.css`

- [ ] **Step 1: Tighten rail + spacing**

Find the `.bs-tool-timeline-rail` / `.bs-run-timeline-rail` rules. Ensure the rail column vertically centers the (now tooltip-wrapped) icon and reads as a slim accent. Reduce any oversized vertical spacing so the denser `my-1.5` / `px-3 py-2` from Tasks 3-4 is consistent. Do NOT hardcode category colors here — those come from the Tailwind classes in `categoryTintClasses` (Task 2). Only adjust layout/spacing of the rail and card rhythm. Keep WAI-ARIA/treegrid-adjacent semantics intact (these are cards, not the treegrid).

Example (adjust to the existing rules rather than adding duplicates):
```css
.bs-tool-timeline-rail,
.bs-run-timeline-rail {
  display: flex;
  align-items: center;
  justify-content: center;
}
```

- [ ] **Step 2: Verify visually via the UI suite + type-check**

Run: `cd packages/ui && pnpm vitest run --project unit src/assistant-ui-panel`
Expected: still green (CSS change shouldn't break tests).

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/assistant-ui-panel/overrides.css
git commit -m "style(ui): tighten tool/run-event card rail + density

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Desktop e2e screenshots + structural assertions

**Files:**
- Create: `apps/desktop/e2e/assistant-tool-card-visuals.desktop.test.ts`

- [ ] **Step 1: Study the harness**

Read `apps/desktop/e2e/assistant-retrieval.desktop.test.ts` for the `setupAssistantMock` + open-chat + send-prompt helpers and `apps/desktop/e2e/assistant-stream-error-recovery.desktop.test.ts` (added in workstream #1) for the run command/project. Note `getByTestId('tool-fallback')`.

- [ ] **Step 2: Write the test (drive + screenshot + assert structure)**

Create a spec that, for the `tool` and `tool-error` mock variants, opens the assistant, sends a prompt, waits for the tool card, captures a screenshot to a file, and asserts the structural contract:

```ts
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible, ensureMockWorkspaceOpen } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import { E2E_TIMEOUTS } from './utils/timeouts';

test.describe('Assistant tool card visuals (desktop)', () => {
  test.beforeEach(async ({ window }) => {
    const { mockFileSystemOperations } = await loadElectronHelpers();
    await mockFileSystemOperations(window);
    await ensureMockWorkspaceOpen(window);
  });

  test('tool card is compact, tinted, badge-free, and expands to args/result', async ({ window }) => {
    await setupAssistantMock(window, { variant: 'tool', message: 'Retrieved answer.' });
    await ensureAssistantShellVisible(window);
    // open chat + send prompt (copy helpers from assistant-retrieval.desktop.test.ts)
    const input = window.locator('#assistant-input');
    await input.fill('find db files');
    await window.getByRole('button', { name: 'Send' }).click();

    const toolCard = window.getByTestId('tool-fallback').first();
    await expect(toolCard).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    // category tint present (mock uses brainstrike.retrieveContext -> internal)
    await expect(toolCard).toHaveAttribute('data-tool-category', 'internal');
    // no standalone status badge text
    await expect(toolCard.getByText('Completed', { exact: true })).toHaveCount(0);
    await window.screenshot({ path: 'e2e-artifacts/tool-card-success.png' });
  });

  test('tool-error card renders error state', async ({ window }) => {
    await setupAssistantMock(window, { variant: 'tool-error', errorMessage: 'Boom.' });
    await ensureAssistantShellVisible(window);
    const input = window.locator('#assistant-input');
    await input.fill('find db files');
    await window.getByRole('button', { name: 'Send' }).click();
    const toolCard = window.getByTestId('tool-fallback').first();
    await expect(toolCard).toBeVisible({ timeout: E2E_TIMEOUTS.toolVisibility });
    await window.screenshot({ path: 'e2e-artifacts/tool-card-error.png' });
  });
});
```

ADAPT: mirror the exact open-chat/send-prompt helper functions from `assistant-retrieval.desktop.test.ts` (it defines `openAssistantChat`/`sendPrompt`). Confirm the mock's tool name (`brainstrike.retrieveContext`) classifies as `internal`. If the screenshot dir needs to be gitignored, do NOT commit the PNGs (add `apps/desktop/e2e-artifacts/` to `.gitignore` if not already ignored) — the screenshots are for local/CI artifact review, not committed baselines.

- [ ] **Step 3: Run it (twice for flake)**

Run: `cd apps/desktop && node ../../scripts/run-env.mjs NO_COLOR= BRAINSTRIKE_DISABLE_FILE_LOGS=1 LOG_LEVEL=warn -- pnpm exec playwright test e2e/assistant-tool-card-visuals.desktop.test.ts --project=regression --workers=1`
Expected: PASS. If the structural assertion reveals the real classified category differs (e.g., sanitized name), adjust the classifier or assertion accordingly and re-run.

- [ ] **Step 4: Capture screenshots for review + commit the test**

After a green run, the controller will attach the PNGs from `apps/desktop/e2e-artifacts/` for the user to review.

```bash
git add apps/desktop/e2e/assistant-tool-card-visuals.desktop.test.ts .gitignore
git commit -m "test(desktop): e2e screenshots + structural checks for tool card visuals

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full gate + PR

- [ ] **Step 1: Full local gate (CI parity)**

Run from repo root: `pnpm type-check && pnpm lint:ci && pnpm build && pnpm test`
Expected: all green together. Fix anything red and re-run the whole suite. (`db#test` can flake under turbo concurrency — re-run in isolation to confirm.)

- [ ] **Step 2: Push + PR + monitor CI**

```bash
git push -u origin harden/tool-call-ui-refresh
gh pr create --base main --fill
gh pr checks --watch
```
Fix any red checks (including `codecov/patch` — the classifier + resolution fix are well-covered; if patch coverage dips, add focused render-path coverage) and push until green.

---

## Self-Review (completed by author)

- **Spec coverage:** Stuck-spinner fix → Task 1. Classifier + tints → Task 2. Compact/badge-free tool card + tint → Task 3. Compact/badge-free run-event card + tint + kind/duration-into-fold → Task 4. Density/rail CSS → Task 5. Screenshots + structural assertions (Playwright grounding) → Task 6. Full gate + PR → Task 7. Accessibility (icon tooltip + sr-only, keyboard expander preserved) → Tasks 3 & 4. Args/results keep-and-verify → Task 3 expander test.
- **Type consistency:** `classifyToolName`/`classifyRunEvent`/`isInternalToolName`/`categoryTintClasses` (returning `{card, rail}`) and `ToolVisualCategory` used consistently across Tasks 2-4. `getMatchingCompletedKind` exported in Task 1 and used by `resolveAssistantRunEventStatus`. `data-tool-category` attribute consistent across Tasks 3, 4, 6.
- **Investigate-then-implement spots (carry exact files + intent + a red/green test):** the assistant-ui `status` literal in Task 3 (match `ToolCallMessagePartComponent`), the real `ASSISTANT_RUN_EVENT_DATA_NAME` constant in Task 1's test, and the e2e helper functions + classified category in Task 6 — each names what to read and the assertion to keep.
