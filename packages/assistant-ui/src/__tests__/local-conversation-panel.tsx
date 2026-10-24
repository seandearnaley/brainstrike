import {
  type ChatModelAdapter,
  type ThreadHistoryAdapter,
  useLocalRuntime,
} from '@assistant-ui/react';
import {
  AssistantConversationPanel,
  type AssistantConversationPanelProps,
} from '../assistant-conversation-panel';

/**
 * The live thread surface (`CommittedAssistantConversation` renders it) over a
 * real in-memory assistant-ui runtime, so composer behaviour runs against the
 * library's actual composer state.
 */
export function LocalConversationPanel({
  adapter,
  history,
  threadKey = 'thread-1',
  ...props
}: Omit<AssistantConversationPanelProps, 'label' | 'runtime' | 'threadKey'> & {
  readonly adapter: ChatModelAdapter;
  readonly history?: ThreadHistoryAdapter | undefined;
  readonly threadKey?: string;
}) {
  const runtime = useLocalRuntime(adapter, history ? { adapters: { history } } : {});
  return (
    <AssistantConversationPanel
      label="Assistant chat"
      runtime={runtime}
      threadKey={threadKey}
      {...props}
    />
  );
}
