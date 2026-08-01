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
 *   - 3/3 clean trials of the existing-user upgrade path: a data dir with a
 *     BM25 index created under pglite-pg_textsearch@0.0.4 (extversion
 *     1.2.0) reopened and continued (inserts/updates/deletes/VACUUM/BM25
 *     search) under the pglite-pg_textsearch@0.0.6 binary, with the index
 *     staying valid/ready throughout and pg_extension.extversion remaining
 *     '1.2.0' in the catalog (no ALTER EXTENSION UPDATE occurred or was
 *     needed for that path — see BST-1063 PR body for the full evidence).
 * Neither trial was run on Linux or Windows, and no CI lane exercises this
 * opt-in gate on any platform. Do not raise this to a version pg_textsearch
 * has not shipped, and do not treat single-platform local evidence as a
 * substitute for the doc's "every supported desktop platform" bar before
 * ever loosening this guard further.
 */
export const QUALIFIED_PG_TEXTSEARCH_VERSION = '1.3.1';
