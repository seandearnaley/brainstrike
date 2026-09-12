import {
  AssistantConversationPanel,
  type AssistantConversationPanelProps,
  ConversationExecutionControls,
  type DelegatedConversationRuntimeOptions,
  useDelegatedConversationRuntime,
} from '@brainstrike/assistant-ui';
import { useMemo, useSyncExternalStore } from 'react';
import type { DelegatedConversationStore } from './delegated-conversation-store';

export interface DelegatedConversationPanelProps {
  readonly label: string;
  readonly onCancel?: () => Promise<void>;
  readonly onNew: DelegatedConversationRuntimeOptions['onNew'];
  readonly onSendActiveInput?: AssistantConversationPanelProps['onSendActiveInput'];
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
  onSendActiveInput,
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
  const history = useMemo(() => {
    const current = snapshot?.history;
    if (!(current && persistedHistory)) {
      return current ?? persistedHistory;
    }
    // A search read may extend the retained baseline backwards. Keep the host's
    // latest rows and head, including live decisions; use loaded durable edges
    // only to reconnect a baseline row whose parent was outside its old window.
    const loadedById = new Map(persistedHistory.messages.map((row) => [row.message.id, row]));
    const currentIds = new Set(current.messages.map((row) => row.message.id));
    return {
      ...current,
      messages: [
        ...persistedHistory.messages.filter((row) => !currentIds.has(row.message.id)),
        ...current.messages.map((row) => ({
          ...row,
          parentId: row.parentId ?? loadedById.get(row.message.id)?.parentId ?? null,
        })),
      ],
    };
  }, [snapshot?.history, persistedHistory]);
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
      isComposerDisabled={!onSendActiveInput || snapshot?.update.message.status.type !== 'running'}
      label={label}
      onSendActiveInput={onSendActiveInput}
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
