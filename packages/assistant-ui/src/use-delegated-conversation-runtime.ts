import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
  useExternalMessageConverter,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/assistant-contract';
import { useMemo } from 'react';
import type { DelegatedConversationUpdate } from './delegated-conversation-receiver';

type History = Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>>;
export interface DelegatedConversationRuntimeOptions {
  readonly history: History;
  readonly onNew: ExternalStoreAdapter['onNew'];
  readonly update?: DelegatedConversationUpdate;
}
const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message;

/** Subscribe a view to host-owned output; this runtime never starts a model. */
export function useDelegatedConversationRuntime({
  history,
  update,
  onNew,
}: DelegatedConversationRuntimeOptions): AssistantRuntime {
  const head = history.messages.find(({ message }) => message.id === history.headId);
  if (history.headId && !head) {
    throw new Error('Child history has no matching active head.');
  }
  const message = update?.message;
  const hostRunId = update?.baseline?.hostRunId;
  const childRunId = update?.identity.childRuntimeRunId;
  if (message && !hostRunId) {
    throw new Error('A live child view requires its history baseline.');
  }
  const isRunning = message?.status.type === 'running';
  const tail = useMemo<ThreadMessageLike[]>(() => {
    if (!message) {
      return [];
    }
    const current: ThreadMessageLike = {
      content: message.parts,
      id: `delegated-leg:${JSON.stringify([hostRunId, childRunId])}`,
      metadata: message.metadata,
      role: 'assistant',
      status: message.status,
    };
    if (!head) {
      return [current];
    }
    // The vendor concatenator retains the first assistant's status. Only the
    // active baseline head shares this continuation; saved branches are untouched.
    return [
      head.message.role === 'assistant'
        ? { ...head.message, status: message.status }
        : head.message,
      current,
    ];
  }, [head, message, hostRunId, childRunId]);
  const converted = useExternalMessageConverter({
    callback: convertMessage,
    isRunning,
    joinStrategy: 'concat-content',
    messages: tail,
  });
  const messageRepository = useMemo<History>(() => {
    if (!message) {
      return history;
    }
    let parentId = head?.parentId ?? null;
    const replacement = converted.map((item) => {
      const row = { message: item, parentId };
      parentId = item.id;
      return row;
    });
    return {
      headId: parentId,
      messages: [...history.messages.filter((row) => row !== head), ...replacement],
    };
  }, [history, head, converted, message]);
  return useExternalStoreRuntime<ThreadMessageLike>({
    convertMessage,
    isRunning,
    messageRepository,
    onNew,
  });
}
