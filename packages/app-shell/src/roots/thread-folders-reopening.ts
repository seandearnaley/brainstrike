/**
 * The threads whose folders are being opened again as their tab comes to the front. A send in
 * that moment would be refused for a folder about to open, so the composer holds it until the
 * thread's folders have opened or failed to.
 */
import { useSyncExternalStore } from 'react';

const reopening = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Marks the thread's folders as reopening; the returned call ends it. */
export function markThreadFoldersReopening(threadId: string): () => void {
  reopening.set(threadId, (reopening.get(threadId) ?? 0) + 1);
  notify();
  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    const count = (reopening.get(threadId) ?? 1) - 1;
    if (count > 0) {
      reopening.set(threadId, count);
    } else {
      reopening.delete(threadId);
    }
    notify();
  };
}

/** Whether the thread's folders are being opened again now. */
export function useThreadFoldersReopening(threadId: string | undefined): boolean {
  return useSyncExternalStore(subscribe, () => (threadId ? reopening.has(threadId) : false));
}
