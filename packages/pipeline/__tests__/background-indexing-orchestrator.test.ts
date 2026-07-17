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
    progress: { current: 1, total: 4 },
    requestId: 'background-indexing-backfill:active',
  },
  {
    embeddingSetId: 'set-2',
    progress: { current: 1, total: 2 },
    requestId: 'background-indexing-backfill:stale',
  },
  {
    embeddingSetId: 'set-3',
    progress: null,
    requestId: 'manual-backfill:keep',
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
    expect(needsEmbeddingBackfill({ chunksWithEmbeddingsForSet: 0, totalChunks: 0 })).toBe(false);
    expect(needsEmbeddingBackfill({ chunksWithEmbeddingsForSet: 10, totalChunks: 10 })).toBe(false);
    expect(needsEmbeddingBackfill({ chunksWithEmbeddingsForSet: 9, totalChunks: 10 })).toBe(true);
  });
});
