import { createLogger } from '@brainstrike/logging';
import { type ComponentType, useCallback, useEffect, useState } from 'react';

const logger = createLogger('LazyComponent');

export interface LazyComponentOptions<TProps> {
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
}

export interface LazyComponent<TProps> {
  readonly component: ComponentType<TProps> | null;
  readonly loadError: Error | null;
  /** True once the component is available. */
  readonly ready: boolean;
  /**
   * Re-attempts the load. Surface this on the error UI: a transient load
   * rejection must not be terminal for the mount's lifetime. No-op while
   * nothing is outstanding.
   */
  readonly retry: () => void;
}

/**
 * Shared loader for database-tooling surfaces that are code-split. Failures are
 * surfaced through `loadError` rather than swallowed, and are recoverable via
 * `retry` instead of latching for the mount's lifetime.
 */
export function useLazyComponent<TProps>({
  initialComponent = null,
  label,
  load,
}: LazyComponentOptions<TProps>): LazyComponent<TProps> {
  const [component, setComponent] = useState<ComponentType<TProps> | null>(() => initialComponent);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (component) {
      return;
    }

    let cancelled = false;
    load().then(
      (resolved) => {
        if (!cancelled) {
          setComponent(() => resolved);
          setLoadError(null);
        }
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        const failure =
          error instanceof Error ? error : new Error('Failed to load database tools.');
        logger.error('Failed to prepare a lazy database-tooling surface', {
          attempt,
          error: failure,
          label,
        });
        setLoadError(failure);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [attempt, component, label, load]);

  const retry = useCallback(() => {
    setLoadError(null);
    setAttempt((value) => value + 1);
  }, []);

  return {
    component,
    loadError,
    ready: component !== null,
    retry,
  };
}
