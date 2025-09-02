import { describe, expect, it } from 'vitest';
import {
  ACTIVE_EMBEDDING_SET_KEY,
  getActiveEmbeddingSetId,
  setActiveEmbeddingSetId,
} from '../vector-preferences';

describe('vector-preferences', () => {
  it('returns null when localStorage is unavailable', () => {
    const prev = global.localStorage;
    // simulate server env
    (global as Record<string, unknown>)['localStorage'] = undefined;
    expect(getActiveEmbeddingSetId()).toBeNull();
    // restore
    (global as Record<string, unknown>)['localStorage'] = prev;
  });

  it('sets, gets, and clears the active embedding set id', () => {
    const store = new Map<string, string>();
    // simple localStorage shim
    (global as Record<string, unknown>)['localStorage'] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };

    expect(getActiveEmbeddingSetId()).toBeNull();
    setActiveEmbeddingSetId('set-1');
    expect(getActiveEmbeddingSetId()).toBe('set-1');

    setActiveEmbeddingSetId(null);
    expect(getActiveEmbeddingSetId()).toBeNull();

    // Also verify raw storage key
    expect(store.has(ACTIVE_EMBEDDING_SET_KEY)).toBe(false);
  });
});
