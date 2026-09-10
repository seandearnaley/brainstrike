import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPersistentUiState } from '../factory-reset';

const globalWindow = window as Window & typeof globalThis & { caches?: CacheStorage };

describe('factory reset clears the theme preference keys', () => {
  let originalCaches: CacheStorage | undefined;

  beforeEach(() => {
    originalCaches = globalWindow.caches;
    Object.defineProperty(globalWindow, 'caches', {
      configurable: true,
      value: {
        delete: async () => true,
        keys: async () => [] as string[],
      } as unknown as CacheStorage,
    });
    localStorage.setItem('app-theme', 'dark');
    localStorage.setItem('app-theme-palette', 'tide');
  });

  afterEach(() => {
    if (originalCaches) {
      Object.defineProperty(globalWindow, 'caches', { configurable: true, value: originalCaches });
    } else {
      Reflect.deleteProperty(globalWindow, 'caches');
    }
    localStorage.clear();
  });

  it('removes app-theme and app-theme-palette from localStorage', async () => {
    await clearPersistentUiState({ skipIndexedDb: true });
    expect(localStorage.getItem('app-theme')).toBeNull();
    expect(localStorage.getItem('app-theme-palette')).toBeNull();
  });
});
