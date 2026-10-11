interface UtilityParent {
  off(event: 'message', listener: (input: unknown) => void): unknown;
  on(event: 'message', listener: (input: unknown) => void): unknown;
}

/** Capture transferred messages before importing the control or kernel graphs. */
export function createUtilityParentInbox(parent: UtilityParent): {
  bind(receive: (input: unknown) => void): void;
  close(): void;
} {
  const pending: unknown[] = [];
  let receiver: ((input: unknown) => void) | undefined;
  const message = (input: unknown): void => {
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
  };
}
