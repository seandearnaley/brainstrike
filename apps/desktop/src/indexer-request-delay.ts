import { type LifecycleDelays, lifecycleDelay } from '@brainstrike/host-lease/lifecycle-delays';

function isIndexerRequest(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    !('channel' in message) &&
    typeof Reflect.get(message, 'id') === 'number' &&
    typeof Reflect.get(message, 'op') === 'string'
  );
}

/**
 * The indexer utility's delivery of its parent's messages. With the E2E `indexer-request` point
 * that Main handed this utility (lifecycle redesign §6.1), messages pass through one in-order
 * queue whose first indexer request waits that long, as a loaded utility answers late. Unset,
 * the listener itself is returned: delivery stays synchronous, exactly as without the seam.
 */
export function indexerMessageDelivery(
  delays: LifecycleDelays,
  listener: (message: unknown) => void
): (message: unknown) => void {
  if (!delays.has('indexer-request')) {
    return listener;
  }
  let queue = Promise.resolve();
  return (message) => {
    queue = queue
      .then(async () => {
        if (isIndexerRequest(message)) {
          await lifecycleDelay(delays, 'indexer-request');
        }
        listener(message);
      })
      .catch((error: unknown) => {
        // As thrown from the synchronous listener: an uncaught exception, never swallowed.
        process.nextTick(() => {
          throw error;
        });
      });
  };
}
