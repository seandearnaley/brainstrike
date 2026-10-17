import {
  hasFactoryResetPreparationStarted,
  registerFactoryResetPreparation,
} from '@brainstrike/app-state/factory-reset';
import { createLogger } from '@brainstrike/logging';
import { type RefObject, useEffect, useMemo, useRef } from 'react';

const logger = createLogger('BackgroundTokenIndexerIntegration');

interface RetirableIndexer {
  readonly retire: (retirement: Error) => void;
}

/**
 * Factory reset retires the renderer's background token indexer (ADR-0015).
 *
 * Reset's live-store clear remounts FileExplorerProvider's children, and that
 * remount terminates the indexer's worker. Reset preparation runs first: it
 * fences new dispatch, settles in-flight batches with one retirement object and
 * joins the owner's dispatch runs. That object is the reset's ownership token.
 * A dispatch that settles with it ended as the reset's cancellation; any other
 * error, including the same worker termination without a reset, is a failure.
 */
export interface IndexingResetRetirement {
  /** Whether the reset retired this owner; no dispatch starts after that. */
  readonly isRetired: () => boolean;
  /** True, logged at debug, only when `error` is this owner's retirement itself. */
  readonly settledByReset: (error: unknown, dispatch: string) => boolean;
  /** Tracks a dispatch run so reset preparation can join it. */
  readonly track: (run: Promise<void>) => Promise<void>;
}

export function useIndexingResetRetirement(
  indexerRef: RefObject<RetirableIndexer>
): IndexingResetRetirement {
  const retirementRef = useRef<Error | null>(null);
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
      isRetired: () => retirementRef.current !== null,
      settledByReset: (error: unknown, dispatch: string): boolean => {
        if (retirementRef.current === null || error !== retirementRef.current) {
          return false;
        }
        logger.debug('triggerIndexing settled by factory reset retirement', { dispatch });
        return true;
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
    []
  );
}
