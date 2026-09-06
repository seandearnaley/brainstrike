import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  ComposerPrimitive,
  MessagePrimitive,
  type ThreadMessageLike,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react';
import { TooltipProvider } from '@brainstrike/ui';
import { LocalChainOfThought } from '../assistant-ui-panel';

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
                  <MessagePrimitive.Parts components={{ ChainOfThought: LocalChainOfThought }} />
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
