import type {
  MastraDBMessage,
  MastraMessageContentV2,
  MastraMessagePart,
  MessageList,
} from '@mastra/core/agent/message-list';
import type { MastraMemory } from '@mastra/core/memory';
import type { RuntimeData } from '../types';
import { createMastraAgentError } from '../mastra-boundary/mastra-agent-error';

const ABORTED_TURN_MEMORY_MARKER = '[Assistant turn aborted before completion.]';

export interface AbortedTurnPersistence {
  attachMessageList: (
    messageList: MessageList | undefined,
    assistantMessageId?: string
  ) => Promise<void> | void;
  /** Freeze native state at abort without starting persistence before terminal ownership is known. */
  captureSnapshot: () => void;
  finalize: () => Promise<void>;
  markNormalFinish: () => void;
}

interface StreamResultWithMessageList {
  messageId?: string;
  messageList?: MessageList;
}

function isCompletedToolInvocationPart(part: MastraMessagePart): boolean {
  if (part.type !== 'tool-invocation') {
    return false;
  }
  return ['output-denied', 'output-error', 'result'].includes(part.toolInvocation.state);
}

function assistantContent(parts: MastraMessagePart[]): MastraMessageContentV2 {
  return {
    format: 2,
    parts,
  };
}

/**
 * The abort snapshot, under Mastra >= 1.62 cancel persistence.
 *
 * Mastra's `MessageHistory` output processor now persists a cancelled run's
 * transcript itself — the user input, completed tool work, AND any partial
 * text — through its normal output processing. That write is not awaited by
 * the aborted loop, so this seam still exists for two reasons: it appends the
 * model-visible abort marker, and its awaited `saveMessages` is the join that
 * serializes Mastra's floating write ahead of runtime disposal (without it the
 * write races the storage close; see the BST-1320 record in
 * docs/agents/mastra-boundary.md).
 *
 * Content rule: everything Mastra persists is kept — re-saving the same ids is
 * an upsert of the same parts, deliberately re-stamped with a `createdAt` at
 * or after "now" so the snapshot orders last — EXCEPT tool invocations that
 * never completed. Mastra filters partial tool calls from its own write, and this
 * seam must not re-introduce one, or Stop could resurrect execution on the
 * next turn. Partial text is retained: dropping it here cannot remove the row
 * Mastra already wrote, and a snapshot that disagrees with the UI's transcript
 * is the exact failure BST-1415 recorded.
 */
function buildAbortedTurnMessages(
  unsavedMessages: MastraDBMessage[],
  assistantMessageId: string,
  threadId: string,
  resourceId: string
): MastraDBMessage[] {
  const inputMessages = unsavedMessages.filter((message) => message.role === 'user');
  const assistantMessages = unsavedMessages.filter((message) => message.role === 'assistant');
  const assistantCreatedAtStart = Math.max(
    Date.now(),
    ...inputMessages.map((message) => message.createdAt.getTime() + 1)
  );

  const retainedAssistantMessages = assistantMessages
    .map((message, messageIndex) => ({
      ...message,
      content: assistantContent(
        message.content.parts.filter(
          (part) => part.type !== 'tool-invocation' || isCompletedToolInvocationPart(part)
        )
      ),
      createdAt: new Date(assistantCreatedAtStart + messageIndex),
    }))
    .filter((message) => message.content.parts.some((part) => part.type !== 'step-start'));
  const markerTarget = retainedAssistantMessages.at(-1);
  const markerMessage: MastraDBMessage = markerTarget
    ? {
        ...markerTarget,
        content: assistantContent([
          ...markerTarget.content.parts,
          { text: ABORTED_TURN_MEMORY_MARKER, type: 'text' },
        ]),
      }
    : {
        content: {
          format: 2,
          parts: [{ text: ABORTED_TURN_MEMORY_MARKER, type: 'text' }],
        },
        createdAt: new Date(assistantCreatedAtStart),
        id: assistantMessageId,
        resourceId,
        role: 'assistant',
        threadId,
      };

  return [...inputMessages, ...retainedAssistantMessages.slice(0, -1), markerMessage];
}

