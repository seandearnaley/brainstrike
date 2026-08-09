import { createLogger } from '@brainstrike/logging';
import type { QueueAdapter } from '@brainstrike/queue';
import { type ComponentType, useEffect, useState } from 'react';

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
}

/**
 * Shared loader for database-tooling surfaces that are code-split AND need the
 * app-owned embedding queue before they can do anything useful.
 *
 * Both are fetched concurrently; the surface stays in its own loading state
 * until both land, so it never renders a half-wired import path. Failures are
 * surfaced through `loadError` rather than swallowed.
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

  useEffect(() => {
    if (component && (embeddingQueue || !loadEmbeddingQueue)) {
      return;
    }

    let cancelled = false;
    const componentPromise = component ? Promise.resolve(null) : load();
    const queuePromise =
      embeddingQueue || !loadEmbeddingQueue ? Promise.resolve(null) : loadEmbeddingQueue();

    void Promise.all([componentPromise, queuePromise])
      .then(([resolvedComponent, resolvedQueue]) => {
        if (cancelled) {
          return;
        }
        if (resolvedComponent) {
          setComponent(() => resolvedComponent);
        }
        if (resolvedQueue) {
          setEmbeddingQueue(resolvedQueue);
        }
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const failure =
          error instanceof Error ? error : new Error('Failed to load database tools.');
        logger.error('Failed to prepare a lazy database-tooling surface', {
          error: failure,
          label,
        });
        setLoadError(failure);
      });

    return () => {
      cancelled = true;
    };
  }, [component, embeddingQueue, label, load, loadEmbeddingQueue]);

  return {
    component,
    embeddingQueue,
    loadError,
    ready: component !== null && (!loadEmbeddingQueue || embeddingQueue !== null),
  };
}
