// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  cancelSupersededBackgroundBackfills,
  classifyEnqueueContinuation,
} from '../workspace-collection-sync-cancel';

const BACKFILL_PREFIX = 'background-indexing-backfill:';

function inFlight(embeddingSetId: string, requestId = `${BACKFILL_PREFIX}${embeddingSetId}`) {
  return { embeddingSetId, progress: null, requestId };
}

/**
 * BST-1654 follow-up (review round 4). `cancelBackfill` takes only an embedding-set id,
 * so the question a stale continuation must answer is not "am I still the current pass"
 * but "is a LATER pass working on MY set" — the two differ, and getting it wrong costs a
 * user either their restarted indexing or a runaway run that survived a pause.
 */
describe('classifyEnqueueContinuation', () => {
  it('cancels a run orphaned by a deliberate stop', () => {
    expect(
      classifyEnqueueContinuation({
        backfillAborted: true,
        loopAborted: true,
        supersededForThisSet: false,
      })
    ).toBe('cancel-orphan');
  });

  it('cancels a run orphaned by a replacement on a DIFFERENT set', () => {
    // The hazard this distinction exists for: that replacement's own sweep enumerated
    // the host before this run existed, so nothing else will ever stop it. Reading
    // "someone else holds the slot" as "not mine to cancel" leaves it burning.
    expect(
      classifyEnqueueContinuation({
        backfillAborted: true,
        loopAborted: false,
        supersededForThisSet: false,
      })
    ).toBe('cancel-orphan');
  });

  it('leaves the run alone when a replacement owns this same set', () => {
    // Cancelling by set id here stops the run the user just restarted. The replacement
    // re-adopts what it inherits, so abandoning is both safe and recoverable.
    for (const backfillAborted of [true, false]) {
      expect(
        classifyEnqueueContinuation({
          backfillAborted,
          loopAborted: false,
          supersededForThisSet: true,
        })
      ).toBe('abandon');
    }
  });

  it('publishes nothing after a detach, and never cancels the durable run', () => {
    // `detach()` aborts the renderer loop and deliberately spares the backfill signal,
    // which is exactly what separates it from a stop.
    expect(
      classifyEnqueueContinuation({
        backfillAborted: false,
        loopAborted: true,
        supersededForThisSet: false,
      })
    ).toBe('stop');
  });

  it('proceeds only when nothing stopped, detached, or replaced this pass', () => {
    expect(
      classifyEnqueueContinuation({
        backfillAborted: false,
        loopAborted: false,
        supersededForThisSet: false,
      })
    ).toBe('proceed');
  });
});

describe('cancelSupersededBackgroundBackfills', () => {
  it('attempts every enumerated run even when an earlier cancel rejects', async () => {
    const attempted: string[] = [];
    const cancelBackfill = vi.fn(async (embeddingSetId: string) => {
      attempted.push(embeddingSetId);
      if (embeddingSetId === 'set-a') {
        throw new Error('host refused');
      }
    });

    const rejection = await cancelSupersededBackgroundBackfills(
      { cancelBackfill },
      { inFlightBackfills: [inFlight('set-a'), inFlight('set-b')] }
    ).catch((error: unknown) => error);

    // The point: `set-b` was still asked, and the undeliverable stop still surfaced.
    expect(attempted).toEqual(['set-a', 'set-b']);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).message).toContain('set-a');
  });

  it('never cancels a run background indexing does not own', () => {
    const cancelBackfill = vi.fn(async () => undefined);

    return expect(
      cancelSupersededBackgroundBackfills(
        { cancelBackfill },
        { inFlightBackfills: [{ embeddingSetId: 'set-a', progress: null, requestId: 'manual:1' }] }
      )
    ).resolves.toBeUndefined();
  });

  it('spares the set the caller is keeping', async () => {
    const attempted: string[] = [];
    const cancelBackfill = vi.fn(async (embeddingSetId: string) => {
      attempted.push(embeddingSetId);
    });

    await cancelSupersededBackgroundBackfills(
      { cancelBackfill },
      {
        exceptEmbeddingSetId: 'set-a',
        inFlightBackfills: [inFlight('set-a'), inFlight('set-b')],
      }
    );

    expect(attempted).toEqual(['set-b']);
  });
});
