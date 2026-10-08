import {
  type ExportedMessageRepository,
  type ThreadMessage,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import type { ReactElement } from 'react';
import { AssistantConversationPanel } from './assistant-conversation-panel';

const READ_ONLY_REASON = 'Read-only conversation';

function refuseSend(): Promise<void> {
  return Promise.reject(new Error('This conversation is read-only.'));
}

/**
 * A converted conversation on the committed surface with no command ports:
 * nothing can send, edit, regenerate, branch or answer from it.
 */
export function ReadOnlyAssistantConversation({
  history,
  label,
  notice,
  threadKey,
}: {
  readonly history: ExportedMessageRepository;
  readonly label: string;
  readonly notice: ReactElement;
  readonly threadKey: string;
}): ReactElement {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    isDisabled: true,
    isSendDisabled: true,
    messageRepository: history,
    onNew: refuseSend,
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      {notice}
      <AssistantConversationPanel
        className="min-h-0 flex-1"
        disabledReason={READ_ONLY_REASON}
        isComposerDisabled
        label={label}
        runtime={runtime}
        threadKey={threadKey}
      />
    </div>
  );
}
