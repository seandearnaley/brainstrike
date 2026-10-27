import { getErrorMessage } from '@brainstrike/utils/error-utils';
import { useEffect, useMemo, useState } from 'react';
import {
  type AssistantThreadHostCanvasVersion,
  useAssistantThreadHost,
} from '../assistant-thread-host-context';

/** Every committed version of every canvas of one thread, oldest first per canvas. */
export type ThreadCanvases = ReadonlyMap<string, readonly AssistantThreadHostCanvasVersion[]>;

export type ThreadCanvasRead =
  | { readonly status: 'loading' }
  | { readonly error: string; readonly status: 'error' }
  | { readonly canvases: ThreadCanvases; readonly status: 'ready' };

const NOT_OWNED = 'This thread is not owned by the agent host, so it has no canvases.';

/**
 * The committed canvases of each thread an open canvas tab names (BST-1173).
 * The agent host owns them: each thread is read once, and again when the host
 * signals that a run committed a canvas version on it, so every tab and tab
 * label of one thread shares a single read. A re-read keeps showing the last
 * answer until the new one lands; a failed read is an error, never an empty
 * list.
 */
export function useThreadCanvasReads(
  threadIds: readonly string[]
): ReadonlyMap<string, ThreadCanvasRead> {
  const host = useAssistantThreadHost();
  const key = [...new Set(threadIds)].sort().join('\n');
  const [reads, setReads] = useState<ReadonlyMap<string, ThreadCanvasRead>>(() => new Map());

  useEffect(() => {
    const ids = key === '' ? [] : key.split('\n');
    let disposed = false;
    const attempts = new Map<string, number>();
    const settle = (threadId: string, attempt: number, read: ThreadCanvasRead): void => {
      if (!disposed && attempts.get(threadId) === attempt) {
        setReads((previous) => new Map(previous).set(threadId, read));
      }
    };
    const load = (threadId: string): void => {
      const attempt = (attempts.get(threadId) ?? 0) + 1;
      attempts.set(threadId, attempt);
      Promise.resolve(host?.readCanvases?.(threadId)).then(
        (canvases) =>
          settle(
            threadId,
            attempt,
            canvases ? { canvases, status: 'ready' } : { error: NOT_OWNED, status: 'error' }
          ),
        (error: unknown) =>
          settle(threadId, attempt, {
            error: `Canvas read failed: ${getErrorMessage(error)}`,
            status: 'error',
          })
      );
    };
    const releases = ids.map((threadId) => {
      load(threadId);
      return host?.subscribeCanvases?.(threadId, () => load(threadId));
    });
    return () => {
      disposed = true;
      for (const release of releases) {
        release?.();
      }
    };
  }, [host, key]);

  // Only the threads open tabs name now; a thread reopened later is read again.
  return useMemo(() => {
    const ids = key === '' ? [] : key.split('\n');
    return new Map([...reads].filter(([threadId]) => ids.includes(threadId)));
  }, [key, reads]);
}
