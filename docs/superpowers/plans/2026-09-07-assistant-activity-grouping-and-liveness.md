# Assistant Activity Grouping + Hydration Liveness (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One activity group per contiguous run of reasoning and tool calls (instead of one "Worked · 1 step" group per tool call), and no live animation on a reloaded thread unless the thing it reports is genuinely still pending.

**Architecture:** The assistant message stops using the library's legacy `components.ChainOfThought` path (whose grouper ends a group on any `data` part) and renders `MessagePrimitive.GroupedParts` with an inline `groupBy` that keeps `brainstrike.run-event` (and other transparent) data parts inside the group while approval/suspend cards and always-visible run events stay standalone. A new `assistant-activity-parts.tsx` owns the group wrapper (today's `AssistantActivityGroup` chrome, unchanged visually) and the leaf renderers; the panel's `LocalChainOfThought` and its helpers are deleted. The run-event derivation gains one renderer rule: a `running` row whose owning message has settled resolves to `interrupted` (static glyph) unless a still-pending pause card for that call exists. Every live indicator carries `data-live` so one selector proves a hydrated thread is quiet.

**Tech Stack:** TypeScript strict, React 19, `@assistant-ui/react ~0.15.18` (`MessagePrimitive.GroupedParts`, `useAuiState`), Vitest (unit `jsdom` + browser projects), Playwright, Biome/Ultracite.

Spec: `docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md` (§4.1, §4.6, phase 1 of §7). Phases 2 and 3 get their own plans after this lands.

## Global Constraints

- TypeScript strict. Never `any` — prefer `unknown` + narrowing. Annotate params and return types. Discriminated unions over enums.
- NO FALLBACKS / NO SILENT DEGRADATION: an absent message status is left as-is, never guessed as settled.
- No new dependencies. No animation library. No `patchedDependencies`.
- Filenames kebab-case; components export PascalCase; object keys and interface members sorted alphabetically (Biome enforces); block statements; `biome-ignore` comments carry a reason.
- `assistant-ui-panel.tsx` is under an enforced source-line budget (`assistant-ui-panel-architecture.test.ts`); it must shrink, never grow.
- Visual chrome of the activity group does NOT change in this phase (same test ids: `assistant-activity-group`, `assistant-activity-summary`, `assistant-activity-body`, `assistant-activity-working`, `local-chain-of-thought`, `assistant-reasoning-indicator`; same labels `Worked`, `Working`, `Stopped`, `Activity failed`, `N steps`, `Show thinking`/`Hide thinking`). Four e2e specs sync on `aria-expanded="false"` after a turn; that contract is preserved.
- Hydrated assistant messages keep `status: { reason: 'stop', type: 'complete' }` (persistence contract). Nothing here touches `packages/assistant-data`.
- MCP-app tool calls stay INSIDE the activity group in this phase (Brainstrike detects MCP apps by RESULT shape only, and a call must not jump groups when its result lands). The spec's "standalone MCP app" row is deferred and the spec is amended in Task 8.
- Always-visible run events (`isAlwaysVisibleRunEvent`) are STANDALONE parts, not group members: a collapsed group must never hide `run.failed`, `run.cancelled`, `mcp.tools.unavailable`, `tool.approval.requested`, or `tool.resume.unsupported`. They occur at run start, at a pause, or at run end, so splitting on them never fragments a run's tool calls.
- Run `pnpm dlx ultracite fix` before every commit. Unit tests: `cd packages/assistant-ui && pnpm vitest run --project unit <file>`. Browser tests: `pnpm vitest run --project browser <file>`. Types: `pnpm --filter @brainstrike/assistant-ui type-check`.
- Live CDT verification with screenshots is the definition of done for the final task.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/assistant-ui/src/assistant-activity-grouping.ts` | **New.** Pure `groupBy` for `MessagePrimitive.GroupedParts`: which parts join `group-activity`, which stay standalone. No React. |
| `packages/assistant-ui/src/assistant-activity-parts.tsx` | **New.** `AssistantActivityParts` (the message-parts renderer), `ActivityGroup` (per-group wrapper: derivations + `AssistantActivityGroup` chrome + reasoning fold), leaf renderers, and the helpers moved out of the panel. |
| `packages/assistant-ui/src/assistant-ui-panel.tsx` | Loses `LocalChainOfThought`, `ChainReasoningFold`, `ActivityToolPart`, `ActivityPartLayout`, `HiddenReasoningPart`, `isActivityPart`, `isReasoningPart`, `isRunningReasoningPart`, `reasoningToggleLabel`; `AssistantMessage` renders `<AssistantActivityParts />`. |
| `packages/assistant-ui/src/assistant-activity-group.tsx` | Adds `data-state` and `data-live`. Chrome unchanged. |
| `packages/assistant-ui/src/assistant-thinking-indicator.tsx` | `BrainstrikeThinkingMark` gains `live` prop → `data-live`. |
| `packages/assistant-ui/src/assistant-run-event-derivation.ts` | `AssistantRunEventDisplayStatus`, the interrupted rule, pending-pause exemption. |
| `packages/assistant-ui/src/assistant-run-event-context.tsx`, `assistant-run-timeline.tsx`, `assistant-run-timeline-data-part.tsx` | Widened status type; `interrupted` label/icon; approval label override. |
| `packages/assistant-ui/src/subagent-tool-rows.ts`, `subagent-execution-card.tsx` | `interrupted` child-row status; reduced-motion + `data-live` on the pulse. |
| Tests (`packages/assistant-ui/src/__tests__/`) | `assistant-activity-grouping.test.ts` (new), `assistant-activity-parts.test.tsx` (new, replaces the five panel chain-of-thought tests), `assistant-hydration-liveness.test.tsx` (new), fixture + behavior + browser + reasoning-disclosure + panel + architecture + run-timeline + subagent tests updated. |
| `docs/agents/assistant-runtime.md`, `docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md` | Contract paragraph rewritten; spec §4.1 amended. |

---

### Task 1: Pure grouping function

**Files:**
- Create: `packages/assistant-ui/src/assistant-activity-grouping.ts`
- Test: `packages/assistant-ui/src/__tests__/assistant-activity-grouping.test.ts`

**Interfaces:**
- Consumes: `isAlwaysVisibleRunEvent(data)` from `./assistant-run-event-derivation`; `ASSISTANT_RUN_EVENT_DATA_NAME`, `CONTEXT_BREAKDOWN_DATA_NAME`, `CHILD_RUN_USAGE_DATA_NAME`, `SHELL_OUTPUT_DATA_NAME` from `@brainstrike/assistant-contract` (all already imported by `assistant-ui-panel.tsx`; copy the exact import specifiers from there).
- Produces: `ACTIVITY_GROUP_KEY = 'group-activity'`, `type ActivityGroupKey`, `groupAssistantActivityPart(part: PartState): readonly ActivityGroupKey[]`, `isActivityPart(part: unknown): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/assistant-ui/src/__tests__/assistant-activity-grouping.test.ts
import type { PartState } from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  CHILD_RUN_USAGE_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  SHELL_OUTPUT_DATA_NAME,
} from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_GROUP_KEY,
  groupAssistantActivityPart,
  isActivityPart,
} from '../assistant-activity-grouping';

const complete = { type: 'complete' } as const;

function part(value: Record<string, unknown>): PartState {
  return { status: complete, ...value } as unknown as PartState;
}

function runEvent(kind: string, status = 'completed'): PartState {
  return part({
    data: { id: `evt-${kind}`, kind, label: kind, status, timestamp: '2026-09-07T00:00:00.000Z' },
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data',
  });
}

describe('groupAssistantActivityPart', () => {
  it('folds reasoning and tool calls into the activity group', () => {
    expect(groupAssistantActivityPart(part({ text: 'hmm', type: 'reasoning' }))).toEqual([
      ACTIVITY_GROUP_KEY,
    ]);
    expect(
      groupAssistantActivityPart(
        part({ args: {}, argsText: '{}', toolCallId: 'a', toolName: 'x', type: 'tool-call' })
      )
    ).toEqual([ACTIVITY_GROUP_KEY]);
  });

  it('keeps text standalone (BST-1656: text splits activity)', () => {
    expect(groupAssistantActivityPart(part({ text: 'Done.', type: 'text' }))).toEqual([]);
  });

  it.each(['tool.started', 'tool.completed', 'run.step.started', 'memory.working.loaded'])(
    'makes an ordinary run event (%s) group-transparent',
    (kind) => {
      expect(groupAssistantActivityPart(runEvent(kind))).toEqual([ACTIVITY_GROUP_KEY]);
    }
  );

  it.each([
    'run.failed',
    'run.cancelled',
    'mcp.tools.unavailable',
    'tool.approval.requested',
    'tool.resume.unsupported',
  ])('keeps an always-visible run event (%s) standalone so a collapsed group cannot hide it', (kind) => {
    expect(groupAssistantActivityPart(runEvent(kind, 'failed'))).toEqual([]);
  });

  it.each([SHELL_OUTPUT_DATA_NAME, CONTEXT_BREAKDOWN_DATA_NAME, CHILD_RUN_USAGE_DATA_NAME])(
    'makes the null-rendering %s data part group-transparent',
    (name) => {
      expect(groupAssistantActivityPart(part({ data: {}, name, type: 'data' }))).toEqual([
        ACTIVITY_GROUP_KEY,
      ]);
    }
  );

  it.each([TOOL_APPROVAL_DATA_NAME, TOOL_SUSPEND_DATA_NAME])(
    'keeps the human-in-the-loop %s card standalone',
    (name) => {
      expect(groupAssistantActivityPart(part({ data: {}, name, type: 'data' }))).toEqual([]);
    }
  );

  it('keeps an unknown data part standalone rather than guessing', () => {
    expect(groupAssistantActivityPart(part({ data: {}, name: 'vendor.x', type: 'data' }))).toEqual(
      []
    );
  });
});

