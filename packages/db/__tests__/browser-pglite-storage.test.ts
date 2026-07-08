import { afterEach, vi } from 'vitest';
import {
  enumerationUnavailableLegacyNames,
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
  const originalNavigator = g.navigator;

  afterEach(() => {
    g.indexedDB = originalIndexedDB;
    g.navigator = originalNavigator;
    vi.restoreAllMocks();
  });

  it('keeps reclaiming OPFS entries when one removeEntry throws (per-entry guard)', async () => {
    g.indexedDB = { deleteDatabase: vi.fn() };
    const removeEntry = vi.fn((name: string) =>
      name === 'app' ? Promise.reject(new Error('held by another tab')) : Promise.resolve()
    );
    async function* keys() {
      yield 'app';
      yield 'app-pg17';
      yield 'app-pg18';
      yield 'other';
    }
    g.navigator = {
      storage: { getDirectory: () => Promise.resolve({ keys, removeEntry } as unknown) },
    };

    await reclaimLegacyBrowserPGliteStorage('idb://app-pg18');

    // The throw on 'app' must not abort reclaiming the remaining 'app-pg17'.
    expect(removeEntry).toHaveBeenCalledWith('app', { recursive: true });
    expect(removeEntry).toHaveBeenCalledWith('app-pg17', { recursive: true });
    expect(removeEntry).not.toHaveBeenCalledWith('app-pg18', { recursive: true });
    expect(removeEntry).not.toHaveBeenCalledWith('other', { recursive: true });
  });

  it('reclaims only OLDER same-base variants — unversioned + lower majors, never current or newer', async () => {
    // PGlite's idb backend (Emscripten IDBFS) names the actual IndexedDB database
    // `/pglite/<dataDir>` — NOT the bare data-dir name — so reclaim must match and
    // delete the prefixed names. (Verified empirically against pglite 0.5.1.)
    const deleteDatabase = vi.fn();
    g.indexedDB = {
      databases: () =>
        Promise.resolve([
          { name: '/pglite/app' }, // legacy unversioned (oldest) → reclaim
          { name: '/pglite/app-pg17' }, // older major → reclaim
          { name: '/pglite/app-pg18' }, // in-use → keep
          { name: '/pglite/app-pg19' }, // NEWER major (e.g. a newer build) → keep
          { name: '/pglite/appendix' }, // different base → keep
          { name: 'brainstrike-desktop' }, // non-pglite store (no /pglite/ prefix) → keep
        ]),
      deleteDatabase,
    };

    await reclaimLegacyBrowserPGliteStorage('idb://app-pg18');

    expect(deleteDatabase).toHaveBeenCalledWith('/pglite/app');
    expect(deleteDatabase).toHaveBeenCalledWith('/pglite/app-pg17');
    expect(deleteDatabase).not.toHaveBeenCalledWith('/pglite/app-pg18');
    // An older build must NOT background-delete a newer build's data.
    expect(deleteDatabase).not.toHaveBeenCalledWith('/pglite/app-pg19');
    expect(deleteDatabase).not.toHaveBeenCalledWith('/pglite/appendix');
    expect(deleteDatabase).not.toHaveBeenCalledWith('brainstrike-desktop');
  });

  it('falls back to deleting the /pglite/-prefixed base name when enumeration is unavailable', async () => {
    const deleteDatabase = vi.fn();
    g.indexedDB = { deleteDatabase }; // no databases()

    await reclaimLegacyBrowserPGliteStorage('idb://app-pg18');

    expect(deleteDatabase).toHaveBeenCalledWith('/pglite/app');
    expect(deleteDatabase).not.toHaveBeenCalledWith('/pglite/app-pg18');
    // Must target the real (prefixed) name, not the bare one (a no-op vs pglite).
    expect(deleteDatabase).not.toHaveBeenCalledWith('app');
  });

  it('derives the /pglite/-prefixed name for non-default db names (e.g. web)', async () => {
    const deleteDatabase = vi.fn();
    g.indexedDB = { deleteDatabase };

    await reclaimLegacyBrowserPGliteStorage('opfs-ahp://web-pg18');

    expect(deleteDatabase).toHaveBeenCalledWith('/pglite/web');
  });

  it('does nothing for a non-versioned or non-persistent dir, and never throws', async () => {
    const deleteDatabase = vi.fn();
    g.indexedDB = { deleteDatabase };

    await expect(reclaimLegacyBrowserPGliteStorage('memory://app')).resolves.toBeUndefined();
    await expect(reclaimLegacyBrowserPGliteStorage('idb://app')).resolves.toBeUndefined();
    expect(deleteDatabase).not.toHaveBeenCalled();
  });
});

describe('enumerationUnavailableLegacyNames', () => {
  it('returns only the unversioned base at the first versioned major (nothing older is versioned)', () => {
    expect(enumerationUnavailableLegacyNames('app', 18)).toEqual(['app']);
  });

  it('includes every older VERSIONED major so a prior orphan is not leaked without enumeration', () => {
    // After a second bump (pg18 -> pg19), the prior versioned `app-pg18` must be
    // reclaimable on browsers that can't list storage — not just the unversioned base.
    expect(enumerationUnavailableLegacyNames('app', 19)).toEqual(['app', 'app-pg18']);
    expect(enumerationUnavailableLegacyNames('app', 20)).toEqual(['app', 'app-pg18', 'app-pg19']);
  });

  it('never includes the current or a newer major (forward-only)', () => {
    const names = enumerationUnavailableLegacyNames('app', 19);
    expect(names).not.toContain('app-pg19');
    expect(names).not.toContain('app-pg20');
  });

  it('respects non-default base names', () => {
    expect(enumerationUnavailableLegacyNames('web', 20)).toEqual(['web', 'web-pg18', 'web-pg19']);
  });
});
