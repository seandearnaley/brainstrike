import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedStorage } from '../debounced-storage';

const baseAdapter = {
  async getItem(_k: string) {
    return null;
  },
  async setItem(_k: string, _v: string) {},
  async removeItem(_k: string) {},
  async clear() {},
  async getAllKeys() {
    return [];
  },
};

describe('createDebouncedStorage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { window?: unknown }).window = undefined;
    (globalThis as { localStorage?: unknown }).localStorage = undefined;
  });

  it('debounces setItem calls', async () => {
    const spy = vi.fn();
    const adapter = { ...baseAdapter, setItem: spy };
    const debounced = createDebouncedStorage(adapter, { debounceMs: 50 });

    debounced.setItem('a', '1');
    debounced.setItem('a', '2');

    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(51);
    await Promise.resolve();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('a', '2');
  });

  it('flushes pending value on beforeunload when enabled', async () => {
    interface Listeners {
      beforeunload?: () => void;
    }
    const listeners: Listeners = {};
    const fakeWindow = {
      addEventListener: (e: string, fn: () => void) => {
        (listeners as Record<string, () => void>)[e] = fn;
      },
    } as Pick<Window, 'addEventListener'>;
    (globalThis as { window?: unknown }).window = fakeWindow as unknown as Window;
    const localSpy = vi.fn();
    (globalThis as { localStorage?: unknown }).localStorage = { setItem: localSpy };

    const adapter = { ...baseAdapter };
    const debounced = createDebouncedStorage(adapter, {
      flushOnBeforeUnload: true,
      debounceMs: 50,
    });

    debounced.setItem('k', 'v');
    listeners.beforeunload?.();

    expect(localSpy).toHaveBeenCalledWith('k', 'v');
  });
});
