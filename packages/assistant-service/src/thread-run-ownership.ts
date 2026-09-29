interface WaitingRun {
  readonly grant: () => void;
}

const owners = new Map<string, WaitingRun[]>();

/** One process-local execution owner per durable root, with abortable FIFO admission. */
export function acquireThreadRunOwnership(
  scope: { readonly resourceId: string; readonly threadId: string },
  signal: AbortSignal
): Promise<() => void> {
  signal.throwIfAborted();
  const key = JSON.stringify([scope.resourceId, scope.threadId]);
  return new Promise((resolve, reject) => {
    const queue = owners.get(key) ?? [];
    let released = false;
    const release = (): void => {
      if (released) {
        return;
      }
      released = true;
      if (queue[0] !== entry) {
        throw new Error('Thread execution ownership was lost.');
      }
      queue.shift();
      const next = queue[0];
      if (next) {
        next.grant();
      } else {
        owners.delete(key);
      }
    };
    const cancelWaiting = (): void => {
      const index = queue.indexOf(entry);
      if (index < 0) {
        return;
      }
      queue.splice(index, 1);
      signal.removeEventListener('abort', cancelWaiting);
      reject(signal.reason);
    };
    const entry: WaitingRun = {
      grant: () => {
        signal.removeEventListener('abort', cancelWaiting);
        resolve(release);
      },
    };
    queue.push(entry);
    owners.set(key, queue);
    if (queue[0] === entry) {
      entry.grant();
    } else {
      signal.addEventListener('abort', cancelWaiting, { once: true });
    }
  });
}
