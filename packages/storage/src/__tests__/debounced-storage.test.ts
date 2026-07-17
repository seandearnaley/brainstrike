import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedStorageAdapter } from '../debounced-storage';

interface TestStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

function createStorage(): TestStorage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

describe('createDebouncedStorageAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces rapid writes per key and persists the latest value', () => {
    vi.useFakeTimers();
    const inner = createStorage();
    const storage = createDebouncedStorageAdapter(inner, { delayMs: 500 });

    storage.setItem('one', 'first');
    storage.setItem('one', 'second');
    storage.setItem('one', 'last');

    expect(inner.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(inner.setItem).toHaveBeenCalledTimes(1);
    expect(inner.setItem).toHaveBeenCalledWith('one', 'last');
  });

  it('flushes pending writes immediately', () => {
    vi.useFakeTimers();
    const inner = createStorage();
    const storage = createDebouncedStorageAdapter(inner, { delayMs: 500 });

    storage.setItem('one', 'pending');
    storage.flush();

    expect(inner.setItem).toHaveBeenCalledTimes(1);
    expect(inner.setItem).toHaveBeenCalledWith('one', 'pending');
    vi.runAllTimers();
    expect(inner.setItem).toHaveBeenCalledTimes(1);
  });

  it('returns a buffered value instead of stale inner storage', () => {
    vi.useFakeTimers();
    const inner = createStorage();
    inner.setItem('one', 'stale');
    const storage = createDebouncedStorageAdapter(inner, { delayMs: 500 });

    storage.setItem('one', 'pending');

    expect(storage.getItem('one')).toBe('pending');
  });

  it('flushes pending writes on pagehide', () => {
    vi.useFakeTimers();
    const inner = createStorage();
    const storage = createDebouncedStorageAdapter(inner, { delayMs: 500 });
    storage.setItem('one', 'pending');

    window.dispatchEvent(new Event('pagehide'));

    expect(inner.setItem).toHaveBeenCalledTimes(1);
    expect(inner.setItem).toHaveBeenCalledWith('one', 'pending');
  });
});
