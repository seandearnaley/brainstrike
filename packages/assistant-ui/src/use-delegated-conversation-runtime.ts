import {
  type AssistantRuntime,
  type ExternalStoreAdapter,
  type ThreadMessageLike,
  useExternalMessageConverter,
  useExternalStoreRuntime,
} from '@assistant-ui/react';
import {
  type AssistantChildInput,
  type AssistantUiThreadHistoryAdapter,
  CHILD_INPUT_DELIVERY_METADATA_KEY,
  CHILD_USER_MESSAGE_DATA_NAME,
  childUserMessageSchema,
} from '@brainstrike/assistant-contract';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';
import { Schema } from 'effect';
import { useMemo, useRef } from 'react';
import { captureChildInputDraft } from './active-conversation-input-draft';
import { createAssistantImageAttachmentAdapter } from './attachment-adapter';
import type { DelegatedConversationUpdate } from './delegated-conversation-receiver';

type History = Awaited<ReturnType<AssistantUiThreadHistoryAdapter['load']>>;
export interface DelegatedConversationRuntimeOptions {
  readonly attachmentsPresent?: boolean;
  readonly history: History;
  readonly onBranch?: (input: Omit<AssistantChildFollowupAction, 'threadId'>) => Promise<void>;
  readonly onNew: ExternalStoreAdapter['onNew'];
  readonly prepareBranchInput?: (input: AssistantChildInput) => AssistantChildInput;
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
    const input = Schema.decodeUnknownSync(childUserMessageSchema, { errors: 'all' })(part.data);
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
      content: [
        ...(input.text ? [{ text: input.text, type: 'text' as const }] : []),
        ...(input.attachments ?? []).map((attachment) => ({
          image: attachment.data,
          type: 'image' as const,
        })),
      ],
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
  attachmentsPresent = false,
  update,
  onNew,
  onBranch,
  prepareBranchInput,
}: DelegatedConversationRuntimeOptions): AssistantRuntime {
  const branchReceipts = useRef(
    new Map<
      string,
      {
        readonly action: Omit<AssistantChildFollowupAction, 'threadId'>;
        readonly signature: string;
      }
    >()
  );
  const attachments = useMemo(
    () => (attachmentsPresent ? createAssistantImageAttachmentAdapter() : undefined),
    [attachmentsPresent]
  );
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
  const dispatchBranch = async (
    input: AssistantChildInput,
    branch: AssistantChildFollowupAction['branch']
  ): Promise<void> => {
    if (!(onBranch && branch)) {
      throw new Error('Child branching is unavailable.');
    }
    const key = JSON.stringify(branch);
    const signature = JSON.stringify({ attachments: input.attachments ?? [], text: input.text });
    const existing = branchReceipts.current.get(key);
    const action =
      existing?.signature === signature
        ? existing.action
        : {
            ...(prepareBranchInput ? prepareBranchInput(input) : input),
            branch,
          };
    branchReceipts.current.set(key, { action, signature });
    await onBranch(action);
    if (branchReceipts.current.get(key)?.action === action) {
      branchReceipts.current.delete(key);
    }
  };
  return useExternalStoreRuntime<ThreadMessageLike>({
    ...(attachments ? { adapters: { attachments } } : {}),
    convertMessage,
    isRunning,
    messageRepository,
    ...(onBranch
      ? {
          onEdit: async (message) => {
            if (!message.sourceId) {
              throw new Error('Edit requires an existing child user message.');
            }
            const input = await captureChildInputDraft(
              crypto.randomUUID(),
              message.content
                .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                .join('\n'),
              message.attachments ?? []
            );
            await dispatchBranch(input, { kind: 'edit', messageId: message.sourceId });
          },
          onReload: async (_parentId, config) => {
            if (!config.sourceId) {
              throw new Error('Retry requires an existing child answer.');
            }
            const messageId =
              config.sourceId === messageRepository.headId && update
                ? update.messageId
                : config.sourceId;
            await dispatchBranch(
              {
                id: crypto.randomUUID(),
                text: 'Retry the selected child answer.',
              },
              { kind: 'retry', messageId }
            );
          },
        }
      : {}),
    onNew,
  });
}
