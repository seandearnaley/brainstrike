import { type ChatModelAdapter, useLocalRuntime } from '@assistant-ui/react';
import {
  AssistantConversationPanel,
  type AssistantConversationPanelProps,
} from '../assistant-conversation-panel';

const NOOP_ADAPTER: ChatModelAdapter = {
  // Suites that never submit never iterate this.
  async *run() {
    yield { content: [] };
  },
};

/** The live thread surface over a real local runtime, so composer machinery runs unmocked. */
export function LocalConversationPanel({
  adapter = NOOP_ADAPTER,
  ...props
}: Omit<AssistantConversationPanelProps, 'label' | 'runtime' | 'threadKey'> & {
  readonly adapter?: ChatModelAdapter;
}) {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantConversationPanel
      label="Assistant chat"
      runtime={runtime}
      threadKey="thread"
      {...props}
    />
  );
}
