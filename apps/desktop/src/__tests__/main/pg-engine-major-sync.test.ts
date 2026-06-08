import { PGLITE_DATA_DIR_VERSION } from '@brainstrike/db/browser-pglite-storage';
import { describe, expect, it } from 'vitest';
import { BUNDLED_PG_MAJOR } from '../../pg-data-version';

/**
 * Cross-package drift guard. The bundled Postgres major is declared in two
 * packages — `BUNDLED_PG_MAJOR` (desktop, used by the PG_VERSION wipe guard) and
 * `PGLITE_DATA_DIR_VERSION` (db, used to version the browser data-dir name). They
 * MUST stay in lockstep: bumping one without the other reintroduces the exact
 * "failed to initialize" crash this guard exists to prevent (a PG19 engine that
 * no longer recognizes/wipes a PG18 data dir). They can't share a single runtime
 * constant because the Electron main process is isolated from `@brainstrike/db`,
 * so this test enforces the invariant instead. (The db constant is imported from
 * the PURE `browser-pglite-storage` subpath — no React/PGlite pulled in.)
 */
describe('engine-major cross-package sync', () => {
  it('keeps BUNDLED_PG_MAJOR (desktop) in lockstep with PGLITE_DATA_DIR_VERSION (db)', () => {
    expect(PGLITE_DATA_DIR_VERSION).toMatch(/^pg\d+$/);
    expect(`pg${BUNDLED_PG_MAJOR}`).toBe(PGLITE_DATA_DIR_VERSION);
  });
});
