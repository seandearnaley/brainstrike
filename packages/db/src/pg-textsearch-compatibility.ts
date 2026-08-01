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
 *   - 3/3 clean trials of the existing-user upgrade path: a data dir with a
 *     BM25 index created under pglite-pg_textsearch@0.0.4 (extversion
 *     1.2.0) reopened and continued (inserts/updates/deletes/VACUUM/BM25
 *     search) under the pglite-pg_textsearch@0.0.6 binary, with the index
 *     staying valid/ready throughout and pg_extension.extversion remaining
 *     '1.2.0' in the catalog (no ALTER EXTENSION UPDATE occurred or was
 *     needed for that path — see BST-1063 PR body for the full evidence).
 *     THIS SCRIPT WAS NEVER COMMITTED — it is not a repeatable test and does
 *     not run in CI. It is the only evidence for the scenario every existing
 *     install actually lands in after this bump (see below), and per
 *     AGENTS.md's rule that docs and their paired tests move together, that
 *     is a gap, not a footnote.
 * Neither trial was run on Linux or Windows, and no CI lane exercises this
 * opt-in gate on any platform. Do not raise this to a version pg_textsearch
 * has not shipped, and do not treat single-platform local evidence as a
 * substitute for the doc's "every supported desktop platform" bar before
 * ever loosening this guard further.
 *
 * UNRESOLVED, BLOCKS MERGE OF PR #2206 — existing installs are not covered
 * by this guard at all. `customMigration('custom-066-...', ...)` in
 * `packages/db/src/drizzle/migrate.ts` keys migration 066 in the Drizzle
 * ledger with a fixed string literal, not a digest of this migration's SQL
 * body. Any database that already recorded migration 66 will never re-run
 * it, no matter how this file's qualified version changes. That database's
 * `pg_extension.extversion` stays whatever it was when the extension was
 * first created (`'1.2.0'` for anyone who installed before this bump) —
 * nothing calls `ALTER EXTENSION UPDATE` — while the actual pg_textsearch
 * binary loaded at every PGlite construction site is now 1.3.1, because the
 * package pin is global. No runtime code anywhere compares the catalog's
 * recorded extversion against the loaded binary version; this constant is
 * referenced only by migration 066 and two tests, none of which run again
 * for an already-migrated database. Confirmed by reading
 * `packages/db/src/drizzle/migrate.ts` and `migration-runner.ts` directly,
 * not assumed. The 3-trial upgrade-path script above is suggestive that this
 * specific mismatch (1.3.1 binary operating on a 1.2.0-labeled, 1.2.0-built
 * index) does not corrupt data — but it is 3 runs on one platform with a
 * synthetic table, not the real `file_chunks` schema/repository code path,
 * and it is not committed. Separately: `pg_textsearch--1.2.0--1.3.0.sql`'s
 * real upgrade script (verified by extracting the actual npm tarball) only
 * creates/drops/alters SQL functions — it never touches index pages — so
 * even adding an explicit `ALTER EXTENSION UPDATE` migration would relabel
 * `extversion` without doing anything to reconcile the physical BM25 index
 * format between engines. A real fix needs one of: a runtime
 * catalog-vs-binary check that fails visibly instead of silently operating
 * on a mismatched index, or an explicit upgrade migration that updates the
 * extension AND rebuilds the index under the new binary, backed by a
 * COMMITTED test of the existing-install path — not more greenfield
 * evidence. Tracked as BST-1081 (blocking), filed against BST-1063's PR
 * (github.com/seandearnaley/brainstrike/pull/2206); do not merge that PR
 * until this is closed.
 */
export const QUALIFIED_PG_TEXTSEARCH_VERSION = '1.3.1';
