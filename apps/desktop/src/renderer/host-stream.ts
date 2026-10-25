import { isBoundaryRefusal } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('DesktopHostStream');

/** One host stream: listeners join it, and the first one opens it on the host. */
export function hostStream<E>(
  label: string,
  open: (dispatch: (event: E) => void) => Promise<void>
) {
  let opening: Promise<void> | undefined;
  const listeners = new Set<(event: E) => void>();
  const dispatch = (event: E): void => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };
  const openOnce = (): void => {
    if (opening || listeners.size === 0) {
      return;
    }
    const attempt = open(dispatch);
    opening = attempt;
    attempt.catch((error: unknown) => {
      // Each surface reports its own read failures; the next listener retries the stream.
      if (isBoundaryRefusal(error)) {
        logger.warn(`${label} subscription refused`, { error });
      } else {
        logger.error(`${label} subscription failed`, { error });
      }
      if (opening === attempt) {
        opening = undefined;
      }
    });
  };
  return {
    dispatch,
    /** BST-2004: a replaced host has none of this window's streams. */
    reopen: (): void => {
      opening = undefined;
      openOnce();
    },
    subscribe: (listener: (event: E) => void): (() => void) => {
      listeners.add(listener);
      openOnce();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
