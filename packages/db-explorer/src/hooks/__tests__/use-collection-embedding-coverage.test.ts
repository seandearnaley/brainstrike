import { describe, expect, it } from 'vitest';
import type { CollectionEmbeddingCoverageSnapshot } from '../use-collection-embedding-coverage';

function resolveStatus(
  totalFiles: number,
  pendingReindexFileCount: number,
  chunksMissingSourceRange: number
): CollectionEmbeddingCoverageSnapshot['status'] {
  if (totalFiles === 0) {
    return 'idle';
  }
  if (pendingReindexFileCount > 0) {
    return 'needs_reindex';
  }
  if (chunksMissingSourceRange > 0) {
    return 'partial_source_ranges';
  }
  return 'fully_indexed';
}

describe('collection embedding coverage status', () => {
  it('reports idle when the collection has no files', () => {
    expect(resolveStatus(0, 0, 0)).toBe('idle');
  });

  it('reports needs_reindex when files lack processed chunks', () => {
    expect(resolveStatus(12, 4, 0)).toBe('needs_reindex');
  });

  it('reports partial_source_ranges when chunks lack line metadata', () => {
    expect(resolveStatus(8, 0, 3)).toBe('partial_source_ranges');
  });

  it('reports fully_indexed when files and chunks are line-aware', () => {
    expect(resolveStatus(5, 0, 0)).toBe('fully_indexed');
  });
});
