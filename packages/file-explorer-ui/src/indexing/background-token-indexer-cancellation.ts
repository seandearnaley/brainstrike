import {
  hasFactoryResetPreparationStarted,
  registerFactoryResetPreparation,
} from '@brainstrike/app-state/factory-reset';
import { createLogger } from '@brainstrike/logging';
import { type RefObject, useEffect, useMemo, useRef } from 'react';

const logger = createLogger('BackgroundTokenIndexerIntegration');

interface CancellableIndexer {
  readonly cancelIndexing: (cancellation: Error) => void;
  readonly retire: (retirement: Error) => void;
}

/**
 * The cancellations this owner issues to its background token indexer.
 *
 * Factory reset retires the indexer (ADR-0015, BST-2092). Reset's live-store
 * clear remounts FileExplorerProvider's children, and that remount terminates
 * the indexer's worker. Reset preparation runs first: it fences new dispatch,
 * settles in-flight batches with one retirement object and joins the owner's
 * dispatch runs.
 *
 * A user cancel (the whole selection cleared) settles the batch in flight with
 * one cancellation object of its own and keeps the worker (BST-2118).
 *
 * Each object is this owner's token. A dispatch that settles with one ended as
 * that cancellation; any other error, including the same worker termination
 * without a reset, is a failure.
 */
export interface IndexingCancellation {
  /** Cancels the batch in flight with a new cancellation object this owner keeps. */
  readonly cancel: () => void;
  /** Whether the reset retired this owner; no dispatch starts after that. */
  readonly isRetired: () => boolean;
  /** True, logged at debug, only when `error` is one of this owner's cancellations itself. */
  readonly settledByOwner: (error: unknown, dispatch: string) => boolean;
  /** Tracks a dispatch run so reset preparation can join it. */
  readonly track: (run: Promise<void>) => Promise<void>;
}

export function useIndexingCancellation(
  indexerRef: RefObject<CancellableIndexer>
): IndexingCancellation {
  const retirementRef = useRef<Error | null>(null);
  const cancellationsRef = useRef(new WeakSet<Error>());
  const runsRef = useRef(new Set<Promise<void>>());

  useEffect(() => {
    const retire = (): void => {
      if (retirementRef.current) {
        return;
      }
      const retirement = new Error('Factory reset retired background token indexing');
      retirementRef.current = retirement;
      indexerRef.current.retire(retirement);
    };
    // An owner remounted after preparation began belongs to the same terminal reset.
    if (hasFactoryResetPreparationStarted()) {
      retire();
      return;
    }
    return registerFactoryResetPreparation(async () => {
      retire();
      await Promise.allSettled([...runsRef.current]);
    });
  }, [indexerRef]);

  return useMemo(
    () => ({
      cancel: (): void => {
        const cancellation = new Error(
          'The selection was cleared; its token indexing is cancelled'
        );
        cancellationsRef.current.add(cancellation);
        indexerRef.current.cancelIndexing(cancellation);
      },
      isRetired: () => retirementRef.current !== null,
      settledByOwner: (error: unknown, dispatch: string): boolean => {
        if (retirementRef.current !== null && error === retirementRef.current) {
          logger.debug('triggerIndexing settled by factory reset retirement', { dispatch });
          return true;
        }
        if (error instanceof Error && cancellationsRef.current.has(error)) {
          logger.debug('triggerIndexing settled by user cancellation', { dispatch });
          return true;
        }
        return false;
      },
      track: (run: Promise<void>): Promise<void> => {
        runsRef.current.add(run);
        const settle = (): void => {
          runsRef.current.delete(run);
        };
        void run.then(settle, settle);
        return run;
      },
    }),
    [indexerRef]
  );
}
