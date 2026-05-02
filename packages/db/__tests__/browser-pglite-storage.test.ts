import {
  getDefaultBrowserPGliteDataDir,
  getRecommendedBrowserPGliteStorage,
  isBrowserPersistentPGliteDataDir,
  isIndexedDbPGliteDataDir,
  isOpfsAhpPGliteDataDir,
} from '../src/browser-pglite-storage.js';

describe('browser PGlite storage selection', () => {
  it('keeps IndexedDB as the default browser storage backend', () => {
    expect(getDefaultBrowserPGliteDataDir()).toBe('idb://app');
    expect(getRecommendedBrowserPGliteStorage({ hasOpfsDirectory: true, hasWorker: true })).toEqual(
      {
        dataDir: 'idb://app',
        reason: 'pglite-recommends-indexeddb',
        storage: 'idb',
      }
    );
  });

  it('allows OPFS AHP as an explicit worker-only opt-in when supported', () => {
    expect(
      getRecommendedBrowserPGliteStorage({
        hasOpfsDirectory: true,
        hasWorker: true,
        requestedStorage: 'opfs-ahp',
      })
    ).toEqual({
      dataDir: 'opfs-ahp://app',
      reason: 'requested-opfs-ahp-supported',
      storage: 'opfs-ahp',
    });
  });

  it('falls OPFS requests back to IndexedDB when the browser cannot support OPFS AHP', () => {
    expect(
      getRecommendedBrowserPGliteStorage({
        hasOpfsDirectory: false,
        hasWorker: true,
        requestedStorage: 'opfs-ahp',
      })
    ).toEqual({
      dataDir: 'idb://app',
      reason: 'requested-opfs-ahp-unavailable',
      storage: 'idb',
    });
  });

  it('classifies persistent browser storage schemes explicitly', () => {
    expect(isIndexedDbPGliteDataDir('idb://app')).toBe(true);
    expect(isOpfsAhpPGliteDataDir('opfs-ahp://app')).toBe(true);
    expect(isBrowserPersistentPGliteDataDir('idb://app')).toBe(true);
    expect(isBrowserPersistentPGliteDataDir('opfs-ahp://app')).toBe(true);
    expect(isBrowserPersistentPGliteDataDir('memory://app')).toBe(false);
  });
});
