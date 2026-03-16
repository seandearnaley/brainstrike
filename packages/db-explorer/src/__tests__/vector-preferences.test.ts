import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('dispatches brainstrike:embedding-set-updated event when setting id', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');

    setActiveEmbeddingSetId('set-456');

    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe('brainstrike:embedding-set-updated');
    expect(event.detail).toEqual({ id: 'set-456', reason: 'selected' });

    spy.mockRestore();
  });

  it('dispatches event with null when clearing id', () => {
    const spy = vi.spyOn(window, 'dispatchEvent');

    setActiveEmbeddingSetId(null);

    expect(spy).toHaveBeenCalledTimes(1);
    const event = spy.mock.calls[0]?.[0] as CustomEvent;
    expect(event.type).toBe('brainstrike:embedding-set-updated');
    expect(event.detail).toEqual({ id: null, reason: 'selected' });

    spy.mockRestore();
  });

  it('keeps store and localStorage updated when dispatch throws', () => {
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
      throw new Error('dispatch failed');
    });

    expect(() => setActiveEmbeddingSetId('set-789')).not.toThrow();
    expect(localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY)).toBe('set-789');
    expect(getActiveEmbeddingSetId()).toBe('set-789');

    spy.mockRestore();
  });
});
