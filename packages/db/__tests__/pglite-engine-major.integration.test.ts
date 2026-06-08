import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { PGLITE_ENGINE_MAJOR } from '../src/browser-pglite-storage.js';

/**
 * Reality anchor for the engine-major constants.
 *
 * `PGLITE_ENGINE_MAJOR` (db) and `BUNDLED_PG_MAJOR` (desktop) are hand-maintained
 * and only cross-checked against EACH OTHER by `pg-engine-major-sync.test.ts` —
 * neither was previously checked against the engine `@electric-sql/pglite`
 * actually bundles. That gap is a sharp footgun: a future PR that bumps the pinned
 * pglite to a PG19 release but forgets to bump the constants would let a fresh
 * install write `PG_VERSION=19`, which `isNewerPgDataDir()` then flags as "newer"
 * and `reconcileIncompatiblePgDataDir()` throws on — a hard, unrecoverable startup
 * failure on every boot instead of a clean greenfield.
 *
 * This test opens a real PGlite handle and asserts the live server-version major
 * equals `PGLITE_ENGINE_MAJOR`, so the constant can't silently drift from the
 * bundled engine. Combined with the cross-package drift test, desktop's
 * `BUNDLED_PG_MAJOR` is transitively anchored to reality too.
 */
describe('PGlite engine major anchor', () => {
  it('matches the major reported by an opened PGlite handle', async () => {
    const db = new PGlite({ dataDir: 'memory://' });
    try {
      const result = await db.query('SHOW server_version_num');
      const row = result.rows[0] as { server_version_num?: string } | undefined;
      const versionNum = Number(row?.server_version_num);
      expect(Number.isFinite(versionNum)).toBe(true);
      // server_version_num is MMmmpp (e.g. 180003 → major 18).
      const engineMajor = Math.floor(versionNum / 10_000);
      expect(engineMajor).toBe(PGLITE_ENGINE_MAJOR);
    } finally {
      await db.close();
    }
  });
});
