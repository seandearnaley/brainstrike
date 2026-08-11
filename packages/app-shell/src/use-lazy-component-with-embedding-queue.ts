import { createLogger } from '@brainstrike/logging';
import type { QueueAdapter } from '@brainstrike/queue';
import { type ComponentType, useCallback, useEffect, useState } from 'react';

const logger = createLogger('LazyComponentWithEmbeddingQueue');

export interface LazyComponentWithEmbeddingQueueOptions<TProps> {
  /**
   * Already-resolved component from a previous mount (callers keep a
   * module-scope cache). Skips the loading state on remount.
   */
  readonly initialComponent?: ComponentType<TProps> | null;
  /** Names the surface in load-failure logs. */
  readonly label: string;
  /**
   * Resolves the code-split component. Must be module-stable (built once at
   * module scope from `createRetryableLazyModuleLoader`) — a new function per
   * render would refetch forever.
   */
  readonly load: () => Promise<ComponentType<TProps>>;
  /**
   * Lazy loader for the app-owned embedding queue. Callers must pass a
   * referentially stable loader (useCallback at the app root); the first
   * resolved queue for a given loader is treated as canonical and is never
   * silently swapped during unrelated parent re-renders.
   */
  readonly loadEmbeddingQueue?: (() => Promise<QueueAdapter>) | null;
}

export interface LazyComponentWithEmbeddingQueue<TProps> {
  readonly component: ComponentType<TProps> | null;
  readonly embeddingQueue: QueueAdapter | null;
  readonly loadError: Error | null;
  /** True once the component AND (if requested) the queue are both available. */
  readonly ready: boolean;
  /**
   * Re-attempts whatever is still missing. Surface this on the error UI: a
   * transient queue-init rejection must not be terminal for the mount's
   * lifetime. No-op while nothing is outstanding.
   */
  readonly retry: () => void;
}

/**
 * Shared loader for database-tooling surfaces that are code-split AND need the
 * app-owned embedding queue before they can do anything useful.
 *
 * Both are fetched concurrently; the surface stays in its own loading state
 * until both land, so it never renders a half-wired import path. Failures are
 * surfaced through `loadError` rather than swallowed.
 *
 * The two halves settle INDEPENDENTLY: `Promise.all` rejected as a unit, so a
 * queue-init failure discarded an already-resolved component and the next
 * attempt had to refetch both. Each half now commits on its own, and a failure
 * is recoverable via `retry` instead of latching for the mount's lifetime.
 * Failures stay visible — they just stop being terminal.
 */
export function useLazyComponentWithEmbeddingQueue<TProps>({
  initialComponent = null,
  label,
  load,
  loadEmbeddingQueue = null,
}: LazyComponentWithEmbeddingQueueOptions<TProps>): LazyComponentWithEmbeddingQueue<TProps> {
  const [component, setComponent] = useState<ComponentType<TProps> | null>(() => initialComponent);
  const [embeddingQueue, setEmbeddingQueue] = useState<QueueAdapter | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (component && (embeddingQueue || !loadEmbeddingQueue)) {
      return;
    }

    let cancelled = false;
    const needsComponent = !component;
    const needsQueue = Boolean(loadEmbeddingQueue) && !embeddingQueue;

    let failed = false;
    const fail = (error: unknown): void => {
      failed = true;
      if (cancelled) {
        return;
      }
      const failure = error instanceof Error ? error : new Error('Failed to load database tools.');
      logger.error('Failed to prepare a lazy database-tooling surface', {
        attempt,
        error: failure,
        label,
      });
      setLoadError(failure);
    };

    // Settled independently, NOT through Promise.all: one half failing must not
    // throw away the other half's resolved value, or every retry pays to refetch
    // work that already succeeded.
    const pending: Promise<unknown>[] = [];

    if (needsComponent) {
      pending.push(
        load().then((resolved) => {
          if (!cancelled) {
            setComponent(() => resolved);
          }
        }, fail)
      );
    }

    if (needsQueue && loadEmbeddingQueue) {
      pending.push(
        loadEmbeddingQueue().then((resolved) => {
          if (!cancelled) {
            setEmbeddingQueue(resolved);
          }
        }, fail)
      );
    }

    // Clear a previous failure only once THIS attempt has fully settled with no
    // half failing — so a stale error never lingers beside a working surface,
    // and a fresh error is never wiped by the other half landing after it.
    void Promise.allSettled(pending).then(() => {
      if (!(cancelled || failed)) {
        setLoadError(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [attempt, component, embeddingQueue, label, load, loadEmbeddingQueue]);

  const retry = useCallback(() => {
    setLoadError(null);
    setAttempt((value) => value + 1);
  }, []);

  return {
    component,
    embeddingQueue,
    loadError,
    ready: component !== null && (!loadEmbeddingQueue || embeddingQueue !== null),
    retry,
  };
}
