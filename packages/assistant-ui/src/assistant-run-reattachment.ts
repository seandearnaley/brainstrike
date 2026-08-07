import type {
  CreateResumeRunConfig,
  ExportedMessageRepository,
  ExportedMessageRepositoryItem,
  ThreadMessage,
} from '@assistant-ui/react';
import {
  type AssistantActiveRunSession,
  isAssistantActiveRunSession,
} from '@brainstrike/assistant-contract';
import { useEffect, useRef } from 'react';

const ACTIVE_RUN_STORAGE_PREFIX = 'brainstrike.assistant.active-run:';

function activeRunStorageKey(threadKey: string): string {
  const normalized = threadKey.trim();
  if (!normalized) {
    throw new Error('Assistant active-run storage requires a non-empty thread key.');
  }
  return `${ACTIVE_RUN_STORAGE_PREFIX}${normalized}`;
}

export function writeAssistantActiveRunSession(
  threadKey: string,
  record: AssistantActiveRunSession,
  storage: Storage = window.sessionStorage
): void {
  if (!isAssistantActiveRunSession(record)) {
    throw new Error('Assistant active-run session is malformed.');
  }
  storage.setItem(activeRunStorageKey(threadKey), JSON.stringify(record));
}

export function readAssistantActiveRunSession(
  threadKey: string,
  storage: Storage = window.sessionStorage
): AssistantActiveRunSession | undefined {
  const value = storage.getItem(activeRunStorageKey(threadKey));
  if (value === null) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error('Stored assistant active-run session is malformed JSON.', { cause: error });
  }
  if (!isAssistantActiveRunSession(parsed)) {
    throw new Error('Stored assistant active-run session is malformed.');
  }
  return parsed;
}

export function clearAssistantActiveRunSession(
  threadKey: string,
  storage: Storage = window.sessionStorage
): void {
  storage.removeItem(activeRunStorageKey(threadKey));
}

export interface AssistantReplayMessageIdentity {
  readonly durableMessageId: string;
  readonly generatedMessageId: string;
}

export interface AssistantReplayMessageIdentityRef {
  current: AssistantReplayMessageIdentity | null;
}

export interface ReattachableRuntime {
  readonly thread: {
    getState(): {
      readonly isLoading: boolean;
      readonly isRunning: boolean;
      readonly messages: readonly ThreadMessage[];
    };
    export(): ExportedMessageRepository;
    import(repository: ExportedMessageRepository): void;
    resumeRun(config: {
      parentId: string | null;
      runConfig: Record<string, unknown>;
      stream: NonNullable<CreateResumeRunConfig['stream']>;
    }): void;
    subscribe(listener: () => void): () => void;
    // biome-ignore lint/style/useNamingConvention: assistant-ui ThreadRuntime field.
    unstable_on(event: 'runEnd', listener: () => void): () => void;
  };
}

export function beginAssistantReplay({
  durableMessageId,
  identityRef,
  runtime,
  stream,
}: {
  readonly durableMessageId: string;
  readonly identityRef: AssistantReplayMessageIdentityRef;
  readonly runtime: ReattachableRuntime;
  readonly stream: NonNullable<CreateResumeRunConfig['stream']>;
}): void {
  const repository = runtime.thread.export();
  const durableItem = repository.messages.find((item) => item.message.id === durableMessageId);
  if (!durableItem) {
    throw new Error(
      `Assistant replay could not find durable message '${durableMessageId}' after history hydration.`
    );
  }
  if (repository.messages.some((item) => item.parentId === durableMessageId)) {
    throw new Error(
      `Assistant replay cannot replace durable message '${durableMessageId}' because it already has descendants.`
    );
  }

  runtime.thread.import({
    headId: durableItem.parentId,
    messages: repository.messages.filter((item) => item.message.id !== durableMessageId),
  });
  let unsubscribeRunEnd = (): void => undefined;
  const handleRunEnd = (): void => {
    unsubscribeRunEnd();
    const identity = identityRef.current;
    if (!identity) {
      throw new Error('Assistant replay ended before its message identity was established.');
    }
    reconcileAssistantReplayMessage(runtime, identity);
    if (identityRef.current === identity) {
      identityRef.current = null;
    }
  };
  unsubscribeRunEnd = runtime.thread.unstable_on('runEnd', handleRunEnd);
  try {
    runtime.thread.resumeRun({
      parentId: durableItem.parentId,
      runConfig: {},
      stream,
    });
  } catch (error) {
    unsubscribeRunEnd();
    runtime.thread.import(repository);
    throw error;
  }

  const generatedMessage = runtime.thread.getState().messages.at(-1);
  if (generatedMessage?.role !== 'assistant' || generatedMessage.id === durableMessageId) {
    unsubscribeRunEnd();
    runtime.thread.import(repository);
    throw new Error('Assistant replay runtime did not create a distinct streaming message.');
  }
  identityRef.current = {
    durableMessageId,
    generatedMessageId: generatedMessage.id,
  };
}

export function reconcileAssistantReplayMessage(
  runtime: ReattachableRuntime,
  identity: AssistantReplayMessageIdentity
): void {
  const repository = runtime.thread.export();
  const generatedItem = repository.messages.find(
    (item) => item.message.id === identity.generatedMessageId
  );
  if (!generatedItem) {
    if (repository.messages.some((item) => item.message.id === identity.durableMessageId)) {
      return;
    }
    throw new Error(
      `Assistant replay lost generated message '${identity.generatedMessageId}' before identity reconciliation.`
    );
  }

  const headId =
    repository.headId === identity.generatedMessageId
      ? identity.durableMessageId
      : repository.headId;
  runtime.thread.import({
    ...(headId === undefined ? {} : { headId }),
    messages: repository.messages.map((item) => ({
      ...item,
      message:
        item.message.id === identity.generatedMessageId
          ? { ...item.message, id: identity.durableMessageId }
          : item.message,
      parentId:
        item.parentId === identity.generatedMessageId ? identity.durableMessageId : item.parentId,
    })),
  });
}

export function remapAssistantReplayHistoryItem(
  item: ExportedMessageRepositoryItem,
  identity: AssistantReplayMessageIdentity | null
): ExportedMessageRepositoryItem {
  if (!(identity && item.message.id === identity.generatedMessageId)) {
    return item;
  }
  return {
    ...item,
    message: { ...item.message, id: identity.durableMessageId },
  };
}

export function useAssistantRunReattachment({
  identityRef,
  record,
  replayRetryToken,
  runtime,
  stream,
}: {
  readonly identityRef: AssistantReplayMessageIdentityRef;
  readonly record: AssistantActiveRunSession | undefined;
  readonly replayRetryToken: number;
  readonly runtime: ReattachableRuntime;
  readonly stream: NonNullable<CreateResumeRunConfig['stream']>;
}): void {
  const attemptedReplayKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!record) {
      attemptedReplayKeyRef.current = null;
      return;
    }
    const replayKey = `${record.eventId}:${replayRetryToken}`;
    const attempt = (): void => {
      const state = runtime.thread.getState();
      if (state.isLoading || state.isRunning || attemptedReplayKeyRef.current === replayKey) {
        return;
      }
      attemptedReplayKeyRef.current = replayKey;
      beginAssistantReplay({
        durableMessageId: record.assistantMessageId,
        identityRef,
        runtime,
        stream,
      });
    };

    attempt();
    return runtime.thread.subscribe(attempt);
  }, [identityRef, record, replayRetryToken, runtime, stream]);
}
