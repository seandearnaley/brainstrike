import { useVectorStatusUIStore } from '@brainstrike/preferences';
import { addLogListener, LogLevel, type LogRecord } from '@brainstrike/utils/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_EMBEDDING_SET_KEY,
  getActiveEmbeddingSetId,
  setActiveEmbeddingSetId,
} from '../vector-preferences';

describe('vector-preferences', () => {
  const capturedWarnings: LogRecord[] = [];
  let removeLogListener: () => void;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    // Reset store
    useVectorStatusUIStore.setState({ activeEmbeddingSetId: null });
    capturedWarnings.length = 0;
    removeLogListener = addLogListener((record) => {
      if (record.scope === 'VectorPreferences' && record.level === LogLevel.WARN) {
        capturedWarnings.push(record);
      }
    });
  });

  afterEach(() => {
    removeLogListener();
    vi.unstubAllGlobals();
  });

  /**
   * Replace the global localStorage with a Map-backed stand-in where selected
   * operations throw. happy-dom's localStorage is a Proxy (prototype spies
   * never fire and instance spies cannot be restored), so failure injection
   * must go through vi.stubGlobal.
   */
  function stubThrowingLocalStorage(failing: ReadonlyArray<'getItem' | 'setItem' | 'removeItem'>) {
    const backing = new Map<string, string>();
    const fail = (operation: string) => {
      throw new Error(`localStorage ${operation} error`);
    };
    vi.stubGlobal('localStorage', {
      clear: () => backing.clear(),
      getItem: (key: string) =>
        failing.includes('getItem') ? fail('getItem') : (backing.get(key) ?? null),
      key: (index: number) => [...backing.keys()][index] ?? null,
      get length() {
        return backing.size;
      },
      removeItem: (key: string) => {
        if (failing.includes('removeItem')) {
          fail('removeItem');
        }
        backing.delete(key);
      },
      setItem: (key: string, value: string) => {
        if (failing.includes('setItem')) {
          fail('setItem');
        }
        backing.set(key, value);
      },
    });
  }

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

    it('surfaces localStorage read failures via logger and returns null', () => {
      useVectorStatusUIStore.setState({ activeEmbeddingSetId: null });
      stubThrowingLocalStorage(['getItem']);

      expect(getActiveEmbeddingSetId()).toBeNull();
      expect(capturedWarnings).toHaveLength(1);
      expect(capturedWarnings[0]?.args[0]).toContain('read');
    });

    it('propagates store read failures instead of silently falling back', () => {
      vi.spyOn(useVectorStatusUIStore, 'getState').mockImplementation(() => {
        throw new Error('Store error');
      });

      expect(() => getActiveEmbeddingSetId()).toThrow('Store error');
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

    it('propagates store write failures instead of silently swallowing them', () => {
      vi.spyOn(useVectorStatusUIStore, 'getState').mockImplementation(() => {
        throw new Error('Store error');
      });

      expect(() => setActiveEmbeddingSetId('test-789')).toThrow('Store error');
    });

    it('surfaces localStorage write failures via logger while store still updates', () => {
      stubThrowingLocalStorage(['setItem']);
      const events: Event[] = [];
      const listener = (event: Event) => {
        events.push(event);
      };
      window.addEventListener('brainstrike:embedding-set-updated', listener);

      expect(() => setActiveEmbeddingSetId('test-789')).not.toThrow();

      window.removeEventListener('brainstrike:embedding-set-updated', listener);
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('test-789');
      expect(capturedWarnings).toHaveLength(1);
      expect(capturedWarnings[0]?.args[0]).toContain('persist');
      // The update event still fires so listeners can react to the store update.
      expect(events).toHaveLength(1);
    });

    it('surfaces localStorage remove failures via logger while store still updates', () => {
      stubThrowingLocalStorage(['removeItem']);
      localStorage.setItem(ACTIVE_EMBEDDING_SET_KEY, 'old-value');

      expect(() => setActiveEmbeddingSetId(null)).not.toThrow();
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBeNull();
      expect(capturedWarnings).toHaveLength(1);
    });

    it('surfaces dispatch failures via logger after store and localStorage update', () => {
      vi.spyOn(window, 'dispatchEvent').mockImplementation(() => {
        throw new Error('dispatch failed');
      });

      expect(() => setActiveEmbeddingSetId('set-789')).not.toThrow();
      expect(useVectorStatusUIStore.getState().activeEmbeddingSetId).toBe('set-789');
      expect(localStorage.getItem(ACTIVE_EMBEDDING_SET_KEY)).toBe('set-789');
      expect(capturedWarnings).toHaveLength(1);
      expect(capturedWarnings[0]?.args[0]).toContain('dispatch');
    });

    it('dispatches brainstrike:embedding-set-updated event when setting id', () => {
      const events: Event[] = [];
      const listener = (event: Event) => {
        events.push(event);
      };
      window.addEventListener('brainstrike:embedding-set-updated', listener);

      setActiveEmbeddingSetId('set-123');

      window.removeEventListener('brainstrike:embedding-set-updated', listener);
      expect(events).toHaveLength(1);
      const dispatched = events[0] as CustomEvent<{ id?: string; reason?: string }>;
      expect(dispatched.detail?.id).toBe('set-123');
      expect(dispatched.detail?.reason).toBe('selected');
    });

    it('dispatches brainstrike:embedding-set-updated event when clearing id', () => {
      const events: Event[] = [];
      const listener = (event: Event) => {
        events.push(event);
      };
      window.addEventListener('brainstrike:embedding-set-updated', listener);

      setActiveEmbeddingSetId(null);

      window.removeEventListener('brainstrike:embedding-set-updated', listener);
      expect(events).toHaveLength(1);
      const dispatched = events[0] as CustomEvent<{ id?: string }>;
      expect(dispatched.detail?.id).toBeNull();
    });
  });
});
