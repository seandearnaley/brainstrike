import type { createLogger } from '@brainstrike/logging';
import {
  type BackgroundBackfillSnapshot,
  getSupersededBackgroundBackfillIds,
} from '@brainstrike/pipeline';

export interface CancelSupersededBackgroundBackfillsDeps {
  cancelBackfill: (embeddingSetId: string) => Promise<void>;
  log?: ReturnType<typeof createLogger>;
}

/**
 * Failure-isolated by construction (BST-1654 follow-up). A sequential loop that
 * lets the first rejection escape stops asking the host to cancel anything
 * after it, so one uncooperative run silently spares every later one — "the
 * user pressed pause and indexing kept running", which is the exact failure the
 * enumeration exists to prevent. Every enumerated run gets its cancel
 * attempted; only then do the failures surface, aggregated, so a stop that
 * could not be fully delivered still rejects at the caller instead of looking
 * like it worked.
 */
export async function cancelSupersededBackgroundBackfills(
  deps: CancelSupersededBackgroundBackfillsDeps,
  args: {
    exceptEmbeddingSetId?: string;
    inFlightBackfills: readonly BackgroundBackfillSnapshot[];
  }
): Promise<void> {
  const failures: Array<{ embeddingSetId: string; error: unknown }> = [];
  for (const embeddingSetId of getSupersededBackgroundBackfillIds(args)) {
    try {
      await deps.cancelBackfill(embeddingSetId);
    } catch (error) {
      failures.push({ embeddingSetId, error });
    }
  }
  if (failures.length === 0) {
    return;
  }
  const failedSetIds = failures.map((failure) => failure.embeddingSetId);
  deps.log?.warn('Failed to cancel background indexing backfills', {
    embeddingSetIds: failedSetIds,
    errors: failures.map((failure) =>
      failure.error instanceof Error ? failure.error.message : String(failure.error)
    ),
  });
  throw new AggregateError(
    failures.map((failure) => failure.error),
    `Failed to cancel background indexing backfill(s) for embedding set(s): ${failedSetIds.join(', ')}.`
  );
}
