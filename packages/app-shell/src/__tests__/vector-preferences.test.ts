import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_EMBEDDING_SET_KEY,
  getActiveEmbeddingSetId,
  setActiveEmbeddingSetId,
} from '../vector-preferences';

describe('vector-preferences', () => {
  beforeEach(() => {
    // Reset localStorage between tests
    localStorage.clear();
  });

  it('returns null when key not set', () => {
    expect(getActiveEmbeddingSetId()).toBeNull();
  });

  it('sets and gets active embedding set id', () => {
    setActiveEmbeddingSetId('set-123');
    expect(localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY)).toBe('set-123');
    expect(getActiveEmbeddingSetId()).toBe('set-123');
  });

  it('clears the id when null passed', () => {
    setActiveEmbeddingSetId('set-xyz');
    setActiveEmbeddingSetId(null);
    expect(localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY)).toBeNull();
    expect(getActiveEmbeddingSetId()).toBeNull();
  });
});
