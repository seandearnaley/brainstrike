import type { AppendMessage } from '@assistant-ui/react';
import { afterEach, expect, test, vi } from 'vitest';
import { resetThreadMessageQueues, threadMessageQueue } from '../thread-message-queue';
import { queueMessage } from './thread-message-queue-support';

afterEach(() => resetThreadMessageQueues());

/**
 * The queue outlives its conversation: it is kept for the session, and the
 * vendor queue inside it keeps the dispatch transform the conversation's
 * runtime registered. That transform is a method of the runtime, so it held
 * the unmounted runtime, its store and the thread's whole committed log for
 * as long as the app ran: one closed thread after another.
 */
test('a conversation that unmounts leaves none of itself in its thread queue', () => {
  const queue = threadMessageQueue('closed-thread');
  // The vendor runtime registers its transform on the queue it is handed.
  const closedRuntimeTransform = vi.fn((message: AppendMessage) => message);
  queue.getAdapter().__internal_setDispatchTransform?.(closedRuntimeTransform);
  const unmount = queue.bind(async () => undefined);
  unmount();

  // The thread's next conversation sends through the queue while it is idle.
  const sent: AppendMessage[] = [];
  queue.bind((message) => {
    sent.push(message);
    return Promise.resolve();
  });
  queue.observe({ catchUp: true, running: false, settled: true });
  queueMessage('closed-thread', 'after reopening');

  expect(sent).toHaveLength(1);
  expect(closedRuntimeTransform).not.toHaveBeenCalled();
});
