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
import type { ReactNode } from 'react';
import { AssistantActivityParts } from '../assistant-activity-parts';

// Named individually so `completedPartsWithEvents` below can splice the SAME
// part objects between run events without re-deriving them via a tuple cast
// on `firstParts`/`secondTools` — declaring them first and composing the
// arrays from them is the one source of truth.
const firstReasoning = { text: 'First reasoning segment.', type: 'reasoning' as const };
const firstTool = {
  args: {},
  argsText: '{}',
  result: { id: 'BST-1656' },
  toolCallId: 'first',
  toolName: 'linear.get_issue',
  type: 'tool-call' as const,
};
const firstText = { text: 'I found the issue.', type: 'text' as const };
export const firstParts = [firstReasoning, firstTool, firstText];

export const secondReasoning = { text: 'Second reasoning segment.', type: 'reasoning' as const };
/**
 * The second group's first call, still RESULTLESS — the live mid-run shape a
 * test appends after `completedPartsWithEvents.slice(0, 8)` (which ends at its
 * `tool.started` event) to hold the turn with that call running.
 */
export const commentsTool = {
  args: {},
  argsText: '{}',
  toolCallId: 'comments',
  toolName: 'linear.list_comments',
  type: 'tool-call' as const,
};
const relationsTool = {
  args: {},
  argsText: '{}',
  toolCallId: 'relations',
  toolName: 'linear.list_relations',
  type: 'tool-call' as const,
};
export const secondTools = [commentsTool, relationsTool];

export const completedParts = [
  ...firstParts,
  secondReasoning,
  ...secondTools.map((tool) => ({ ...tool, result: { items: [] } })),
  { text: 'Review complete.', type: 'text' as const },
];

/**
 * The shape `runEventPart` builds: a `brainstrike.run-event` data part whose
 * `data` matches what the live decoder (`aui-data` → `part-start`) and reload
 * hydration (`toRunEventDataParts`) both produce. `kind` stays plain `string`
 * (callers pass event-kind literals, but `AssistantRunEventKind` is narrower
 * than what this fixture needs to declare), so this is a standalone type
 * rather than `AssistantRunEvent` itself.
 */
interface RunEventPartFixture {
  readonly data: {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly metadata?: { readonly toolCallId: string };
    readonly runId?: string;
    readonly status: 'cancelled' | 'completed' | 'failed' | 'info' | 'running';
    readonly timestamp: string;
  };
  readonly name: typeof ASSISTANT_RUN_EVENT_DATA_NAME;
  readonly type: 'data';
}

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
}): RunEventPartFixture {
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
  runEventPart({
    id: 'e-run',
    kind: 'run.started',
    status: 'running',
    timestamp: '2026-09-05T10:00:00.000Z',
  }),
  firstReasoning,
  runEventPart({
    id: 'e-first-s',
    kind: 'tool.started',
    status: 'running',
    timestamp: '2026-09-05T10:00:01.000Z',
    toolCallId: 'first',
  }),
  firstTool,
  runEventPart({
    id: 'e-first-c',
    kind: 'tool.completed',
    timestamp: '2026-09-05T10:00:03.000Z',
    toolCallId: 'first',
  }),
  firstText,
  secondReasoning,
  runEventPart({
    id: 'e-comments-s',
    kind: 'tool.started',
    status: 'running',
    timestamp: '2026-09-05T10:00:10.000Z',
    toolCallId: 'comments',
  }),
  { ...commentsTool, result: { items: [] } },
  runEventPart({
    id: 'e-comments-c',
    kind: 'tool.completed',
    timestamp: '2026-09-05T10:00:12.000Z',
    toolCallId: 'comments',
  }),
  runEventPart({
    id: 'e-relations-s',
    kind: 'tool.started',
    status: 'running',
    timestamp: '2026-09-05T10:00:12.000Z',
    toolCallId: 'relations',
  }),
  { ...relationsTool, result: { items: [] } },
  runEventPart({
    id: 'e-relations-c',
    kind: 'tool.completed',
    timestamp: '2026-09-05T10:00:14.000Z',
    toolCallId: 'relations',
  }),
  runEventPart({ id: 'e-step', kind: 'run.step.finished', timestamp: '2026-09-05T10:00:14.000Z' }),
  { text: 'Review complete.', type: 'text' as const },
];

export function Harness({
  adapter,
  children,
  initialMessages = [],
}: {
  adapter: ChatModelAdapter;
  /**
   * Optional wrapper for the thread content, rendered inside
   * `AssistantRuntimeProvider`. Needed by tests that register a data UI
   * (`useAssistantDataUI`) or read Aui state (`AssistantRunEventProvider`) —
   * both require an `AssistantRuntimeProvider` ancestor, which only `Harness`
   * owns. Defaults to rendering the thread content unwrapped.
   */
  children?: (content: ReactNode) => ReactNode;
  initialMessages?: ThreadMessageLike[];
}) {
  const runtime = useLocalRuntime(adapter, { initialMessages });
  const content = (
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
  );
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={runtime}>
        {children ? children(content) : content}
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}
