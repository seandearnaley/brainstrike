/**
 * The only pg_textsearch engine version qualified for Brainstrike's local
 * PGlite runtime. Version 1.3.x introduced the persisted paged-memtable
 * design implicated in the corruption quarantined by migration 065. That
 * quarantine was against pglite-pg_textsearch@0.0.5's bundle of extension
 * 1.3.1.
 *
 * BST-1063 (PGlite 0.5.4 bump) re-qualified exactly this same extension
 * version 1.3.1, now bundled by pglite-pg_textsearch@0.0.6 (the only member
 * of the 0.5.4-compatible package family) after:
 *   - packages/db/__tests__/pg-textsearch-durability-gate.integration.test.ts
 *     passing 6/6 consecutive runs (5 default-config + 1 heavier stress
 *     config: 100 cycles / 4 writers / 200 rows-per-writer) on macOS arm64.
 *     This is GREENFIELD evidence: the gate builds its BM25 index under
 *     1.3.1 from the start. It qualifies 1.3.1 for new installs only.
 *   - 3/3 clean trials of the mixed-version path (a data dir with a BM25
 *     index created under pglite-pg_textsearch@0.0.4 / extversion 1.2.0,
 *     reopened and churned — inserts/updates/deletes/VACUUM/BM25 search —
 *     under the 0.0.6 / 1.3.1 binary, index staying valid throughout). The
 *     script was never committed; under the greenfield ruling below, the
 *     only population that path covers is PRE-BUMP DEVELOPMENT DATABASES,
 *     which the ruling explicitly accepts (reset on misbehaviour).
 * Neither trial was run on Linux or Windows, and no CI lane exercises this
 * opt-in gate on any platform. Do not raise this to a version pg_textsearch
 * has not shipped, and do not treat single-platform local evidence as a
 * substitute for the doc's "every supported desktop platform" bar before
 * loosening this guard further.
 *
 * EXISTING-INSTALL GAP: RESOLVED BY RULING, not by code (BST-1081,
 * Canceled 2026-08-02). The structural facts below remain true — migration
 * 066 is keyed by a fixed ledger string and never re-runs for an
 * already-migrated database, nothing calls `ALTER EXTENSION UPDATE`, and no
 * runtime code compares the catalog's extversion against the loaded binary.
 * The ruling: Brainstrike is a GREENFIELD app with no existing installs, so
 * the population that gap could affect is empty. The first public build
 * ships this 0.5.4/1.3.1 family, every future install runs migration 066
 * against it, and no install can ever be in the 1.2.0-catalog/1.3.1-binary
 * mixed state. The only databases predating this bump are development ones;
 * if a pre-bump dev DB misbehaves in search, reset it (or drop and recreate
 * `idx_file_chunks_content_bm25`) rather than debugging the mixed state —
 * the BM25 index is derived data. If Brainstrike ever ships an upgrade path
 * from a pre-1.3.1 database (it has not), BST-1081's analysis is the spec
 * for what that migration must do: `ALTER EXTENSION UPDATE` alone relabels
 * without reconciling index pages (the 1.2.0→1.3.0 upgrade SQL is
 * catalog-only, verified against the npm tarball) — the index must be
 * rebuilt under the new binary, backed by a committed existing-install test.
 */
export const QUALIFIED_PG_TEXTSEARCH_VERSION = '1.3.1';
