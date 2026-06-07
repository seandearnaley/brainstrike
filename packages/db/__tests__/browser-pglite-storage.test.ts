import { afterEach, vi } from 'vitest';
import {
  getDefaultBrowserPGliteDataDir,
  getRecommendedBrowserPGliteStorage,
  isBrowserPersistentPGliteDataDir,
  isIndexedDbPGliteDataDir,
  isOpfsAhpPGliteDataDir,
  PGLITE_DATA_DIR_VERSION,
  reclaimLegacyBrowserPGliteStorage,
} from '../src/browser-pglite-storage.js';

describe('browser PGlite storage selection', () => {
  it('keeps IndexedDB as the default browser storage backend', () => {
    expect(getDefaultBrowserPGliteDataDir()).toBe('idb://app-pg18');
    expect(getRecommendedBrowserPGliteStorage({ hasOpfsDirectory: true, hasWorker: true })).toEqual(
      {
        dataDir: 'idb://app-pg18',
        reason: 'pglite-recommends-indexeddb',
        storage: 'idb',
      }
    );
  });

  it('distinguishes explicit IndexedDB selection from the default recommendation', () => {
    expect(
      getRecommendedBrowserPGliteStorage({
        hasOpfsDirectory: true,
        hasWorker: true,
        requestedStorage: 'idb',
      })
    ).toEqual({
      dataDir: 'idb://app-pg18',
      reason: 'requested-indexeddb',
      storage: 'idb',
    });
  });

  it('allows OPFS AHP as an explicit worker-only opt-in when supported', () => {
    expect(
      getRecommendedBrowserPGliteStorage({
        hasOpfsDirectory: true,
        hasWorker: true,
        requestedStorage: 'opfs-ahp',
      })
    ).toEqual({
      dataDir: 'opfs-ahp://app-pg18',
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
      dataDir: 'idb://app-pg18',
      reason: 'requested-opfs-ahp-unavailable',
      storage: 'idb',
    });
  });

  it('versions persistent browser data dirs by Postgres engine major so PG18 never opens a PG17 directory', () => {
    // PG17 -> PG18 changes the on-disk format; an unversioned dir name would be
    // reused across engine majors and fail to initialize. The version suffix forces
    // a clean greenfield directory per engine major.
    expect(PGLITE_DATA_DIR_VERSION).toBe('pg18');
    expect(getDefaultBrowserPGliteDataDir()).toContain(`-${PGLITE_DATA_DIR_VERSION}`);
    expect(getDefaultBrowserPGliteDataDir('web')).toBe(`idb://web-${PGLITE_DATA_DIR_VERSION}`);
  });

  it('classifies persistent browser storage schemes explicitly', () => {
    expect(isIndexedDbPGliteDataDir('idb://app-pg18')).toBe(true);
    expect(isOpfsAhpPGliteDataDir('opfs-ahp://app-pg18')).toBe(true);
    expect(isBrowserPersistentPGliteDataDir('idb://app-pg18')).toBe(true);
    expect(isBrowserPersistentPGliteDataDir('opfs-ahp://app-pg18')).toBe(true);
    expect(isBrowserPersistentPGliteDataDir('memory://app-pg18')).toBe(false);
  });
});

describe('reclaimLegacyBrowserPGliteStorage', () => {
  const g = globalThis as unknown as {
    indexedDB?: {
      deleteDatabase: (name: string) => unknown;
      databases?: () => Promise<{ name?: string }[]>;
    };
    navigator?: { storage?: { getDirectory?: () => Promise<unknown> } };
  };
  const originalIndexedDB = g.indexedDB;

  afterEach(() => {
    g.indexedDB = originalIndexedDB;
    vi.restoreAllMocks();
  });

  it('reclaims EVERY same-base variant except the in-use one (all prior majors + unversioned)', async () => {
    // The key forward-looking case: on a later major (e.g. pg19) the prior
    // versioned dirs (app-pg18) must also be reclaimed, not just unversioned app.
    const deleteDatabase = vi.fn();
    g.indexedDB = {
      deleteDatabase,
      databases: () =>
        Promise.resolve([
          { name: 'app' }, // legacy unversioned
          { name: 'app-pg17' }, // hypothetical prior major
          { name: 'app-pg18' }, // in-use → must be kept
          { name: 'appendix' }, // different base → must be kept
          { name: 'other' },
        ]),
    };

    await reclaimLegacyBrowserPGliteStorage('idb://app-pg18');

    expect(deleteDatabase).toHaveBeenCalledWith('app');
    expect(deleteDatabase).toHaveBeenCalledWith('app-pg17');
    expect(deleteDatabase).not.toHaveBeenCalledWith('app-pg18');
    expect(deleteDatabase).not.toHaveBeenCalledWith('appendix');
    expect(deleteDatabase).not.toHaveBeenCalledWith('other');
  });

  it('falls back to deleting the unversioned base name when enumeration is unavailable', async () => {
    const deleteDatabase = vi.fn();
    g.indexedDB = { deleteDatabase }; // no databases()

    await reclaimLegacyBrowserPGliteStorage('idb://app-pg18');

    expect(deleteDatabase).toHaveBeenCalledWith('app');
    expect(deleteDatabase).not.toHaveBeenCalledWith('app-pg18');
  });

  it('derives the base name for non-default db names (e.g. web)', async () => {
    const deleteDatabase = vi.fn();
    g.indexedDB = { deleteDatabase };

    await reclaimLegacyBrowserPGliteStorage('opfs-ahp://web-pg18');

    expect(deleteDatabase).toHaveBeenCalledWith('web');
  });

  it('does nothing for a non-versioned or non-persistent dir, and never throws', async () => {
    const deleteDatabase = vi.fn();
    g.indexedDB = { deleteDatabase };

    await expect(reclaimLegacyBrowserPGliteStorage('memory://app')).resolves.toBeUndefined();
    await expect(reclaimLegacyBrowserPGliteStorage('idb://app')).resolves.toBeUndefined();
    expect(deleteDatabase).not.toHaveBeenCalled();
  });
});
