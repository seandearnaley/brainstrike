import { useVectorStatusUIStore } from '@brainstrike/db-explorer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_EMBEDDING_SET_KEY,
  getActiveEmbeddingSetId,
  setActiveEmbeddingSetId,
} from '../vector-preferences';

describe('vector-preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    // Reset store
    useVectorStatusUIStore.setState({ activeEmbeddingSetId: null });
  });

  describe('getActiveEmbeddingSetId', () => {
    it('returns value from Zustand store when available', () => {
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: 'store-123' });
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, 'localStorage-456');

      expect(getActiveEmbeddingSetId()).toBe('store-123');
    });

    it('falls back to localStorage when store value is empty', () => {
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: '' });
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, 'localStorage-456');

      expect(getActiveEmbeddingSetId()).toBe('localStorage-456');
    });

    it('falls back to localStorage when store value is null', () => {
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: null });
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, 'localStorage-456');

      expect(getActiveEmbeddingSetId()).toBe('localStorage-456');
    });

    it('returns null when both store and localStorage are empty', () => {
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: null });
      expect(getActiveEmbeddingSetId()).toBeNull();
    });

    it('trims whitespace from store value', () => {
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: '  ' });
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, 'localStorage-456');

      expect(getActiveEmbeddingSetId()).toBe('localStorage-456');
    });

    it('trims whitespace from localStorage value', () => {
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: null });
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, '  ');

      expect(getActiveEmbeddingSetId()).toBeNull();
    });

    it('handles localStorage access errors gracefully', () => {
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: null });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('localStorage error');
      });

      expect(getActiveEmbeddingSetId()).toBeNull();
    });

    it('handles store access errors gracefully', () => {
      vi.spyOn(useVectorStatusUIStore, 'getState').mockImplementation(() => {
        throw new Error('Store error');
      });
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, 'localStorage-456');

      expect(getActiveEmbeddingSetId()).toBe('localStorage-456');
    });
  });

  describe('setActiveEmbeddingSetId', () => {
    it('sets value in both store and localStorage', () => {
      setActiveEmbeddingSetId('test-789');

      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('test-789');
      expect(localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY)).toBe('test-789');
    });

    it('removes value from both store and localStorage when null', () => {
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, 'old-value');
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: 'old-value' });

      setActiveEmbeddingSetId(null);

      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBeNull();
      expect(localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY)).toBeNull();
    });

    it('handles store write errors gracefully', () => {
      vi.spyOn(useVectorStatusUIStore, 'getState').mockImplementation(() => {
        throw new Error('Store error');
      });

      expect(() => setActiveEmbeddingSetId('test-789')).not.toThrow();
      expect(localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY)).toBe('test-789');
    });

    it('handles localStorage write errors gracefully', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('localStorage error');
      });

      expect(() => setActiveEmbeddingSetId('test-789')).not.toThrow();
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('test-789');
    });

    it('handles localStorage remove errors gracefully', () => {
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, 'old-value');
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('localStorage error');
      });

      expect(() => setActiveEmbeddingSetId(null)).not.toThrow();
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBeNull();
    });
  });
});
