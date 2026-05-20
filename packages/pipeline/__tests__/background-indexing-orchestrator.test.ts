import { describe, expect, it } from 'vitest';
import {
  getSupersededBackgroundBackfillIds,
  isBackgroundIndexingBackfillRequestId,
  needsEmbeddingBackfill,
  selectRecoverableBackgroundBackfill,
} from '../src/background-indexing-orchestrator';

const inFlightBackfills = [
  {
    embeddingSetId: 'set-1',
    requestId: 'background-indexing-backfill:active',
    progress: { current: 1, total: 4 },
  },
  {
    embeddingSetId: 'set-2',
    requestId: 'background-indexing-backfill:stale',
    progress: { current: 1, total: 2 },
  },
  {
    embeddingSetId: 'set-3',
    requestId: 'manual-backfill:keep',
    progress: null,
  },
];

describe('background indexing orchestrator', () => {
  it('owns the background backfill request id contract', () => {
    expect(isBackgroundIndexingBackfillRequestId('background-indexing-backfill:abc')).toBe(true);
    expect(isBackgroundIndexingBackfillRequestId('manual-backfill:abc')).toBe(false);
  });

  it('selects the recoverable backfill for the active managed collection only', () => {
    expect(
      selectRecoverableBackgroundBackfill({
        embeddingSetId: 'set-1',
        inFlightBackfills,
      })
    ).toEqual(inFlightBackfills[0]);
    expect(
      selectRecoverableBackgroundBackfill({
        embeddingSetId: 'set-3',
        inFlightBackfills,
      })
    ).toBeNull();
  });

  it('returns only superseded background-indexing backfill collection ids', () => {
    expect(
      getSupersededBackgroundBackfillIds({
        exceptEmbeddingSetId: 'set-1',
        inFlightBackfills,
      })
    ).toEqual(['set-2']);
  });

  it('treats partial coverage as needing a managed backfill', () => {
    expect(needsEmbeddingBackfill({ totalChunks: 0, chunksWithEmbeddingsForSet: 0 })).toBe(false);
    expect(needsEmbeddingBackfill({ totalChunks: 10, chunksWithEmbeddingsForSet: 10 })).toBe(false);
    expect(needsEmbeddingBackfill({ totalChunks: 10, chunksWithEmbeddingsForSet: 9 })).toBe(true);
  });
});
