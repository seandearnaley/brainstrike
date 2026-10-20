import { registerClosePreparation } from '@brainstrike/file-explorer-hooks';
import {
  createContext,
  useCallback,
  useContext,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from 'react';

/** Desktop injects its existing per-document close owner; web has no quit owner. */
export interface ExplorerCloseLifecycle {
  readonly isPreparing: () => boolean;
  readonly registerPersistence: (prepare: () => Promise<void>, begin: () => void) => () => void;
  readonly registerProducer: (prepare: () => Promise<void>) => () => void;
}
export const ExplorerCloseLifecycleContext = createContext<ExplorerCloseLifecycle | undefined>(
  undefined
);
export function useExplorerCloseLifecycle(): ExplorerCloseLifecycle | undefined {
  return useContext(ExplorerCloseLifecycleContext);
}
function throwProducerFailures(failures: ReadonlySet<unknown>): void {
  if (failures.size === 1) {
    throw [...failures][0];
  }
  if (failures.size > 1) {
    throw new AggregateError([...failures], 'Explorer producer failed to settle');
  }
}
/** Register an existing producer; admission checks also cover effects flushed after prepare. */
export function useExplorerClosePreparation(
  prepare: () => Promise<void>,
  drain: () => Promise<void>
): void {
  const lifecycle = useExplorerCloseLifecycle();
  const onPrepare = useEffectEvent(prepare);
  const onDrain = useEffectEvent(drain);
  useLayoutEffect(() => {
    if (!lifecycle || lifecycle.isPreparing()) {
      return;
    }
    return registerClosePreparation(
      { drain: async () => await onDrain(), prepareClose: async () => await onPrepare() },
      lifecycle.registerProducer
    );
  }, [lifecycle]);
}

/** Completion bookkeeping for one existing producer, including ordinary detach. */
export function useExplorerCloseProducer(cancel: () => void = () => {}): {
  isPreparing: () => boolean;
  track: <T>(operation: Promise<T>, settledByOwner?: (error: unknown) => boolean) => Promise<T>;
} {
  const lifecycle = useExplorerCloseLifecycle();
  const retiring = useRef(false);
  const pending = useRef(new Set<Promise<unknown>>());
  const track = useCallback(
    <T>(operation: Promise<T>, settledByOwner?: (error: unknown) => boolean): Promise<T> => {
      const observed = settledByOwner
        ? operation.catch((error: unknown) => {
            if (!settledByOwner(error)) {
              throw error;
            }
          })
        : operation;
      pending.current.add(observed);
      const settled = () => {
        pending.current.delete(observed);
      };
      void observed.then(settled, settled);
      return operation;
    },
    []
  );
  const drain = useCallback(async () => {
    const failures = new Set<unknown>();
    do {
      const results = await Promise.allSettled([...pending.current]);
      for (const result of results) {
        if (result.status === 'rejected') {
          failures.add(result.reason);
        }
      }
    } while (pending.current.size > 0);
    throwProducerFailures(failures);
  }, []);
  useExplorerClosePreparation(async () => {
    retiring.current = true;
    const cancellation = new Promise<void>((resolve, reject) => {
      try {
        cancel();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    const results = await Promise.allSettled([cancellation, drain()]);
    throwProducerFailures(
      new Set(results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])))
    );
  }, drain);
  const isPreparing = useCallback(
    () => retiring.current || lifecycle?.isPreparing() === true,
    [lifecycle]
  );
  return { isPreparing, track };
}
