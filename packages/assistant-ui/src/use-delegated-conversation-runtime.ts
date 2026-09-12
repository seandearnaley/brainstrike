import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
  useExternalMessageConverter,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import {
  type AssistantUiThreadHistoryAdapter,
  CHILD_INPUT_DELIVERY_METADATA_KEY,
  CHILD_USER_MESSAGE_DATA_NAME,
  childUserMessageSchema,
} from '@brainstrike/assistant-contract';
import { useMemo } from 'react';
import type { DelegatedConversationUpdate } from './delegated-conversation-receiver';

type History = Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>>;
export interface DelegatedConversationRuntimeOptions {
  readonly history: History;
  readonly onNew: ExternalStoreAdapter['onNew'];
  readonly update?: DelegatedConversationUpdate;
}
const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message;

function splitChildMessages(
  message: DelegatedConversationUpdate['message'],
  id: string
): ThreadMessageLike[] {
  const result: ThreadMessageLike[] = [];
  let parts: typeof message.parts = [];
  let segment = 0;
  for (const part of message.parts) {
    if (part.type !== 'data' || part.name !== CHILD_USER_MESSAGE_DATA_NAME) {
      parts.push(part);
      continue;
    }
    const input = childUserMessageSchema.parse(part.data);
    if (parts.length > 0) {
      result.push({
        content: parts,
        id: `${id}:${segment}`,
        metadata: message.metadata,
        role: 'assistant',
        status: { reason: 'stop', type: 'complete' },
      });
    }
    result.push({
      content: [{ text: input.text, type: 'text' }],
      createdAt: new Date(input.createdAt),
      id: input.id,
      metadata: { custom: { [CHILD_INPUT_DELIVERY_METADATA_KEY]: 'delivered' } },
      role: 'user',
    });
    parts = [];
    segment += 1;
  }
  result.push({
    content: parts,
    id: segment === 0 ? id : `${id}:${segment}`,
    metadata: message.metadata,
    role: 'assistant',
    status: message.status,
  });
  return result;
}

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
  const childRunId = update?.continuation?.nativeRunId ?? update?.identity?.childRuntimeRunId;
  if (message && !hostRunId) {
    throw new Error('A live child view requires its history baseline.');
  }
  const isRunning = message?.status.type === 'running';
  const tail = useMemo<ThreadMessageLike[]>(() => {
    if (!message) {
      return [];
    }
    const current = splitChildMessages(
      message,
      `delegated-leg:${JSON.stringify([hostRunId, childRunId])}`
    );
    if (!head) {
      return current;
    }
    // The vendor concatenator retains the first assistant's status. Only the
    // active baseline head shares this continuation; saved branches are untouched.
    return [
      head.message.role === 'assistant'
        ? { ...head.message, status: message.status }
        : head.message,
      ...current,
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
