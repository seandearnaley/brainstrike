import type {
  CreateResumeRunConfig,
  ExportedMessageRepository,
  ExportedMessageRepositoryItem,
  ThreadAssistantMessagePart,
  ThreadMessage,
} from '@assistant-ui/react';
import {
  type AssistantActiveRunSession,
  type AssistantDiscoveredRun,
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

/** Restore the exact unsaved user input retained by the host before replay. */
export function restoreDiscoveredRunInput(
  runtime: ReattachableRuntime,
  discoveredRun: AssistantDiscoveredRun
): void {
  const repository = runtime.thread.export();
  const input = discoveredRun.inputMessage;
  if (!input) {
    return;
  }
  if (discoveredRun.parentMessageId !== input.id) {
    throw new Error('Discovered assistant run input does not match its admitted parent.');
  }
  const existing = repository.messages.find((item) => item.message.id === input.id);
  if (existing) {
    if (
      existing.message.role !== 'user' ||
      existing.parentId !== discoveredRun.inputParentMessageId
    ) {
      throw new Error(`Discovered assistant input '${input.id}' conflicts with hydrated history.`);
    }
    return;
  }
  const inputParentId = discoveredRun.inputParentMessageId;
  if (inputParentId && !repository.messages.some((item) => item.message.id === inputParentId)) {
    throw new Error(`Discovered assistant input '${input.id}' has no hydrated parent.`);
  }
  const content = input.parts
    .filter(
      (part): part is Extract<(typeof input.parts)[number], { type: 'text' }> =>
        part.type === 'text'
    )
    .map((part) => ({ text: part.text, type: 'text' as const }));
  const attachments = input.parts
    .filter(
      (part): part is Extract<(typeof input.parts)[number], { type: 'file' }> =>
        part.type === 'file'
    )
    .map((part, index) => {
      if (!part.mediaType.startsWith('image/')) {
        throw new Error(`Discovered assistant input '${input.id}' has an unsupported file part.`);
      }
      return {
        content: [{ image: part.data, type: 'image' as const }],
        contentType: part.mediaType,
        id: `${input.id}:recovered-attachment:${index}`,
        name: part.filename ?? `image-${index + 1}`,
        status: { type: 'complete' as const },
        type: 'image' as const,
      };
    });
  runtime.thread.import({
    headId: input.id,
    messages: [
      ...repository.messages,
      {
        message: {
          attachments,
          content,
          createdAt: new Date(),
          id: input.id,
          metadata: { custom: {} },
          role: 'user',
        },
        parentId: inputParentId,
      },
    ],
  });
}

export function beginAssistantReplay({
  durableMessageId,
  identityRef,
  parentMessageId,
  runtime,
  stream,
  syntheticPauseMessageId,
}: {
  readonly durableMessageId: string;
  readonly identityRef: AssistantReplayMessageIdentityRef;
  readonly parentMessageId?: string | null;
  readonly runtime: ReattachableRuntime;
  readonly stream: NonNullable<CreateResumeRunConfig['stream']>;
  readonly syntheticPauseMessageId?: string;
}): void {
  const repository = runtime.thread.export();
  const durableItem = repository.messages.find((item) => item.message.id === durableMessageId);
  if (!durableItem && parentMessageId === undefined) {
    throw new Error(
      `Assistant replay could not find durable message '${durableMessageId}' after history hydration.`
    );
  }
  const parentId = durableItem?.parentId ?? parentMessageId ?? null;
  if (parentId && !repository.messages.some((item) => item.message.id === parentId)) {
    throw new Error(
      `Assistant replay could not find the admitted parent '${parentId}' after history hydration.`
    );
  }
  if (durableItem && parentMessageId !== undefined && durableItem.parentId !== parentMessageId) {
    throw new Error(`Assistant replay found a conflicting parent for '${durableMessageId}'.`);
  }
  const syntheticPause = repository.messages.find(
    (item) => item.message.id === syntheticPauseMessageId
  );
  if (
    syntheticPause &&
    (syntheticPause.parentId !== durableMessageId ||
      repository.messages.some((item) => item.parentId === syntheticPauseMessageId))
  ) {
    throw new Error('Assistant replay found a conflicting synthetic pause descendant.');
  }
  if (
    repository.messages.some(
      (item) => item.parentId === durableMessageId && item.message.id !== syntheticPauseMessageId
    )
  ) {
    throw new Error(
      `Assistant replay cannot replace durable message '${durableMessageId}' because it already has descendants.`
    );
  }

  runtime.thread.import({
    headId: parentId,
    messages: repository.messages.filter(
      (item) => item.message.id !== durableMessageId && item.message.id !== syntheticPauseMessageId
    ),
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
      parentId,
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

function mergeActionReplayContent(
  prefix: readonly ThreadAssistantMessagePart[],
  continuation: readonly ThreadAssistantMessagePart[]
): readonly ThreadAssistantMessagePart[] {
  const content = [...prefix];
  for (const part of continuation) {
    if (part.type === 'tool-call') {
      const index = content.findIndex(
        (existing) => existing.type === 'tool-call' && existing.toolCallId === part.toolCallId
      );
      if (index >= 0) {
        const existing = content[index];
        if (existing?.type !== 'tool-call') {
          throw new Error('Assistant replay tool part changed type during merge.');
        }
        const { approval: _priorApproval, ...withoutApproval } = existing;
        content[index] =
          part.result !== undefined && part.approval === undefined
            ? { ...withoutApproval, ...part }
            : { ...existing, ...part };
        continue;
      }
    }
    content.push(part);
  }
  return content;
}

function withActionReplayPrefix(
  stream: NonNullable<CreateResumeRunConfig['stream']>,
  prefixContent: readonly ThreadAssistantMessagePart[]
): NonNullable<CreateResumeRunConfig['stream']> {
  return async function* replayWithPrefix(options) {
    for await (const update of stream(options)) {
      yield {
        ...update,
        content: mergeActionReplayContent(prefixContent, update.content ?? []),
      };
    }
  };
}

function startAssistantReplay({
  discoveredRun,
  identityRef,
  record,
  runtime,
  stream,
}: {
  readonly discoveredRun: AssistantDiscoveredRun | undefined;
  readonly identityRef: AssistantReplayMessageIdentityRef;
  readonly record: AssistantActiveRunSession;
  readonly runtime: ReattachableRuntime;
  readonly stream: NonNullable<CreateResumeRunConfig['stream']>;
}): void {
  if (discoveredRun) {
    if (discoveredRun.runId !== record.runId) {
      throw new Error('Discovered assistant run does not match the active replay cursor.');
    }
    restoreDiscoveredRunInput(runtime, discoveredRun);
  }
  const actionReplay = discoveredRun?.actionReplay;
  beginAssistantReplay({
    durableMessageId: actionReplay?.pausedMessageId ?? record.assistantMessageId,
    identityRef,
    ...(actionReplay
      ? { parentMessageId: actionReplay.pausedParentMessageId }
      : record.parentMessageId === undefined
        ? {}
        : { parentMessageId: record.parentMessageId }),
    runtime,
    stream: actionReplay ? withActionReplayPrefix(stream, actionReplay.prefixContent) : stream,
    ...(actionReplay ? { syntheticPauseMessageId: actionReplay.syntheticPauseMessageId } : {}),
  });
}

export function useAssistantRunReattachment({
  discoveredRun,
  identityRef,
  record,
  replayRetryToken,
  runtime,
  stream,
}: {
  readonly discoveredRun?: AssistantDiscoveredRun | undefined;
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
      startAssistantReplay({
        discoveredRun,
        identityRef,
        record,
        runtime,
        stream,
      });
    };

    attempt();
    return runtime.thread.subscribe(attempt);
  }, [discoveredRun, identityRef, record, replayRetryToken, runtime, stream]);
}
