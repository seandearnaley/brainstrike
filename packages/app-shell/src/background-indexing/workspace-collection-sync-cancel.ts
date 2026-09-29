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
 *
 * The awaits stay serialized deliberately. `Promise.allSettled` reads as the
 * tidier form and lints cleaner, but it collapses this into a single microtask
 * turn and that shifts the interleaving the QoS permit tests pin. The set is a
 * handful of cancels on a stop path, so there is nothing to win here.
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

/**
 * What a sync pass must do when its `enqueueBackfill` await finally resolves. The pass
 * may have been stopped, detached, or superseded while the host was creating the run,
 * and `cancelBackfill` takes only an embedding-set id — so the decision turns on whether
 * a LATER pass is working on the SAME set, not on whether this pass is still current.
 *
 * - `cancel-orphan`: a deliberate stop (or a superseding sync on another set) aborted the
 *   backfill signal. That signal is never aborted by `detach()`, so the run this enqueue
 *   just created is already orphaned: the stop's sweep enumerated the host before it
 *   existed, and the desktop host drops the signal at the IPC boundary rather than
 *   honouring it. Nothing else will stop it.
 * - `abandon`: a replacement pass owns this same set. Cancelling by set id here would
 *   stop the run the user just restarted; the replacement re-adopts what it inherits.
 * - `stop`: `detach()` released the renderer loop and deliberately spared the durable
 *   run. Publishing from here would re-arm tracking and an "embedding pending" status on
 *   a service whose progress subscription is gone, so the completion event could never
 *   land and a finished run would stay on screen.
 * - `proceed`: this pass still owns its run and may publish.
 */
export function classifyEnqueueContinuation(args: {
  backfillAborted: boolean;
  loopAborted: boolean;
  supersededForThisSet: boolean;
}): 'abandon' | 'cancel-orphan' | 'proceed' | 'stop' {
  if (args.backfillAborted) {
    return args.supersededForThisSet ? 'abandon' : 'cancel-orphan';
  }
  if (args.loopAborted) {
    return 'stop';
  }
  return args.supersededForThisSet ? 'abandon' : 'proceed';
}
