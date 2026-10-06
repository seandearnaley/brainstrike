import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ThreadMessage,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import { useCallback, useMemo, useReducer, useSyncExternalStore } from 'react';
import {
  bindCommittedAssistantCommands,
  type CommittedAssistantCommands,
  type CommittedAssistantSnapshot,
  type CommittedAssistantStore,
} from './committed-assistant-store';

/** Object.is compares the selected fold object, so unrelated tokens do not rerender a card. */
export function useCommittedAssistantSelector<T>(
  store: CommittedAssistantStore,
  select: (snapshot: CommittedAssistantSnapshot) => T
): T {
  const getSnapshot = useCallback(() => select(store.getSnapshot()), [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export interface CommittedAssistantRuntimeOptions {
  readonly adapters?: ExternalStoreAdapter<ThreadMessage>['adapters'];
  readonly commands: CommittedAssistantCommands;
  readonly onCommandError: (cause: unknown) => void;
  readonly store: CommittedAssistantStore;
}

/**
 * Bind the production surface to already committed, fully shaped vendor messages.
 * Using messageRepository avoids a converter copying tools/approval parts on every
 * token and preserves branches, message ids and per-part references from the fold.
 * No model, transport, replay loop or transcript writer is constructed here.
 */
export function useCommittedAssistantRuntime({
  store,
  commands,
  adapters,
  onCommandError,
}: CommittedAssistantRuntimeOptions): AssistantRuntime {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [resync, invalidate] = useReducer((revision: number) => revision + 1, 0);
  const reportCommandError = useCallback(
    (cause: unknown): void => {
      invalidate();
      onCommandError(cause);
    },
    [onCommandError]
  );
  const ports = useMemo(
    () => bindCommittedAssistantCommands(store, commands, reportCommandError),
    [store, commands, reportCommandError]
  );
  // Branch/import can move the vendor's local head before a rejected command.
  // A fresh repository envelope forces its public snapshot path to adopt the
  // canonical fold again. Message/part/approval objects are never copied.
  const repository = useMemo(
    () => ({ ...snapshot.repository }),
    [snapshot.repository, snapshot.connection, snapshot.error, resync]
  );
  return useExternalStoreRuntime<ThreadMessage>({
    ...ports,
    adapters,
    extras: snapshot.extras,
    isDisabled: snapshot.isDisabled,
    isLoading: snapshot.isLoading,
    isRunning: snapshot.isRunning,
    isSendDisabled: snapshot.connection !== 'connected' || snapshot.error !== undefined,
    messageRepository: repository,
    // Installed branch switching checks this port before moving its local head.
    setMessages:
      snapshot.connection === 'connected' && snapshot.error === undefined && !snapshot.isDisabled
        ? ports.setMessages
        : undefined,
    state: snapshot.state,
  });
}
