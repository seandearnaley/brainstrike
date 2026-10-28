import type { AppendMessage, CreateAppendMessage } from '@assistant-ui/react';
import { threadMessageQueue } from '../thread-message-queue';

/**
 * Put a message in a thread's queue the way the vendor runtime does while a
 * run is active. With no mounted conversation the queue is held, so the
 * message waits there until the test removes or dispatches it.
 */
export function queueMessage(threadKey: string, message: CreateAppendMessage | string): void {
  const input =
    typeof message === 'string' ? { content: [{ text: message, type: 'text' as const }] } : message;
  const append: AppendMessage = {
    attachments: [],
    content:
      typeof input.content === 'string'
        ? [{ text: input.content, type: 'text' }]
        : [...input.content],
    createdAt: new Date(0),
    metadata: { custom: { ...input.metadata?.custom } },
    parentId: null,
    role: 'user',
    runConfig: input.runConfig,
    sourceId: null,
    startRun: input.startRun,
  } as AppendMessage;
  threadMessageQueue(threadKey).getAdapter().enqueue(append);
}

/** The waiting messages' prompts, in send order. */
export function queuedPrompts(threadKey: string): readonly string[] {
  return threadMessageQueue(threadKey)
    .getItems()
    .map((item) => item.prompt);
}
