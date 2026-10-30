import { useSyncExternalStore } from 'react';

/**
 * ADR-0032: an answer about a folder's trust changes which skills, slash
 * commands and instructions load. The host owns the answer; this renderer-only
 * counter tells every list read from it (the "/" menu, the composer's prompt)
 * to read again.
 */
let revision = 0;
const listeners = new Set<() => void>();

/** Called after the host recorded a trust answer, from any surface that sets one. */
export function notifyWorkspaceTrustChanged(): void {
  revision += 1;
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

const read = (): number => revision;

/** Changes after each recorded trust answer; a reload trigger, never a value to show. */
export function useWorkspaceTrustRevision(): number {
  return useSyncExternalStore(subscribe, read, read);
}
