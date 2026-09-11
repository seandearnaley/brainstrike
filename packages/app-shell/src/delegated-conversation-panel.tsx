import {
  AssistantConversationPanel,
  type AssistantConversationPanelProps,
  ConversationExecutionControls,
  type DelegatedConversationRuntimeOptions,
  useDelegatedConversationRuntime,
} from '@brainstrike/assistant-ui';
import { useSyncExternalStore } from 'react';
import type { DelegatedConversationStore } from './delegated-conversation-store';

export interface DelegatedConversationPanelProps {
  readonly label: string;
  readonly onCancel?: () => Promise<void>;
  readonly onNew: DelegatedConversationRuntimeOptions['onNew'];
  readonly panelProps?: Omit<
    AssistantConversationPanelProps,
    'runtime' | 'threadKey' | 'label' | 'isComposerDisabled'
  >;
  readonly persistedHistory?: DelegatedConversationRuntimeOptions['history'];
  readonly store: DelegatedConversationStore;
  readonly threadId: string;
}

/** A view of the host's child, never a second model or transcript writer. */
export function DelegatedConversationPanel({
  label,
  onNew,
  onCancel,
  panelProps,
  persistedHistory,
  store,
  threadId,
}: DelegatedConversationPanelProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.getConversation(threadId),
    () => store.getConversation(threadId)
  );
  const history = snapshot?.history ?? persistedHistory;
  if (!history) {
    throw new Error('The child conversation has no host-owned transcript.');
  }
  const runtime = useDelegatedConversationRuntime({
    history,
    onNew,
    ...(snapshot ? { update: snapshot.update } : {}),
  });
  return (
    <AssistantConversationPanel
      {...panelProps}
      hideDefaultCancel={Boolean(onCancel)}
      isComposerDisabled
      label={label}
      runtime={runtime}
      threadKey={threadId}
      {...(onCancel
        ? {
            workspaceBar: (
              <>
                {panelProps?.workspaceBar}
                <ConversationExecutionControls onCancel={onCancel} />
              </>
            ),
          }
        : {})}
    />
  );
}
