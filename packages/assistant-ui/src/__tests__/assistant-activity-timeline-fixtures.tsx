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

// `noUncheckedIndexedAccess` types `firstParts[n]` / `secondTools[n]` as
// possibly undefined; destructure once here (the arrays are fixed-length
// literals, so this is a real narrowing, not a cast around a bug).
const [firstReasoning, firstTool, firstText] = firstParts as [
  (typeof firstParts)[0],
  (typeof firstParts)[1],
  (typeof firstParts)[2],
];
const [commentsTool, relationsTool] = secondTools as [
  (typeof secondTools)[0],
  (typeof secondTools)[1],
];

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