describe('isActivityPart', () => {
  it('is true only for reasoning and tool-call parts', () => {
    expect(isActivityPart({ type: 'reasoning' })).toBe(true);
    expect(isActivityPart({ type: 'tool-call' })).toBe(true);
    expect(isActivityPart({ type: 'data' })).toBe(false);
    expect(isActivityPart(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-activity-grouping.test.ts`
Expected: FAIL — `Cannot find module '../assistant-activity-grouping'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/assistant-ui/src/assistant-activity-grouping.ts
import type { PartState } from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  CHILD_RUN_USAGE_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  SHELL_OUTPUT_DATA_NAME,
} from '@brainstrike/assistant-contract';
import { isAlwaysVisibleRunEvent } from './assistant-run-event-derivation';

/**
 * The one synthetic group key the assistant message renders through
 * `MessagePrimitive.GroupedParts`. Adjacent parts that map to it coalesce into
 * one activity group (today's "Worked for Ns · N steps" panel).
 */
export const ACTIVITY_GROUP_KEY = 'group-activity';
export type ActivityGroupKey = typeof ACTIVITY_GROUP_KEY;

const ACTIVITY_GROUP: readonly ActivityGroupKey[] = Object.freeze([ACTIVITY_GROUP_KEY]);
const STANDALONE: readonly ActivityGroupKey[] = Object.freeze([]);

/**
 * Data parts that must NOT end an activity group. Ordinary run events are
 * emitted around every tool call (`tool.started` / `tool.completed` live, and
 * woven between parts on reload), and the library's grouper would otherwise
 * fence every call into its own one-step group. The three null-rendering parts
 * are transient bookkeeping that arrives mid-run.
 */
const GROUP_TRANSPARENT_DATA_NAMES: ReadonlySet<string> = new Set([
  CHILD_RUN_USAGE_DATA_NAME,
  CONTEXT_BREAKDOWN_DATA_NAME,
  SHELL_OUTPUT_DATA_NAME,
]);

/** True only for the two part types that carry activity (BST-1656 wording). */
export function isActivityPart(part: unknown): boolean {
  if (!(part && typeof part === 'object')) {
    return false;
  }
  const type = (part as { readonly type?: unknown }).type;
  return type === 'tool-call' || type === 'reasoning';
}

/**
 * `groupBy` for `MessagePrimitive.GroupedParts`.
 *
 * - reasoning / tool-call → the activity group.
 * - `brainstrike.run-event` → transparent, EXCEPT always-visible kinds, which
 *   stay standalone so a collapsed group can never hide a failed/cancelled run,
 *   a skipped MCP server, or a pending approval row.
 * - shell-output / context-breakdown / child-run-usage → transparent.
 * - tool-approval / tool-suspend cards, text, and anything unrecognised →
 *   standalone. A pause is a real boundary: the trace before it settles and
 *   the resumed leg starts a new group.
 */
export function groupAssistantActivityPart(part: PartState): readonly ActivityGroupKey[] {
  if (part.type === 'reasoning' || part.type === 'tool-call') {
    return ACTIVITY_GROUP;
  }
  if (part.type !== 'data') {
    return STANDALONE;
  }
  if (part.name === ASSISTANT_RUN_EVENT_DATA_NAME) {
    return isAlwaysVisibleRunEvent(part.data) ? STANDALONE : ACTIVITY_GROUP;
  }
  return GROUP_TRANSPARENT_DATA_NAMES.has(part.name) ? ACTIVITY_GROUP : STANDALONE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-activity-grouping.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Mutate each guard once, watch a test fail, revert**

Change `return isAlwaysVisibleRunEvent(part.data) ? STANDALONE : ACTIVITY_GROUP;` to always return `ACTIVITY_GROUP` → the always-visible `it.each` fails. Revert. Change the final line to always return `ACTIVITY_GROUP` → the unknown-data-part test fails. Revert.

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src/assistant-activity-grouping.ts packages/assistant-ui/src/__tests__/assistant-activity-grouping.test.ts
git add packages/assistant-ui/src/assistant-activity-grouping.ts packages/assistant-ui/src/__tests__/assistant-activity-grouping.test.ts
git commit -m "feat(assistant-ui): pure groupBy that keeps run-event data parts inside an activity group

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `AssistantActivityParts` module on `MessagePrimitive.GroupedParts`

Builds the replacement renderer beside the old one. The panel is switched over in Task 3, so this task leaves `assistant-ui-panel.tsx` untouched and proves the new module through the real-runtime harness.

**Files:**
- Create: `packages/assistant-ui/src/assistant-activity-parts.tsx`
- Modify: `packages/assistant-ui/src/__tests__/assistant-activity-timeline-fixtures.tsx` (Harness renders the new module; add run-event fixtures)
- Modify: `packages/assistant-ui/src/__tests__/assistant-activity-timeline.behavior.test.tsx` (add the data-part cases)
- Modify: `packages/assistant-ui/src/__tests__/assistant-reasoning-disclosure.behavior.test.tsx` (harness imports the new module)

**Interfaces:**
- Consumes: Task 1's `ACTIVITY_GROUP_KEY`, `groupAssistantActivityPart`, `isActivityPart`; `AssistantActivityGroup` (`./assistant-activity-group`); `useChainActivityDerivations(messageParts, messageId, groupParts)` (`./use-chain-activity-derivations`); `CHAIN_OF_THOUGHT_TOOL_COMPONENTS`, `TodoProgress` (`./todo-progress`); `ToolDurationProvider`, `ShellOutputProvider`; `AssistantReasoningPart`; `AssistantMessageText`; `AssistantThinkingIndicator`, `BrainstrikeThinkingMark`.
- Produces: `export function AssistantActivityParts(): ReactNode` — drop-in for the panel's `<MessagePrimitive.Parts components={{ ChainOfThought, Text }} />`.

- [ ] **Step 1: Update the fixtures so the Harness renders the new module and carries run events**

Replace the `Harness` in `packages/assistant-ui/src/__tests__/assistant-activity-timeline-fixtures.tsx` and add the event helpers. The full new file:

```tsx
import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  ComposerPrimitive,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { TooltipProvider } from '@brainstrike/ui';
import { AssistantActivityParts } from '../assistant-activity-parts';

export const firstParts = [
  { text: 'First reasoning segment.', type: 'reasoning' as const },
  {
    args: {},
    argsText: '{}',
    result: { id: 'BST-1656' },
    toolCallId: 'first',
    toolName: 'linear_get_issue',
    type: 'tool-call' as const,
  },
  { text: 'I found the issue.', type: 'text' as const },
];
export const secondReasoning = { text: 'Second reasoning segment.', type: 'reasoning' as const };
export const secondTools = ['comments', 'relations'].map((name) => ({
  args: {},
  argsText: '{}',
  toolCallId: name,
  toolName: `linear_list_${name}`,
  type: 'tool-call' as const,
}));
export const completedParts = [
  ...firstParts,
  secondReasoning,
  ...secondTools.map((tool) => ({ ...tool, result: { items: [] } })),
  { text: 'Review complete.', type: 'text' as const },
];

/**
 * A `brainstrike.run-event` data part in the exact shape the live decoder
 * (`aui-data` → `part-start`) and reload hydration (`toRunEventDataParts`)
 * both produce: `{ type: 'data', name, data: AssistantRunEvent }`.
 */
export function runEventPart(input: {
  readonly id: string;
  readonly kind: string;
  readonly runId?: string;
  readonly status?: 'cancelled' | 'completed' | 'failed' | 'info' | 'running';
  readonly timestamp: string;
  readonly toolCallId?: string;
}) {
  return {
    data: {
      id: input.id,
      kind: input.kind,
      label: input.kind,
      ...(input.toolCallId === undefined ? {} : { metadata: { toolCallId: input.toolCallId } }),
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      status: input.status ?? 'completed',
      timestamp: input.timestamp,
    },
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data' as const,
  };
}

/**
 * The FIELD shape of a finished turn: every tool call fenced by its own
 * `tool.started` / `tool.completed` events, plus the step bookkeeping the agent
 * emits around them. This is what produced the "Worked · 1 step" rows.
 */
export const completedPartsWithEvents = [
  runEventPart({ id: 'e-run', kind: 'run.started', status: 'running', timestamp: '2026-09-05T10:00:00.000Z' }),
  firstParts[0],
  runEventPart({ id: 'e-first-s', kind: 'tool.started', status: 'running', timestamp: '2026-09-05T10:00:01.000Z', toolCallId: 'first' }),
  firstParts[1],
  runEventPart({ id: 'e-first-c', kind: 'tool.completed', timestamp: '2026-09-05T10:00:03.000Z', toolCallId: 'first' }),
  firstParts[2],
  secondReasoning,
  runEventPart({ id: 'e-comments-s', kind: 'tool.started', status: 'running', timestamp: '2026-09-05T10:00:10.000Z', toolCallId: 'comments' }),
  { ...secondTools[0], result: { items: [] } },
  runEventPart({ id: 'e-comments-c', kind: 'tool.completed', timestamp: '2026-09-05T10:00:12.000Z', toolCallId: 'comments' }),
  runEventPart({ id: 'e-relations-s', kind: 'tool.started', status: 'running', timestamp: '2026-09-05T10:00:12.000Z', toolCallId: 'relations' }),
  { ...secondTools[1], result: { items: [] } },
  runEventPart({ id: 'e-relations-c', kind: 'tool.completed', timestamp: '2026-09-05T10:00:14.000Z', toolCallId: 'relations' }),
  runEventPart({ id: 'e-step', kind: 'run.step.finished', timestamp: '2026-09-05T10:00:14.000Z' }),
  { text: 'Review complete.', type: 'text' as const },
];

export function Harness({
  adapter,
  initialMessages = [],
}: {
  adapter: ChatModelAdapter;
  initialMessages?: ThreadMessageLike[];
}) {
  const runtime = useLocalRuntime(adapter, { initialMessages });
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages
            components={{
              AssistantMessage: () => (
                <MessagePrimitive.Root data-testid="timeline">
                  <AssistantActivityParts />
                </MessagePrimitive.Root>
              ),
              UserMessage: () => null,
            }}
          />
          <ComposerPrimitive.Root>
            <ComposerPrimitive.Input aria-label="Message" />
            <ComposerPrimitive.Send aria-label="Send" />
            <ComposerPrimitive.Cancel aria-label="Stop" />
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
```

`firstParts[0]`, `firstParts[1]`, `firstParts[2]`, `secondTools[0]`, `secondTools[1]` are typed as possibly undefined under `noUncheckedIndexedAccess`; if the compiler complains, destructure once at module scope: `const [firstReasoning, firstTool, firstText] = firstParts as [typeof firstParts[0], typeof firstParts[1], typeof firstParts[2]];` and use those names.

- [ ] **Step 2: Add the failing behavior tests (real runtime)**

Append to `packages/assistant-ui/src/__tests__/assistant-activity-timeline.behavior.test.tsx`, inside the existing `describe`, and add `completedPartsWithEvents` to the fixture import:

```tsx
  it('keeps every tool call of a run in ONE group when run events fence each call (field shape)', async () => {
    render(
      <Harness
        adapter={{
          async run() {
            throw new Error('Hydration must not invoke a model.');
          },
        }}
        initialMessages={[{ content: completedPartsWithEvents, role: 'assistant' }]}
      />
    );
    await screen.findByText('Review complete.');
    const { first, second } = expectChronologicalGroups();
    expect(first).toHaveTextContent('1 step');
    expect(second).toHaveTextContent('2 steps');
    expect(within(first).getByText('for 2.0s')).toBeInTheDocument();
    expect(within(second).getByText('for 4.0s')).toBeInTheDocument();
    // Ordinary run-event rows never render at the default detail level.
    expect(screen.queryAllByTestId('assistant-run-timeline')).toHaveLength(0);
  });

  it('keeps grouping when run events fence each call LIVE, and settles into one summary', async () => {
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
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Inspect this issue.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    const { second } = expectChronologicalGroups();
    expect(second).toHaveAttribute('data-active', 'true');
    await act(async () => {
      finish.release();
    });
    await screen.findByText('Review complete.');
    await waitFor(() => expect(second).toHaveAttribute('data-active', 'false'));
    expect(screen.getAllByTestId('assistant-activity-group')).toHaveLength(2);
    expect(second).toHaveTextContent('2 steps');
  }, 20_000);

```

Add `completedPartsWithEvents` to the import from `./assistant-activity-timeline-fixtures`. (The standalone placement of always-visible run events is asserted in Task 7, where the run-timeline data UI is registered and the row actually renders.)

- [ ] **Step 3: Run the behavior tests to verify they fail**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-activity-timeline.behavior.test.tsx`
Expected: FAIL — `Cannot find module '../assistant-activity-parts'`.

- [ ] **Step 4: Write the module**

```tsx
// packages/assistant-ui/src/assistant-activity-parts.tsx
import {
  MessagePrimitive,
  type ToolCallMessagePartProps,
  useAuiState,
} from '@assistant-ui/react';
import { cn } from '@brainstrike/ui';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { createContext, type ReactNode, use, useId, useMemo, useState } from 'react';
import {
  ACTIVITY_GROUP_KEY,
  type ActivityGroupKey,
  groupAssistantActivityPart,
  isActivityPart,
} from './assistant-activity-grouping';
import { AssistantActivityGroup } from './assistant-activity-group';
import { AssistantMessageText } from './assistant-message-text';
import { AssistantReasoningPart } from './assistant-reasoning-part';
import { AssistantThinkingIndicator, BrainstrikeThinkingMark } from './assistant-thinking-indicator';
import { ShellOutputProvider } from './shell-output-context';
import { CHAIN_OF_THOUGHT_TOOL_COMPONENTS, TodoProgress } from './todo-progress';
import { ToolDurationProvider } from './tool-duration-context';
import { useChainActivityDerivations } from './use-chain-activity-derivations';

/**
 * ACTIVITY PARTS (phase 1 of the activity-trace overhaul; spec
 * docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md).
 *
 * Renders an assistant message's parts through `MessagePrimitive.GroupedParts`
 * with `groupAssistantActivityPart` as the grouper. The legacy
 * `components.ChainOfThought` path ended a group on ANY non tool-call/reasoning
 * part, and this repo emits a `brainstrike.run-event` data part around every
 * tool call, so each call became its own "Worked · 1 step" group. Here the
 * run-event parts are group-transparent and one contiguous run of reasoning +
 * tool calls renders as one `AssistantActivityGroup`.
 *
 * BST-1656 rulings preserved: each contiguous group renders at its own
 * position (text splits), group status derives from that group's parts,
 * reasoning-only groups show no step count, the turn-wide task list renders
 * once in the first group, and wrappers stay mounted (the library keys a group
 * on its first part's id).
 */

function isReasoningPart(part: unknown): boolean {
  return Boolean(
    part && typeof part === 'object' && (part as { readonly type?: unknown }).type === 'reasoning'
  );
}

function isRunningReasoningPart(part: unknown): boolean {
  if (!isReasoningPart(part)) {
    return false;
  }
  const status = (part as { readonly status?: unknown }).status;
  return Boolean(
    status &&
      typeof status === 'object' &&
      (status as { readonly type?: unknown }).type === 'running'
  );
}

function reasoningToggleLabel(collapsed: boolean): string {
  return collapsed ? 'Show thinking' : 'Hide thinking';
}

/**
 * Per-group reasoning fold state. The library no longer owns a
 * `chainOfThought.collapsed` scope on the GroupedParts path, so the wrapper
 * holds it and the reasoning leaves read it through context. Leaves are
 * rendered as descendants of the wrapper (its `children`), so the provider
 * reaches them.
 */
const ReasoningCollapsedContext = createContext<boolean>(true);

/** Renders the reasoning text only while the fold is open. */
function ActivityReasoningLeaf() {
  const collapsed = use(ReasoningCollapsedContext);
  return collapsed ? null : <AssistantReasoningPart />;
}

function ActivityPartLayout({ children }: { children?: ReactNode }) {
  return <div className="mb-2 last:mb-0 empty:mb-0">{children}</div>;
}

function ActivityToolPart(props: ToolCallMessagePartProps) {
  const Component =
    CHAIN_OF_THOUGHT_TOOL_COMPONENTS.by_name[props.toolName] ??
    CHAIN_OF_THOUGHT_TOOL_COMPONENTS.Fallback;
  return <Component {...props} />;
}

/**
 * The collapsible reasoning fold: a pill that toggles the reasoning panel.
 * Tool cards always render inside the panel (the reasoning collapse only hides
 * reasoning parts), so the panel stays mounted to keep `aria-controls` valid.
 */
function ChainReasoningFold({
  children,
  collapsed,
  isReasoningRunning,
  onToggle,
  panelId,
}: {
  children: ReactNode;
  collapsed: boolean;
  isReasoningRunning: boolean;
  onToggle: () => void;
  panelId: string;
}) {
  return (
    <>
      <button
        aria-controls={panelId}
        aria-expanded={!collapsed}
        aria-label={reasoningToggleLabel(collapsed)}
        className="inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-border/70 bg-muted/20 px-2.5 text-left font-medium text-foreground text-xs transition-colors hover:bg-muted/35"
        data-testid="local-chain-of-thought"
        onClick={onToggle}
        type="button"
      >
        {isReasoningRunning ? (
          <AssistantThinkingIndicator
            className="min-w-0"
            markClassName="size-4"
            textClassName="truncate"
          />
        ) : (
          <span
            className="bs-thinking-indicator min-w-0"
            data-testid="assistant-reasoning-indicator"
          >
            <BrainstrikeThinkingMark
              className="bs-thinking-mark-static size-4"
              live={false}
              testId="assistant-reasoning-static-mark"
            />
            <span className="truncate">Thinking</span>
          </span>
        )}
        {collapsed ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronUpIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      <div
        className={cn(
          'bs-chain-of-thought-panel mt-2 empty:mt-0',
          collapsed ? '' : 'border-border/70 border-l pl-3'
        )}
        id={panelId}
      >
        {children}
      </div>
    </>
  );
}

interface ActivityGroupProps {
  readonly children: ReactNode;
  readonly indices: readonly number[];
  readonly status: { readonly type: string; readonly reason?: string };
}

/**
 * One contiguous activity group. Replaces the panel's `LocalChainOfThought`:
 * reads the group's parts by index from the message (the library's
 * `chainOfThought` scope does not exist on this path), derives the summary /
 * elapsed / durations exactly as before, and renders the unchanged
 * `AssistantActivityGroup` chrome around the reasoning fold.
 */
function ActivityGroup({ children, indices, status }: ActivityGroupProps) {
  const messageParts = useAuiState((state) => state.message.parts);
  const messageId = useAuiState((state) => (state.message as { id?: string }).id ?? '');
  const groupParts = useMemo(
    () => indices.map((index) => messageParts[index]).filter((part) => part !== undefined),
    [indices, messageParts]
  );
  const hasReasoningParts = groupParts.some(isReasoningPart);
  const isReasoningRunning = groupParts.some(isRunningReasoningPart);
  const isActivityActive = status.type === 'running';
  const incompleteReason =
    status.type === 'incomplete' && typeof status.reason === 'string' ? status.reason : undefined;
  // The task-list summary is turn-wide; render it once, in the group that
  // holds the message's first activity part (or in every group when the
  // message has none — the list then has nowhere else to live).
  const firstActivityIndex = messageParts.findIndex(isActivityPart);
  const isFirstGroup = firstActivityIndex === -1 || indices.includes(firstActivityIndex);
  const { activityFallbackMs, shellOutputs, taskList, toolActivity, toolDurations } =
    useChainActivityDerivations(messageParts, messageId, groupParts);
  const [collapsed, setCollapsed] = useState(true);
  const reasoningPanelId = useId();

  const body = (
    <ReasoningCollapsedContext.Provider value={collapsed}>{children}</ReasoningCollapsedContext.Provider>
  );

  return (
    <div className="bs-chain-of-thought mb-2 block max-w-2xl">
      {isFirstGroup && taskList ? <TodoProgress result={taskList} /> : null}
      <ToolDurationProvider durations={toolDurations}>
        <ShellOutputProvider outputs={shellOutputs}>
          <AssistantActivityGroup
            fallbackMs={activityFallbackMs}
            incompleteReason={
              incompleteReason as Parameters<typeof AssistantActivityGroup>[0]['incompleteReason']
            }
            isActive={isActivityActive}
            summary={toolActivity}
          >
            {hasReasoningParts ? (
              <ChainReasoningFold
                collapsed={collapsed}
                isReasoningRunning={isReasoningRunning}
                onToggle={() => setCollapsed((value) => !value)}
                panelId={reasoningPanelId}
              >
                {body}
              </ChainReasoningFold>
            ) : (
              body
            )}
          </AssistantActivityGroup>
        </ShellOutputProvider>
      </ToolDurationProvider>
    </div>
  );
}

/**
 * The assistant message's parts renderer. `indicator="never"` keeps the
 * streaming placeholder where it already lives (markdown-text.tsx renders the
 * thinking indicator for an empty running text part).
 */
export function AssistantActivityParts() {
  return (
    <MessagePrimitive.GroupedParts<ActivityGroupKey>
      groupBy={groupAssistantActivityPart}
      indicator="never"
    >
      {({ children, part }) => {
        switch (part.type) {
          case ACTIVITY_GROUP_KEY:
            return (
              <ActivityGroup indices={part.indices} status={part.status}>
                {children}
              </ActivityGroup>
            );
          case 'text':
            return <AssistantMessageText />;
          case 'reasoning':
            return (
              <ActivityPartLayout>
                <ActivityReasoningLeaf />
              </ActivityPartLayout>
            );
          case 'tool-call':
            return (
              <ActivityPartLayout>{part.toolUI ?? <ActivityToolPart {...part} />}</ActivityPartLayout>
            );
          case 'data':
            return part.dataRendererUI;
          default:
            return null;
        }
      }}
    </MessagePrimitive.GroupedParts>
  );
}

AssistantActivityParts.displayName = 'AssistantActivityParts';
```

Notes for the implementer:
- `incompleteReason` is cast to the prop's own union rather than widened: the group node's `status` is the library's `MessagePartStatus | ToolCallMessagePartStatus`, whose `incomplete.reason` set is the one `AssistantActivityGroup` already accepts. If `tsc` rejects the cast, replace it with a small narrowing function `toIncompleteReason(status)` that switches on the six literal reasons and returns `undefined` otherwise. Never `as never`.
- If `<ActivityToolPart {...part} />` fails typing on `status`, destructure `const { toolUI: _toolUI, ...toolProps } = part;` and spread `toolProps` — the library's own docs spread the leaf into `ToolFallback`, so this should not be needed.
- [ ] **Step 4b: Add the `live` prop to `BrainstrikeThinkingMark`** (the fold above passes `live={false}`)

In `packages/assistant-ui/src/assistant-thinking-indicator.tsx`:

```tsx
interface BrainstrikeThinkingMarkProps extends Omit<ComponentPropsWithoutRef<'svg'>, 'children'> {
  /**
   * False for the static (finished) rendering. Drives `data-live`, the one
   * selector the hydration-liveness invariant reads: `[data-live="true"]`
   * must be empty on a reloaded thread with nothing pending.
   */
  live?: boolean;
  testId?: string;
}
```
Destructure `live = true` in `BrainstrikeThinkingMark` and add `data-live={live ? 'true' : 'false'}` to its `<svg>`. `AssistantThinkingIndicator` passes nothing (its mark is live by default) and gets NO attribute of its own, so one indicator counts as exactly one live element.

- [ ] **Step 5: Point the reasoning-disclosure harness at the new module**

In `packages/assistant-ui/src/__tests__/assistant-reasoning-disclosure.behavior.test.tsx` replace

```tsx
import { LocalChainOfThought } from '../assistant-ui-panel';
```
with
```tsx
import { AssistantActivityParts } from '../assistant-activity-parts';
```
and replace the `AssistantMessage` component body

```tsx
                <MessagePrimitive.Root>
                  <MessagePrimitive.Parts
                    components={{
                      ChainOfThought: LocalChainOfThought,
                    }}
                  />
                </MessagePrimitive.Root>
```
with
```tsx
                <MessagePrimitive.Root>
                  <AssistantActivityParts />
                </MessagePrimitive.Root>
```

- [ ] **Step 6: Run the three suites**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-activity-timeline.behavior.test.tsx src/__tests__/assistant-reasoning-disclosure.behavior.test.tsx`
Expected: PASS, including the three new cases and all pre-existing ones (two groups with text between, Stopped only on the cancelled group, reasoning expansion surviving a tool call, hydrated parity).

Run: `pnpm vitest run --project browser src/__tests__/assistant-activity-timeline.browser.test.tsx`
Expected: PASS (geometry unchanged).

- [ ] **Step 7: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src
git add packages/assistant-ui/src/assistant-activity-parts.tsx packages/assistant-ui/src/__tests__/assistant-activity-timeline-fixtures.tsx packages/assistant-ui/src/__tests__/assistant-activity-timeline.behavior.test.tsx packages/assistant-ui/src/__tests__/assistant-reasoning-disclosure.behavior.test.tsx
git commit -m "feat(assistant-ui): render activity groups through MessagePrimitive.GroupedParts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Switch the panel over and delete the legacy path

**Files:**
- Modify: `packages/assistant-ui/src/assistant-ui-panel.tsx` (imports; `AssistantMessage` at ~1596–1640; delete lines ~447–657: `isRunningReasoningPart`, `HiddenReasoningPart`, `isReasoningPart`, `reasoningToggleLabel`, `ChainReasoningFold`, `isActivityPart`, `ActivityPartLayout`, `ActivityToolPart`, `LocalChainOfThought`)
- Create: `packages/assistant-ui/src/__tests__/assistant-activity-parts.test.tsx` (replaces five panel tests)
- Modify: `packages/assistant-ui/src/__tests__/assistant-ui-panel.test.tsx` (mock + delete the five chain-of-thought tests)
- Modify: `packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts` (~286–302)

**Interfaces:**
- Consumes: Task 2's `AssistantActivityParts`.
- Produces: the panel's `AssistantMessage` renders `<AssistantActivityParts />`; `LocalChainOfThought` no longer exists.

- [ ] **Step 1: Write the replacement tests for the five panel chain-of-thought cases (real runtime, no mocks)**

```tsx
// packages/assistant-ui/src/__tests__/assistant-activity-parts.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Harness } from './assistant-activity-timeline-fixtures';

const neverRun = {
  async run() {
    throw new Error('Hydration must not invoke a model.');
  },
};

const completedReasoning = { text: 'Reasoned.', type: 'reasoning' as const };

function tool(toolCallId: string, extra: Record<string, unknown> = {}) {
  return {
    args: {},
    argsText: '{}',
    result: { ok: true },
    toolCallId,
    toolName: `tool_${toolCallId}`,
    type: 'tool-call' as const,
    ...extra,
  };
}

describe('AssistantActivityParts (hydrated messages)', () => {
  it('renders completed reasoning with a static reasoning mark', async () => {
    render(
      <Harness adapter={neverRun} initialMessages={[{ content: [completedReasoning], role: 'assistant' }]} />
    );
    expect(await screen.findByTestId('assistant-reasoning-indicator')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('assistant-reasoning-static-mark')).toHaveClass('bs-thinking-mark-static');
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
  });

  it('summarizes the tool calls within one activity group', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [tool('a'), tool('b'), tool('c')], role: 'assistant' }]}
      />
    );
    expect(await screen.findByTestId('assistant-activity-group')).toBeInTheDocument();
    expect(screen.getByText(/3 steps/)).toBeInTheDocument();
    expect(screen.getAllByTestId('tool-fallback')).toHaveLength(3);
  });

  it('retains the activity wrapper for a completed single tool call', async () => {
    render(<Harness adapter={neverRun} initialMessages={[{ content: [tool('a')], role: 'assistant' }]} />);
    expect(await screen.findByTestId('assistant-activity-group')).toBeInTheDocument();
    expect(screen.getByTestId('tool-fallback')).toBeInTheDocument();
  });

  it('keeps the reasoning fold collapsed by default and hides the reasoning text', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [completedReasoning, tool('a')], role: 'assistant' }]}
      />
    );
    const fold = await screen.findByTestId('local-chain-of-thought');
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Reasoned.')).not.toBeInTheDocument();
  });

  it('renders text parts outside any activity group', async () => {
    render(
      <Harness
        adapter={neverRun}
        initialMessages={[{ content: [tool('a'), { text: 'Answer.', type: 'text' }], role: 'assistant' }]}
      />
    );
    const group = await screen.findByTestId('assistant-activity-group');
    expect(group).not.toHaveTextContent('Answer.');
    expect(screen.getByText('Answer.')).toBeInTheDocument();
  });
});
```

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-activity-parts.test.tsx`
Expected: PASS already (the module exists since Task 2). These tests are the replacement for the panel's mocked ones, written first so the deletion in Step 3 is covered.

- [ ] **Step 2: Switch the panel's `AssistantMessage`**

In `packages/assistant-ui/src/assistant-ui-panel.tsx` replace

```tsx
        {/* ChainOfThought takes control of ALL reasoning and tool-call parts
            (the library forbids a separate `tools` mapping alongside it), so
            tool rendering lives inside LocalChainOfThought. */}
        <MessagePrimitive.Parts
          components={{
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "ChainOfThought" key */
            ChainOfThought: LocalChainOfThought,
            /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
            Text: AssistantMessageText,
          }}
        />
```
with
```tsx
        {/* Grouped rendering (activity groups + text + data parts) lives in
            assistant-activity-parts.tsx; see its header for the grouping rule. */}
        <AssistantActivityParts />
```

Add `import { AssistantActivityParts } from './assistant-activity-parts';` and delete the now-unused imports: `AssistantActivityGroup`, `ChainOfThoughtPrimitive`, `useAui`, `ChevronDownIcon`/`ChevronUpIcon` (only if no other use remains — grep), `AssistantReasoningPart`, `CHAIN_OF_THOUGHT_TOOL_COMPONENTS` (keep `TodoProgress` only if still used elsewhere; otherwise drop both), `ToolDurationProvider`, `ShellOutputProvider`, `useChainActivityDerivations`, `BrainstrikeThinkingMark`/`AssistantThinkingIndicator` (keep any that other panel code still uses — grep each before removing). Keep `AssistantMessageText` (still used by the compaction card). Delete the function bodies listed in **Files** above.

- [ ] **Step 3: Update the panel unit tests**

In `packages/assistant-ui/src/__tests__/assistant-ui-panel.test.tsx`:
1. Delete the five tests that call `renderCapturedChainOfThought()` (`'renders completed chain-of-thought with a static reasoning mark'`, `'renders running chain-of-thought with the animated thinking indicator'` if present, `'keeps completed reasoning static while a chain tool call is running'`, `'summarizes the tool calls within the current activity group'`, `'retains the activity wrapper for a completed single tool call'`), the `renderCapturedChainOfThought` helper, and the `ChainOfThoughtPrimitive` entry of the `@assistant-ui/react` mock. Keep `messagePartsComponentsMock` if any remaining test reads it; otherwise delete it too.
2. Add a `GroupedParts` entry to the `MessagePrimitive` mock so the compaction/fallthrough tests still render text:

```tsx
      GroupedParts: ({
        children,
      }: {
        children: (info: { children: React.ReactNode; part: { type: string } }) => React.ReactNode;
      }) => (
        <>
          {mockAuiState.message.parts.map((part, index) => {
            const typed = part as { type?: string } | null;
            if (typed?.type !== 'text') {
              return null;
            }
            // biome-ignore lint/suspicious/noArrayIndexKey: stable part positions in the isolated primitive mock.
            return <Fragment key={index}>{children({ children: null, part: { type: 'text' } })}</Fragment>;
          })}
        </>
      ),
```
(add `Fragment` to the file's `react` import.)
3. Remove `chainOfThought` from `MockAuiState` and `createMockAuiState`, and the `setCollapsedMock` / `chainOfThought: () => ({ setCollapsed })` entry on the `useAui` mock (line ~349).

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-ui-panel.test.tsx`
Expected: PASS.

- [ ] **Step 4: Update the architecture invariants**

Replace the test `'renders assistant tool-call parts through the chain-of-thought tool fallback'` in `packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts` with:

```ts
  it('renders assistant parts through the grouped activity renderer, never the legacy ChainOfThought slot', () => {
    const source = readSource('assistant-ui-panel.tsx');
    const assistantMessageStart = source.indexOf('const AssistantMessage =');
    const assistantActionBarStart = source.indexOf('const AssistantActionBar =');
    const assistantMessageSource = source.slice(assistantMessageStart, assistantActionBarStart);

    expect(assistantMessageSource).toContain('<AssistantActivityParts />');
    expect(source).not.toContain('ChainOfThought: ');
    expect(source).not.toContain('ChainOfThoughtPrimitive');
    expect(source).not.toContain('LocalChainOfThought');

    const partsSource = readSource('assistant-activity-parts.tsx');
    expect(partsSource).toContain('MessagePrimitive.GroupedParts');
    expect(partsSource).toContain('groupBy={groupAssistantActivityPart}');
    expect(partsSource).toContain('CHAIN_OF_THOUGHT_TOOL_COMPONENTS.by_name[props.toolName]');
    expect(readSource('todo-progress.tsx')).toContain('Fallback: ToolFallback');
  });
```

The `'uses the shared thinking indicator instead of a bare streaming caret'` test asserts `panelSource` imports `./assistant-thinking-indicator`; if the panel no longer imports it after Step 2, change that assertion to read `assistant-activity-parts.tsx` instead. Lower the panel's line budget in the same file to the new line count (the budget is a ceiling that must only move down; read the constant near lines 12–100 and set it to the post-deletion count).

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-ui-panel-architecture.test.ts`
Expected: PASS.

- [ ] **Step 5: Whole-package gate**

Run: `pnpm --filter @brainstrike/assistant-ui type-check && cd packages/assistant-ui && pnpm test && pnpm test:browser`
Expected: all PASS. Known movers: `assistant-chat-polish.browser.test.tsx` renders `AssistantActivityGroup` directly (unaffected); `fast-refresh-hook-aliasing` and `assistant-ui-panel-architecture` are the only source-text tests.

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src
git add -A packages/assistant-ui/src
git commit -m "refactor(assistant-ui): panel renders AssistantActivityParts; delete LocalChainOfThought

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `data-live` on every live indicator, `data-state` on the group, reduced motion on the subagent pulse

**Files:**
- Modify: `packages/assistant-ui/src/assistant-thinking-indicator.tsx`
- Modify: `packages/assistant-ui/src/assistant-activity-group.tsx`
- Modify: `packages/assistant-ui/src/subagent-execution-card.tsx:58-71`
- Modify: `packages/assistant-ui/src/assistant-activity-parts.tsx` (the `live={false}` line from Task 2)
- Test: `packages/assistant-ui/src/__tests__/assistant-activity-group.test.tsx`, `packages/assistant-ui/src/__tests__/subagent-execution-card.test.tsx`

**Interfaces:**
- Produces: the DOM contract `[data-live="true"]` ⇔ an animated "still happening" indicator; `data-state="running" | "done"` on `[data-testid="assistant-activity-group"]`.

- [ ] **Step 1: Write the failing tests**

Append to `describe('AssistantActivityGroup', ...)` in `assistant-activity-group.test.tsx` (use the same `render`/`activeSummary`/`doneSummary` helpers that file already defines):

```tsx
  it('publishes data-state and marks only the live heartbeat as data-live', () => {
    const { container, rerender } = render(
      <AssistantActivityGroup isActive summary={activeSummary}>
        <div />
      </AssistantActivityGroup>
    );
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-state', 'running');
    expect(container.querySelectorAll('[data-live="true"]').length).toBeGreaterThan(0);
    rerender(
      <AssistantActivityGroup fallbackMs={1000} isActive={false} summary={doneSummary}>
        <div />
      </AssistantActivityGroup>
    );
    expect(screen.getByTestId('assistant-activity-group')).toHaveAttribute('data-state', 'done');
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
  });
```

Append to `describe('SubagentExecutionCard', ...)` in `subagent-execution-card.test.tsx`:

```tsx
  it('marks the running pulse data-live and respects reduced motion', () => {
    const { container } = renderCard({
      result: undefined,
      status: { type: 'running' },
      toolCallId: 'p1',
      toolName: 'agent-explorer',
    });
    const pulse = container.querySelector('[data-live="true"]');
    expect(pulse).not.toBeNull();
    expect(pulse).toHaveClass('motion-reduce:animate-none');
  });

  it('renders no data-live element once the delegation has a result', () => {
    const { container } = renderCard({
      result: completedResult,
      status: { type: 'complete' },
      toolCallId: 'p1',
      toolName: 'agent-explorer',
    });
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
  });
```

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-activity-group.test.tsx src/__tests__/subagent-execution-card.test.tsx`
Expected: FAIL on the three new tests.

- [ ] **Step 2: Implement**

`assistant-thinking-indicator.tsx` — the `live` prop already landed in Task 2 Step 4b; verify `AssistantThinkingIndicator` itself carries no `data-live` (one indicator = one live element, the mark).

`assistant-activity-group.tsx` — on the root `<div className="bs-activity-group">` add `data-state={isActive ? 'running' : 'done'}`. The `Working` label already renders `BrainstrikeThinkingMark` (live by default), so nothing else changes.

`subagent-execution-card.tsx` — both `CircleDashed` running icons become:

```tsx
    <CircleDashed
      aria-hidden="true"
      className="size-4 animate-pulse text-muted-foreground motion-reduce:animate-none"
      data-live="true"
    />
```
(and `size-3.5 shrink-0` for the row variant).

`assistant-activity-parts.tsx` — the static mark in `ChainReasoningFold` passes `live={false}` (already written in Task 2's code; confirm it is present).

- [ ] **Step 3: Run tests**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-activity-group.test.tsx src/__tests__/subagent-execution-card.test.tsx src/__tests__/assistant-activity-parts.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src
git add -A packages/assistant-ui/src
git commit -m "feat(assistant-ui): data-live on live indicators, data-state on activity groups, reduced-motion subagent pulse

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Interrupted rule for run-event rows

A `running` row whose owning message has settled (`complete` or `incomplete`) resolves to `interrupted`, unless a pending pause card for the same `toolCallId` exists anywhere in the thread (live approval, or a rediscovered pause re-appended on reload). An absent message status is left untouched: liveness is never guessed.

**Files:**
- Modify: `packages/assistant-ui/src/assistant-run-event-derivation.ts`
- Modify: `packages/assistant-ui/src/assistant-run-event-context.tsx`
- Modify: `packages/assistant-ui/src/assistant-run-timeline.tsx`
- Modify: `packages/assistant-ui/src/assistant-run-timeline-data-part.tsx`
- Test: `packages/assistant-ui/src/__tests__/assistant-run-timeline.test.tsx`

**Interfaces:**
- Produces: `export type AssistantRunEventDisplayStatus = AssistantRunEventStatus | 'interrupted'`; `AssistantRunEventRows.statuses: Record<string, AssistantRunEventDisplayStatus>`; `resolveAssistantRunEventStatus(...): AssistantRunEventDisplayStatus`; `AssistantRunTimeline` prop `statusOverride?: AssistantRunEventDisplayStatus`.
- Consumed by Task 7's invariant test.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` to `assistant-run-timeline.test.tsx` (reuse that file's `runEventPart` helper and `renderTimeline`):

```tsx
describe('interrupted rule (settled owner, no pending pause)', () => {
  const settled = { reason: 'stop', type: 'complete' } as const;
  const started = (id: string, toolCallId: string) => ({
    id,
    kind: 'tool.started',
    label: 'Tool started',
    metadata: { toolCallId },
    status: 'running',
    timestamp: '2026-09-07T00:00:00.000Z',
  });
  const approval = (id: string, toolCallId: string) => ({
    id,
    kind: 'tool.approval.requested',
    label: 'Awaiting your approval',
    metadata: { toolCallId, toolName: 'brainstrike.executeCommand' },
    runId: 'run-a',
    status: 'running',
    timestamp: '2026-09-07T00:00:00.000Z',
  });

  it('resolves an unpaired running row to interrupted when its message has settled', () => {
    const event = started('s1', 'call-1');
    const messages = [{ parts: [runEventPart(event)], role: 'assistant', status: settled }];
    expect(resolveAssistantRunEventStatus(messages, event as never)).toBe('interrupted');
    expect(deriveAssistantRunEventRows(messages).statuses[event.id]).toBe('interrupted');
  });

  it('leaves an unpaired running row running while its message is running or requires action', () => {
    const event = started('s1', 'call-1');
    for (const status of [{ type: 'running' }, { reason: 'interrupt', type: 'requires-action' }]) {
      const messages = [{ parts: [runEventPart(event)], role: 'assistant', status }];
      expect(resolveAssistantRunEventStatus(messages, event as never)).toBe('running');
      expect(deriveAssistantRunEventRows(messages).statuses[event.id]).toBe('running');
    }
  });

  it('never guesses: a message without a status leaves the row running', () => {
    const event = started('s1', 'call-1');
    const messages = [{ parts: [runEventPart(event)], role: 'assistant' }];
    expect(resolveAssistantRunEventStatus(messages, event as never)).toBe('running');
    expect(deriveAssistantRunEventRows(messages).statuses[event.id]).toBe('running');
  });

  it('keeps a settled pause row running while a pending pause card for that call exists (rediscovered on reload)', () => {
    const event = approval('a1', 'call-1');
    const messages = [
      { parts: [runEventPart(event)], role: 'assistant', status: settled },
      {
        parts: [
          {
            data: { runId: 'run-a', toolCallId: 'call-1', toolName: 'brainstrike.executeCommand' },
            name: 'brainstrike.tool-approval',
            type: 'data',
          },
        ],
        role: 'assistant',
        status: settled,
      },
    ];
    expect(resolveAssistantRunEventStatus(messages, event as never)).toBe('running');
    expect(deriveAssistantRunEventRows(messages).statuses[event.id]).toBe('running');
  });

  it('resolves an abandoned pause (settled, no card, no terminal) to interrupted', () => {
    const event = approval('a1', 'call-1');
    const messages = [{ parts: [runEventPart(event)], role: 'assistant', status: settled }];
    expect(resolveAssistantRunEventStatus(messages, event as never)).toBe('interrupted');
    expect(deriveAssistantRunEventRows(messages).statuses[event.id]).toBe('interrupted');
  });

  it('a pending pause card for ANOTHER call does not keep this pause alive', () => {
    const event = approval('a1', 'call-1');
    const messages = [
      { parts: [runEventPart(event)], role: 'assistant', status: settled },
      {
        parts: [
          {
            data: { runId: 'run-a', toolCallId: 'call-2', toolName: 'brainstrike.executeCommand' },
            name: 'brainstrike.tool-approval',
            type: 'data',
          },
        ],
        role: 'assistant',
        status: settled,
      },
    ];
    expect(resolveAssistantRunEventStatus(messages, event as never)).toBe('interrupted');
  });

  it('renders an interrupted row static, with the approval wording for a pause', () => {
    renderTimeline({ ...approval('a1', 'call-1') }, 'interrupted');
    expect(screen.getByLabelText('Interrupted')).toBeInTheDocument();
    expect(screen.getByText('Approval was pending')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-live="true"]')).toHaveLength(0);
  });
});
```

`renderTimeline` in that file takes `(data)`; extend its signature to `(data, statusOverride?)` and pass `statusOverride` through to `<AssistantRunTimeline statusOverride={statusOverride} />`.

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-run-timeline.test.tsx`
Expected: FAIL (interrupted never produced; `'Interrupted'` label missing).

- [ ] **Step 2: Implement the derivation**

In `assistant-run-event-derivation.ts`:

```ts
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { TOOL_SUSPEND_DATA_NAME } from '@brainstrike/assistant-contract/tool-suspend';

/**
 * Renderer-only status. `'interrupted'` is never persisted and never enters
 * the contract union: it is what a `running` row RESOLVES to when its owning
 * message has settled and nothing is still pending for it. A row is the
 * durable record; the message status is the renderer's liveness authority.
 */
export type AssistantRunEventDisplayStatus = AssistantRunEventStatus | 'interrupted';

export interface AssistantRunEventRows {
  readonly renderPlanKeys: Record<string, string>;
  readonly statuses: Record<string, AssistantRunEventDisplayStatus>;
}

/**
 * True when the message's OWN status says it is finished. Absent status is
 * NOT settled — hydrated and live messages always carry one, so an absence is
 * a caller shape we refuse to interpret rather than a signal.
 */
function isSettledMessage(message: unknown): boolean {
  if (!isRecord(message)) {
    return false;
  }
  const status = message['status'];
  if (!isRecord(status)) {
    return false;
  }
  return status['type'] === 'complete' || status['type'] === 'incomplete';
}

/**
 * `toolCallId`s that still have an actionable pause card in the thread — the
 * live approval/suspend notice, or the synthetic message
 * `appendSuspendedPauseMessages` re-appends for a pause that is STILL
 * suspended after a reload. A settled `tool.approval.requested` row for one
 * of these is genuinely pending, not interrupted.
 */
function collectPendingPauseToolCallIds(messages: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of getMessageParts(message)) {
      if (!isRecord(part) || part['type'] !== 'data') {
        continue;
      }
      const name = part['name'];
      if (name !== TOOL_APPROVAL_DATA_NAME && name !== TOOL_SUSPEND_DATA_NAME) {
        continue;
      }
      const data = part['data'];
      if (isRecord(data) && typeof data['toolCallId'] === 'string') {
        ids.add(data['toolCallId']);
      }
    }
  }
  return ids;
}

function applyInterruptedRule(
  event: AssistantRunEvent,
  resolved: AssistantRunEventStatus,
  ownerSettled: boolean,
  pendingPauseToolCallIds: ReadonlySet<string>
): AssistantRunEventDisplayStatus {
  if (resolved !== 'running' || !ownerSettled) {
    return resolved;
  }
  const toolCallId = event.metadata?.['toolCallId'];
  if (typeof toolCallId === 'string' && pendingPauseToolCallIds.has(toolCallId)) {
    return resolved;
  }
  return 'interrupted';
}
```

Change `collectIndexedRunEvents` to also return `ownerSettled: boolean[]` (index-aligned with `events`) by computing `const settled = isSettledMessage(message);` per message and pushing `settled` for each event found in it. In `deriveAssistantRunEventRows`, compute `const pendingPauseToolCallIds = collectPendingPauseToolCallIds(messages);` once, and change the assignment to:

```ts
    statuses[event.id] = applyInterruptedRule(
      event,
      statusByIndex[eventIndex] ?? event.status,
      ownerSettled[eventIndex] ?? false,
      pendingPauseToolCallIds
    );
```

In `resolveAssistantRunEventStatus`, change the return type to `AssistantRunEventDisplayStatus`, and wrap the existing result:

```ts
export function resolveAssistantRunEventStatus(
  messages: readonly unknown[],
  event: AssistantRunEvent | null
): AssistantRunEventDisplayStatus {
  if (!event) {
    return 'info';
  }
  const resolved = resolvePairedRunEventStatus(messages, event);
  return applyInterruptedRule(
    event,
    resolved,
    isOwnerSettled(messages, event.id),
    collectPendingPauseToolCallIds(messages)
  );
}
```
where `resolvePairedRunEventStatus` is the existing body renamed (returns `AssistantRunEventStatus`), and:

```ts
function isOwnerSettled(messages: readonly unknown[], eventId: string): boolean {
  for (const message of messages) {
    for (const part of getMessageParts(message)) {
      if (getRunEventFromPart(part)?.id === eventId) {
        return isSettledMessage(message);
      }
    }
  }
  return false;
}
```

`assistant-run-event-context.tsx`: import and use `AssistantRunEventDisplayStatus` for `statuses` and the hook's `status` return type.

`assistant-run-timeline-data-part.tsx`: no code change beyond the types flowing through (`statusOverride` accepts the display status).

`assistant-run-timeline.tsx`:

```ts
import { CircleSlash } from 'lucide-react'; // add to the existing lucide import
import type { AssistantRunEventDisplayStatus } from './assistant-run-event-derivation';

interface AssistantRunTimelineProps {
  data: unknown;
  repeatCount?: number;
  statusOverride?: AssistantRunEventDisplayStatus;
}

const STATUS_LABELS: Record<AssistantRunEventDisplayStatus, string> = {
  cancelled: 'Cancelled',
  completed: 'Completed',
  failed: 'Failed',
  info: 'Observed',
  interrupted: 'Interrupted',
  running: 'Running',
};
```
In `AssistantRunStatusIcon` (param type widened) add before the `running` branch:
```tsx
  if (status === 'interrupted') {
    return <CircleSlash className="size-3.5 text-muted-foreground" />;
  }
```
In `AssistantRunTimeline`, after `const eventStatus = ...`, derive the visible label:
```ts
  const label =
    eventStatus === 'interrupted' && event.kind === 'tool.approval.requested'
      ? 'Approval was pending'
      : event.label;
```
and render `{label}` where `{event.label}` was. `isRunning` stays `eventStatus === 'running'`, so an interrupted row renders no thinking indicator.

- [ ] **Step 3: Run the tests**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-run-timeline.test.tsx src/__tests__/assistant-run-event-pairing-contract.test.ts src/__tests__/assistant-run-timeline-data-part.test.tsx src/__tests__/assistant-run-timeline-panel.test.tsx`
Expected: PASS — every pre-existing pairing case still resolves identically (their fixtures carry no message status), plus the seven new cases.

- [ ] **Step 4: Mutate the guard**

Temporarily make `isSettledMessage` return `true` for a missing status → the "never guesses" test fails. Revert. Temporarily drop the `pendingPauseToolCallIds.has(...)` branch → the rediscovered-pause test fails. Revert.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src
git add -A packages/assistant-ui/src
git commit -m "feat(assistant-ui): resolve unpaired running run-event rows to interrupted once their message settles

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Interrupted subagent child rows

**Files:**
- Modify: `packages/assistant-ui/src/subagent-tool-rows.ts`
- Modify: `packages/assistant-ui/src/subagent-execution-card.tsx` (`ROW_ICONS`)
- Test: `packages/assistant-ui/src/__tests__/subagent-tool-rows.test.ts`, `packages/assistant-ui/src/__tests__/subagent-execution-card.test.tsx`

**Interfaces:**
- Produces: `SubAgentToolRowStatus = 'error' | 'interrupted' | 'running' | 'success'`; `readLiveSubagentToolRowsFromMessages` applies the settled-owner rule per message.

- [ ] **Step 1: Write the failing tests**

Append to `subagent-tool-rows.test.ts` (reuse that file's event-part helper; if it has none, build parts as `{ data: {...}, name: ASSISTANT_RUN_EVENT_DATA_NAME, type: 'data' }`):

```ts
describe('readLiveSubagentToolRowsFromMessages — interrupted rule', () => {
  const started = {
    data: {
      id: 'c-s',
      kind: 'subagent.tool.started',
      label: 'Subagent tool started',
      metadata: { childToolName: 'brainstrike_grepSearch', parentToolCallId: 'p1', toolCallId: 'c1' },
      status: 'running',
      timestamp: '2026-09-07T00:00:00.000Z',
    },
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    type: 'data',
  };

  it('marks a running child row interrupted when its message has settled', () => {
    const rows = readLiveSubagentToolRowsFromMessages(
      [{ parts: [started], status: { reason: 'stop', type: 'complete' } }],
      'p1'
    );
    expect(rows).toEqual([
      { argSummary: undefined, key: 'c1', status: 'interrupted', toolName: 'brainstrike_grepSearch' },
    ]);
  });

  it('keeps the row running while the message runs, and when the message carries no status', () => {
    for (const message of [{ parts: [started], status: { type: 'running' } }, { parts: [started] }]) {
      expect(readLiveSubagentToolRowsFromMessages([message], 'p1')[0]?.status).toBe('running');
    }
  });
});
```

Append to `describe('SubagentExecutionCard', ...)`:

```tsx
  it('renders an interrupted child row static and not data-live', () => {
    const { container } = renderCard({
      liveRows: [{ argSummary: undefined, key: 'c1', status: 'interrupted', toolName: 'brainstrike_grepSearch' }],
      result: undefined,
      status: { type: 'incomplete', reason: 'cancelled' },
      toolCallId: 'p1',
      toolName: 'agent-explorer',
    });
    fireEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByText('brainstrike_grepSearch')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(0);
  });
```

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/subagent-tool-rows.test.ts src/__tests__/subagent-execution-card.test.tsx`
Expected: FAIL.

- [ ] **Step 2: Implement**

`subagent-tool-rows.ts`:

```ts
export type SubAgentToolRowStatus = 'error' | 'interrupted' | 'running' | 'success';

interface MessageWithParts {
  readonly parts?: readonly unknown[];
  readonly status?: unknown;
}

function isSettledMessageStatus(status: unknown): boolean {
  return (
    isRecord(status) && (status['type'] === 'complete' || status['type'] === 'incomplete')
  );
}

export function readLiveSubagentToolRowsFromMessages(
  messages: readonly MessageWithParts[],
  parentToolCallId: string
): SubAgentToolRow[] {
  const byChild = new Map<string, SubAgentToolRow>();
  for (const message of messages) {
    if (!Array.isArray(message.parts)) {
      continue;
    }
    // Settled owner ⇒ a row still 'running' here has no terminal anywhere in
    // this message; it was interrupted (crash, kill, abandoned pause). Absent
    // status is left alone — liveness is never guessed.
    const settled = isSettledMessageStatus(message.status);
    for (const row of readLiveSubagentToolRows(message.parts, parentToolCallId)) {
      byChild.set(row.key, settled && row.status === 'running' ? { ...row, status: 'interrupted' } : row);
    }
  }
  return Array.from(byChild.values());
}
```
(The previous implementation concatenated every message's parts before deriving; deriving per message and merging by key keeps "later event supersedes earlier" because messages are iterated in thread order and `Map.set` overwrites.)

`subagent-execution-card.tsx` — add to `ROW_ICONS`:

```tsx
  interrupted: (
    <CircleSlash aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
  ),
```
(import `CircleSlash` from `lucide-react`).

- [ ] **Step 3: Run tests**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/subagent-tool-rows.test.ts src/__tests__/subagent-execution-card.test.tsx src/__tests__/subagent-tool-cards.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src
git add -A packages/assistant-ui/src
git commit -m "feat(assistant-ui): interrupted subagent child rows once the owning message settles

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Hydration liveness invariant

One test file that renders hydrated threads in the shapes the persistence layer actually produces and asserts `[data-live="true"]` is empty, except for the one legitimate pending case.

**Files:**
- Create: `packages/assistant-ui/src/__tests__/assistant-hydration-liveness.test.tsx`

**Interfaces:**
- Consumes: `Harness`, `runEventPart`, `completedPartsWithEvents` (Task 2 fixtures); `AssistantRunTimelineDataPart`, `AssistantRunEventProvider`, `AssistantDetailLevelProvider`, `ASSISTANT_DETAIL_LEVEL_STORAGE_KEY`, `useAssistantDataUI`, `ASSISTANT_RUN_EVENT_DATA_NAME`, `TOOL_APPROVAL_DATA_NAME`, `AssistantToolApprovalNotice`.

- [ ] **Step 1: Write the test**

```tsx
// packages/assistant-ui/src/__tests__/assistant-hydration-liveness.test.tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { type ChatModelAdapter, type ThreadMessageLike, useAssistantDataUI } from '@assistant-ui/react';
import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { TOOL_APPROVAL_DATA_NAME } from '@brainstrike/assistant-contract/tool-approval';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, AssistantDetailLevelProvider } from '../assistant-detail-level-context';
import { AssistantRunEventProvider } from '../assistant-run-event-context';
import { AssistantRunTimelineDataPart } from '../assistant-run-timeline-data-part';
import { AssistantToolApprovalNotice } from '../assistant-tool-approval-notice';
import { completedPartsWithEvents, Harness, runEventPart } from './assistant-activity-timeline-fixtures';

const neverRun: ChatModelAdapter = {
  async run() {
    throw new Error('Hydration must not invoke a model.');
  },
};
const settled = { reason: 'stop', type: 'complete' } as const;
const cancelled = { reason: 'cancelled', type: 'incomplete' } as const;
const T = (s: number) => `2026-09-07T00:00:${String(s).padStart(2, '0')}.000Z`;

/** Registers the two data UIs the real panel registers, so rows can render. */
function DataUis() {
  useAssistantDataUI({ name: ASSISTANT_RUN_EVENT_DATA_NAME, render: AssistantRunTimelineDataPart });
  useAssistantDataUI({
    name: TOOL_APPROVAL_DATA_NAME,
    render: ({ data }) => <AssistantToolApprovalNotice data={data} />,
  });
  return null;
}

function renderHydrated(messages: ThreadMessageLike[], detail: 'standard' | 'developer' = 'standard') {
  window.localStorage.setItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY, detail);
  return render(
    <AssistantDetailLevelProvider>
      <AssistantRunEventProvider>
        <DataUis />
        <Harness adapter={neverRun} initialMessages={messages} />
      </AssistantRunEventProvider>
    </AssistantDetailLevelProvider>
  );
}

const live = (container: HTMLElement) => container.querySelectorAll('[data-live="true"]');

afterEach(() => {
  window.localStorage.clear();
});

describe('hydrated threads render no live indicator unless something is genuinely pending', () => {
  it('completed turn with every call fenced by run events', async () => {
    const { container } = renderHydrated([
      { content: completedPartsWithEvents, role: 'assistant', status: settled },
    ]);
    await screen.findByText('Review complete.');
    expect(live(container)).toHaveLength(0);
  });

  it('killed turn: run.started and run.step.started never got a terminal (developer detail shows the rows)', async () => {
    // No run.cancelled / run.failed was ever written (renderer killed mid-run),
    // so the pairing has nothing to close these rows with: only the settled
    // owner message can stop them spinning.
    const content = [
      runEventPart({ id: 'r', kind: 'run.started', status: 'running', timestamp: T(0) }),
      runEventPart({ id: 'st', kind: 'run.step.started', status: 'running', timestamp: T(1) }),
      { args: {}, argsText: '{}', result: { ok: true }, toolCallId: 'x', toolName: 'brainstrike.executeCommand', type: 'tool-call' as const },
    ];
    const { container } = renderHydrated([{ content, role: 'assistant', status: cancelled }], 'developer');
    await screen.findByTestId('assistant-activity-group');
    expect(screen.getAllByLabelText('Interrupted').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Running')).not.toBeInTheDocument();
    expect(live(container)).toHaveLength(0);
    expect(screen.getByText('Stopped')).toBeInTheDocument();
  });

  it('an always-visible run event renders as a standalone row, never inside a collapsed group', async () => {
    const content = [
      ...completedPartsWithEvents,
      runEventPart({ id: 'c', kind: 'run.cancelled', status: 'cancelled', timestamp: T(30) }),
    ];
    renderHydrated([{ content, role: 'assistant', status: cancelled }]);
    const row = await screen.findByTestId('assistant-run-timeline');
    expect(row).toHaveTextContent('run.cancelled');
    for (const group of screen.getAllByTestId('assistant-activity-group')) {
      expect(group.contains(row)).toBe(false);
    }
  });

  it('approval answered on a second leg (pause in message A, terminal in message B)', async () => {
    const pause = runEventPart({ id: 'p', kind: 'tool.approval.requested', runId: 'run-a', status: 'running', timestamp: T(0), toolCallId: 'x' });
    const done = runEventPart({ id: 'd', kind: 'tool.completed', runId: 'run-b', timestamp: T(5), toolCallId: 'x' });
    const { container } = renderHydrated([
      { content: [{ args: {}, argsText: '{}', toolCallId: 'x', toolName: 'brainstrike.executeCommand', type: 'tool-call' as const }, pause], role: 'assistant', status: settled },
      { content: [done, { text: 'Ran it.', type: 'text' as const }], role: 'assistant', status: settled },
    ]);
    await screen.findByText('Ran it.');
    expect(live(container)).toHaveLength(0);
  });

  it('abandoned approval: settled message, no card, no terminal → interrupted, not live', async () => {
    const pause = runEventPart({ id: 'p', kind: 'tool.approval.requested', runId: 'run-a', status: 'running', timestamp: T(0), toolCallId: 'x' });
    const { container } = renderHydrated([
      { content: [{ args: {}, argsText: '{}', toolCallId: 'x', toolName: 'brainstrike.executeCommand', type: 'tool-call' as const }, pause], role: 'assistant', status: settled },
    ]);
    expect(await screen.findByText('Approval was pending')).toBeInTheDocument();
    expect(live(container)).toHaveLength(0);
  });

  it('rediscovered still-suspended approval: the pause row and its card stay actionable', async () => {
    const pause = runEventPart({ id: 'p', kind: 'tool.approval.requested', runId: 'run-a', status: 'running', timestamp: T(0), toolCallId: 'x' });
    const { container } = renderHydrated([
      { content: [{ args: {}, argsText: '{}', toolCallId: 'x', toolName: 'brainstrike.executeCommand', type: 'tool-call' as const }, pause], role: 'assistant', status: settled },
      {
        content: [{ data: { runId: 'run-a', stale: false, suspendedAt: T(0), toolCallId: 'x', toolName: 'brainstrike.executeCommand' }, name: TOOL_APPROVAL_DATA_NAME, type: 'data' as const }],
        id: 'suspended-approval:run-a:x',
        role: 'assistant',
        status: settled,
      },
    ]);
    expect(await screen.findByText('Awaiting your approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve brainstrike.executeCommand' })).toBeEnabled();
    // The ONE legitimate live element on a reloaded thread: the pending pause row.
    expect(live(container)).toHaveLength(1);
  });

  it('interrupted subagent delegation: child rows are static', async () => {
    const childStarted = {
      data: {
        id: 'cs',
        kind: 'subagent.tool.started',
        label: 'Subagent tool started',
        metadata: { childToolName: 'brainstrike_grepSearch', parentToolCallId: 'p1', toolCallId: 'c1' },
        status: 'running',
        timestamp: T(1),
      },
      name: ASSISTANT_RUN_EVENT_DATA_NAME,
      type: 'data' as const,
    };
    const { container } = renderHydrated([
      {
        content: [
          { args: { task: 'explore' }, argsText: '{"task":"explore"}', toolCallId: 'p1', toolName: 'agent-explorer', type: 'tool-call' as const },
          childStarted,
        ],
        role: 'assistant',
        status: cancelled,
      },
    ]);
    await screen.findByTestId('assistant-activity-group');
    expect(live(container)).toHaveLength(0);
  });

  it('a LIVE run that finishes ends with no live indicator (parity with hydration)', async () => {
    const finish = { release: () => {} };
    const adapter: ChatModelAdapter = {
      async *run() {
        yield { content: completedPartsWithEvents.slice(0, 9) };
        await new Promise<void>((resolve) => {
          finish.release = resolve;
        });
        yield { content: completedPartsWithEvents };
      },
    };
    const user = userEvent.setup();
    const { container } = render(
      <AssistantDetailLevelProvider>
        <AssistantRunEventProvider>
          <DataUis />
          <Harness adapter={adapter} />
        </AssistantRunEventProvider>
      </AssistantDetailLevelProvider>
    );
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'go');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('I found the issue.');
    expect(live(container).length).toBeGreaterThan(0);
    await act(async () => {
      finish.release();
    });
    await screen.findByText('Review complete.');
    await waitFor(() => expect(live(container)).toHaveLength(0));
  }, 20_000);
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-hydration-liveness.test.tsx`
Expected: PASS. If the "approval answered on a second leg" case shows a live row, the pause is not being hidden by the cross-run pairing — check the `runId` values on the two fixtures match the BST-1402 test shape (`run-a` pause, `run-b` terminal). If the rediscovered case shows two live elements, the approval notice itself rendered a mark — it must not (its "Pending" pill is static); fix the notice, not the assertion.

- [ ] **Step 3: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src/__tests__/assistant-hydration-liveness.test.tsx
git add packages/assistant-ui/src/__tests__/assistant-hydration-liveness.test.tsx
git commit -m "test(assistant-ui): hydrated threads render no live indicator unless a pause is pending

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Contract docs and spec amendment

**Files:**
- Modify: `docs/agents/assistant-runtime.md` (the paragraph starting "The reasoning disclosure renders live reasoning text directly from" at ~1264 through "The turn-wide task list renders once in the first group." at ~1286)
- Modify: `docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md` §4.1 table

- [ ] **Step 1: Rewrite the runtime contract paragraph**

Replace the paragraph with:

```markdown
## ACTIVITY GROUPS (BST-1656, re-based on `MessagePrimitive.GroupedParts`)

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

Chronology rulings (unchanged): each contiguous group renders at its own
position; never hoist later parts into an earlier group or suppress later
groups. Group status is the library's `GroupPart.status` (running if any part
runs, else the last part's). The reasoning disclosure renders live reasoning
text directly from `useMessagePartReasoning`, never through the text-part
renderer; its collapsed state is per-group wrapper state (the library's
`chainOfThought` scope does not exist on this path), so user expansion survives
intervening tool calls. Reasoning-only groups omit the step count. Incomplete
group status is authoritative (cancelled → Stopped; other reasons → Activity
failed); a completed call with `isError` marks its group failed, counted once.
Tool durations and shell output correlate by call id across the message; each
group's elapsed fallback uses only its own tool events. The turn-wide task list
renders once, in the group holding the message's first activity part.

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
rows follow the same rule (`readLiveSubagentToolRowsFromMessages`).
```

- [ ] **Step 2: Amend the spec's §4.1 table**

Change the `tool-call` row note to: "MCP-app calls stay inside the group in phase 1 (result-shape detection cannot classify a call before its result lands; moving standalone needs a call-start marker — deferred)." Change the `data brainstrike.run-event` row to: "Group-transparent, EXCEPT always-visible kinds (`isAlwaysVisibleRunEvent`), which stay standalone so a collapsed group cannot hide them; they occur at run start, at a pause, or at run end, so they never fragment a run's tool calls." Replace the sentence beginning "A `group-activity` node containing no reasoning and no tool call" with "Always-visible event rows render standalone; an activity group therefore always contains at least one reasoning or tool-call part."

- [ ] **Step 3: Commit**

```bash
git add docs/agents/assistant-runtime.md docs/superpowers/specs/2026-09-07-assistant-activity-trace-design.md
git commit -m "docs(agents): activity groups on GroupedParts and the hydration-liveness rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Full gates, e2e, and live CDT verification

**Files:** none new. Screenshots go to `e2e-artifacts/` (gitignored) and are attached to the PR.

- [ ] **Step 1: Package and repo gates**

```bash
pnpm --filter @brainstrike/assistant-ui type-check
cd packages/assistant-ui && pnpm test && pnpm test:browser && cd ../..
pnpm run lint
pnpm run react-doctor
```
Expected: all green. `react-doctor` must report no NEW error-severity issue in `assistant-activity-parts.tsx`.

- [ ] **Step 2: Desktop e2e that pin the group contract**

```bash
cd apps/desktop && pnpm test:e2e e2e/assistant-tool-card-visuals.desktop.test.ts e2e/assistant-retrieval.desktop.test.ts e2e/assistant-approval-reload-linearity.desktop.test.ts e2e/assistant-network-decision.desktop.test.ts --project=regression
```
Expected: PASS unchanged — the mock harness emits run-event `aui-data` parts, so these specs now exercise the real grouping. `mcp-packaged-core` runs in its packaged lane (`pnpm test:e2e:lane:packaged-mcp-core`) — run it if the packaged build is available locally; otherwise rely on CI.

- [ ] **Step 3: Web e2e**

```bash
pnpm build:web && cd apps/web && pnpm exec playwright test e2e/assistant-ui-panel.test.ts --grep "keeps streamed tool details collapsed"
```
Expected: PASS (never run web e2e against a stale dist).

- [ ] **Step 4: Live CDT verification (definition of done)**

Follow the hosted-mock recipe (`BRAINSTRIKE_AGENT_DEVTOOLS=1 pnpm --filter @brainstrike/desktop dev:agent-debug`, override ports if the main checkout owns 38181, configure the provider via the e2e helper, patch `fetch` with a mocked stream carrying the two `X-Brainstrike` headers and `aui-data` run events around three tool calls). Capture and attach:
1. Mid-run: ONE group, `Working` shimmer with the current tool name, ticking elapsed.
2. Finished: ONE group reading `Worked for Ns · 3 steps`, collapsed.
3. Expanded: three tool cards inside the one group.
4. Reload the thread: identical resting group; `document.querySelectorAll('[data-live="true"]').length === 0` evaluated over CDP and pasted into the PR.
5. A thread with an abandoned approval from before this change: the row reads `Approval was pending` with a static glyph.

- [ ] **Step 5: Open the PR**

File the BST ticket first per `docs/agents/issue-tracker.md` (title "Activity groups on GroupedParts + hydration liveness rule (phase 1)"), then branch from `origin/main` as `feat/bst-<ticket-number>-activity-grouping-liveness`. PR body: the root cause (library grouper vs run-event data parts), the two rules, the screenshots, and the note that phases 2–3 follow in separate PRs.