async function persistAbortedTurn({
  assistantMessageId,
  memory,
  unsavedMessages,
  runtimeData,
}: {
  assistantMessageId: string;
  memory: MastraMemory;
  unsavedMessages: MastraDBMessage[];
  runtimeData: RuntimeData;
}): Promise<void> {
  const memoryContext = runtimeData.memory;
  if (!memoryContext) {
    return;
  }
  const { resourceId, threadId } = memoryContext;
  const thread = await memory.getThreadById({ threadId });
  if (!thread) {
    await memory.createThread({ resourceId, threadId });
  }
  const messages = buildAbortedTurnMessages(
    unsavedMessages,
    assistantMessageId,
    threadId,
    resourceId
  );
  await memory.saveMessages({
    messages,
    ...(memoryContext.memoryOptions ? { memoryConfig: memoryContext.memoryOptions } : {}),
  });
}

export function createAbortedTurnPersistence({
  assistantMessageId,
  beforePersist,
  memory,
  runtimeData,
  shouldPersist,
}: {
  assistantMessageId: string;
  beforePersist?: (() => Promise<void>) | undefined;
  memory: MastraMemory;
  runtimeData: RuntimeData;
  shouldPersist: () => boolean;
}): AbortedTurnPersistence {
  let finalizationRequested = false;
  let finishedNormally = false;
  let messageListAttached = false;
  let messageList: MessageList | undefined;
  let persistenceTask: Promise<void> | undefined;
  let resolvedAssistantMessageId = assistantMessageId;
  let snapshot:
    | { ok: true; messages: MastraDBMessage[]; messageId: string }
    | { ok: false; error: unknown }
    | undefined;
  const captureSnapshot = (): void => {
    if (snapshot || !messageList || finishedNormally) {
      return;
    }
    try {
      snapshot = {
        messageId: resolvedAssistantMessageId,
        // Match memory-store.ts's JSON content boundary, including toJSON values.
        // This is the persisted representation, not a fallback to mutable live data.
        messages: messageList.drainUnsavedMessages().map((message) => ({
          ...message,
          content: JSON.parse(JSON.stringify(message.content)) as MastraMessageContentV2,
          createdAt: new Date(message.createdAt),
        })),
        ok: true,
      };
    } catch (error) {
      // Abort listeners cannot throw; the terminal finalizer reports this failure.
      snapshot = { error, ok: false };
    }
  };

  const start = (): Promise<void> | undefined => {
    if (!(finalizationRequested && !finishedNormally && shouldPersist() && messageListAttached)) {
      return;
    }
    if (!messageList) {
      persistenceTask ??= Promise.reject(
        createMastraAgentError('mastra_agent_memory_unavailable', {
          detail: 'Mastra stream result did not expose its message list',
        })
      );
      return persistenceTask;
    }
    if (persistenceTask) {
      return persistenceTask;
    }
    captureSnapshot();
    const captured = snapshot;
    persistenceTask = (async () => {
      const errors: unknown[] = [];
      try {
        await beforePersist?.();
      } catch (error) {
        errors.push(error);
      }
      try {
        if (!captured) {
          throw new Error('Aborted turn snapshot was not captured.');
        }
        if (!captured.ok) {
          throw captured.error;
        }
        await persistAbortedTurn({
          assistantMessageId: captured.messageId,
          memory,
          runtimeData,
          unsavedMessages: captured.messages,
        });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')
        );
      }
    })();
    return persistenceTask;
  };

  return {
    attachMessageList: (value, messageId) => {
      messageListAttached = true;
      messageList = value;
      resolvedAssistantMessageId = messageId ?? resolvedAssistantMessageId;
    },
    captureSnapshot,
    finalize: () => {
      finalizationRequested = true;
      return start() ?? Promise.resolve();
    },
    markNormalFinish: () => {
      finishedNormally = true;
    },
  };
}

export async function attachAbortedTurnMessageList(
  persistence: AbortedTurnPersistence | undefined,
  streamResult: StreamResultWithMessageList
): Promise<void> {
  if (!persistence) {
    return;
  }
  await persistence.attachMessageList(streamResult.messageList, streamResult.messageId);
}
