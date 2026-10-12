interface UtilityParent {
  off(event: 'message', listener: (input: unknown) => void): unknown;
  on(event: 'message', listener: (input: unknown) => void): unknown;
}

/** Capture transferred messages before importing the control or kernel graphs. */
export function createUtilityParentInbox(parent: UtilityParent): {
  bind(receive: (input: unknown) => void): void;
  close(): void;
  readonly received: Promise<void>;
} {
  const pending: unknown[] = [];
  const received = Promise.withResolvers<void>();
  let receiver: ((input: unknown) => void) | undefined;
  const message = (input: unknown): void => {
    received.resolve();
    if (receiver) {
      receiver(input);
    } else {
      pending.push(input);
    }
  };
  parent.on('message', message);
  return {
    bind: (receive) => {
      if (receiver) {
        throw new Error('Utility parent receiver is already bound');
      }
      receiver = receive;
      for (const input of pending.splice(0)) {
        receive(input);
      }
    },
    close: () => parent.off('message', message),
    received: received.promise,
  };
}

/** Importing code owns no Root; cancellation must not wait for module loading. */
export async function loadUtilityStartup<Value>(
  load: () => Promise<Value>,
  signal: AbortSignal
): Promise<Value> {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = (): void => cancelled.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([load(), cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
