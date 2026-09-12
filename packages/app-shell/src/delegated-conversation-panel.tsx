import { NATIVE_MESSAGE_IDS_METADATA_KEY } from '@brainstrike/assistant-contract';
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
  readonly allowIdleInput?: boolean;

  readonly extendHistoryForSearch?: boolean;
  readonly label: string;
  readonly onBranch?: DelegatedConversationRuntimeOptions['onBranch'];
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
  allowIdleInput = false,
  onNew,
  onBranch,
  onCancel,
  onSendActiveInput,
  panelProps,
  persistedHistory,
  extendHistoryForSearch = false,
  store,
  threadId,
}: DelegatedConversationPanelProps) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.getConversation(threadId),
    () => store.getConversation(threadId)
  );
  const loadedById = useMemo(() => {
    const rows = new Map<string, HistoryRow>();
    for (const row of persistedHistory?.messages ?? []) {
      for (const id of nativeIds(row)) {
        rows.set(id, row);
      }
    }
    return rows;
  }, [persistedHistory]);
  const history = useMemo(() => {
    const current = snapshot?.history;
    if (!(current && persistedHistory && extendHistoryForSearch)) {
      return current ?? persistedHistory;
    }
    return extendChildSearchHistory(current, persistedHistory, loadedById);
  }, [snapshot?.history, persistedHistory, loadedById, extendHistoryForSearch]);
  if (!history) {
    throw new Error('The child conversation has no host-owned transcript.');
  }
  const runtime = useDelegatedConversationRuntime({
    attachmentsPresent: panelProps?.attachmentsAvailability !== undefined,
    history,
    onNew,
    ...(onBranch ? { onBranch } : {}),
    ...(snapshot ? { update: snapshot.update } : {}),
  });
  return (
    <AssistantConversationPanel
      {...panelProps}
      allowIdleInput={allowIdleInput}
      hideDefaultCancel={Boolean(onCancel)}
      isComposerDisabled={
        !onSendActiveInput ||
        (!allowIdleInput && snapshot?.update.message.status.type !== 'running')
      }
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

type History = DelegatedConversationRuntimeOptions['history'];
type HistoryRow = History['messages'][number];
function nativeIds(row: HistoryRow): readonly string[] {
  const values = row.message.metadata?.custom?.[NATIVE_MESSAGE_IDS_METADATA_KEY];
  return [
    row.message.id,
    ...(Array.isArray(values)
      ? values.filter((value): value is string => typeof value === 'string')
      : []),
  ];
}

/** Extend only backwards; the host remains authoritative for overlapping groups and its head. */
function extendChildSearchHistory(
  current: History,
  loaded: History,
  loadedById: ReadonlyMap<string, HistoryRow>
): History {
  const currentIds = new Set(current.messages.flatMap(nativeIds));
  const firstTime = Math.min(
    ...current.messages.map((row) => row.message.createdAt?.getTime() ?? Number.POSITIVE_INFINITY)
  );
  const older = loaded.messages.filter(
    (row) =>
      (row.message.createdAt?.getTime() ?? Number.POSITIVE_INFINITY) < firstTime &&
      !nativeIds(row).some((id) => currentIds.has(id))
  );
  const retainedIds = new Set([
    ...older.map((row) => row.message.id),
    ...current.messages.map((row) => row.message.id),
  ]);
  return {
    ...current,
    messages: [
      ...older,
      ...current.messages.map((row) => {
        const source = nativeIds(row)
          .map((id) => loadedById.get(id))
          .find((candidate) => candidate !== undefined);
        const parent = row.parentId ?? source?.parentId;
        return {
          ...row,
          message:
            source && row.message.role === 'assistant'
              ? {
                  ...row.message,
                  metadata: {
                    ...row.message.metadata,
                    custom: {
                      ...row.message.metadata?.custom,
                      [NATIVE_MESSAGE_IDS_METADATA_KEY]: [
                        ...new Set([...nativeIds(source), ...nativeIds(row)]),
                      ],
                    },
                  },
                }
              : row.message,
          parentId: parent && retainedIds.has(parent) ? parent : null,
        };
      }),
    ],
  };
}
