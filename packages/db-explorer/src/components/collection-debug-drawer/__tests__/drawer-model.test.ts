// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  canUseCollectionForRetrievalPreview,
  deriveChunkEmbeddingStatus,
  deriveFileEmbeddingStatus,
  formatSimilarityScore,
  getRetrievalDisabledReason,
} from '../drawer-model';

describe('deriveFileEmbeddingStatus', () => {
  it('reports none when the file has no chunks and chunking already finished', () => {
    expect(
      deriveFileEmbeddingStatus({ chunksCount: 0, chunksProcessed: true, embeddedChunksCount: 0 })
    ).toBe('none');
  });

  it('reports pending while the file is still awaiting chunking', () => {
    expect(
      deriveFileEmbeddingStatus({ chunksCount: 0, chunksProcessed: false, embeddedChunksCount: 0 })
    ).toBe('pending');
  });

  it('reports pending when chunks exist but none carry an embedding', () => {
    expect(
      deriveFileEmbeddingStatus({ chunksCount: 4, chunksProcessed: true, embeddedChunksCount: 0 })
    ).toBe('pending');
  });

  it('reports processing on partial embedding coverage', () => {
    expect(
      deriveFileEmbeddingStatus({ chunksCount: 4, chunksProcessed: true, embeddedChunksCount: 3 })
    ).toBe('processing');
  });

  it('reports complete only when every chunk carries an embedding', () => {
    expect(
      deriveFileEmbeddingStatus({ chunksCount: 4, chunksProcessed: true, embeddedChunksCount: 4 })
    ).toBe('complete');
  });

  it('reports failed when the queue recorded a failure, even with partial coverage', () => {
    expect(
      deriveFileEmbeddingStatus({
        chunksCount: 4,
        chunksProcessed: true,
        embeddedChunksCount: 3,
        failedChunksCount: 1,
      })
    ).toBe('failed');
  });
});

describe('deriveChunkEmbeddingStatus', () => {
  it('is complete for an embedded chunk', () => {
    expect(deriveChunkEmbeddingStatus({ hasEmbedding: true })).toBe('complete');
  });

  it('is pending for an unembedded chunk', () => {
    expect(deriveChunkEmbeddingStatus({ hasEmbedding: false })).toBe('pending');
  });

  it('is failed when the queue recorded a failure for that chunk', () => {
    expect(deriveChunkEmbeddingStatus({ failed: true, hasEmbedding: false })).toBe('failed');
  });
});

describe('retrieval preview gating', () => {
  it('allows a normal collection', () => {
    expect(canUseCollectionForRetrievalPreview('col-1', null)).toBe(true);
    expect(getRetrievalDisabledReason('col-1', null)).toBeNull();
  });

  it('refuses when no collection is active, with a visible reason', () => {
    expect(canUseCollectionForRetrievalPreview(null, null)).toBe(false);
    expect(getRetrievalDisabledReason(null, null)).toMatch(/select a collection/i);
  });

  it('refuses a system-managed workspace-index collection, with a visible reason', () => {
    expect(canUseCollectionForRetrievalPreview('col-1', 'workspace-index')).toBe(false);
    expect(getRetrievalDisabledReason('col-1', 'workspace-index')).toMatch(
      /system-managed|workspace index/i
    );
  });

  it('never returns an empty reason while refusing (no silent refusal)', () => {
    for (const [id, role] of [
      [null, null],
      ['col-1', 'workspace-index'],
    ] as const) {
      const reason = getRetrievalDisabledReason(id, role);
      expect(reason).toBeTruthy();
      expect((reason ?? '').trim().length).toBeGreaterThan(10);
    }
  });
});

describe('formatSimilarityScore', () => {
  it('renders a fixed-precision percentage with the raw score for screen readers', () => {
    expect(formatSimilarityScore(0.8123)).toEqual({
      label: '81.23%',
      textEquivalent: 'Score 81.23 percent (0.8123)',
    });
  });

  it('clamps out-of-range scores rather than rendering nonsense', () => {
    expect(formatSimilarityScore(1.4).label).toBe('100.00%');
    expect(formatSimilarityScore(-0.2).label).toBe('0.00%');
  });

  it('keeps the label and its text equivalent in agreement for a non-finite score', () => {
    const formatted = formatSimilarityScore(Number.NaN);
    expect(formatted.label).toBe('0.00%');
    // The assistive text must not contradict the visible label by reporting NaN.
    expect(formatted.textEquivalent).not.toMatch(/nan/i);
    expect(formatted.textEquivalent).toBe('Score 0.00 percent (0)');
  });
});
