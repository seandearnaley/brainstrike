/**
 * Crash-sensitive index rebuild (BST-1871).
 *
 * Some index access methods keep on-disk state that Postgres WAL crash recovery
 * does NOT restore. pg_textsearch 1.3.1 (the only version
 * `@electric-sql/pglite-pg_textsearch` ships) is the known case: its BM25 index
 * free-space map is not WAL-logged, so after a SIGKILL the allocator can hand
 * out a block that a live structure still owns (timescale/pg_textsearch
 * #430/#426, fixed by #429 in 1.4.0). A `REINDEX` rebuilds the relation from the
 * heap and clears the stale state. Measured on the pinned builds: the BM25
 * index was broken on 9/15 reopens without a REINDEX and clean on 30/30 with one.
 *
 * This module is Node-safe and dependency-free: it owns the access-method
 * ledger, the catalog derivation and the rebuild. WHEN to call it (first open
 * after an unclean shutdown, before migrations) belongs to the host.
 */

/** Index access methods whose on-disk state is NOT restored by WAL crash recovery. */
export const CRASH_SENSITIVE_INDEX_ACCESS_METHODS = ['bm25'] as const;

const APPLICATION_SCHEMA = 'public';

/**
 * The narrowest handle the rebuild needs. A raw `PGlite` satisfies it as-is
 * (PGlite's `exec` accepts an optional options bag we never pass).
 */
export interface CrashSensitiveIndexDb {
  readonly exec: (sql: string) => Promise<unknown>;
  readonly query: <TRecord = unknown>(
    sql: string,
    params?: unknown[]
  ) => Promise<{ readonly rows: readonly TRecord[] }>;
}

export interface CrashSensitiveIndex {
  readonly accessMethod: string;
  readonly index: string;
  readonly table: string;
}

export interface CrashSensitiveIndexRebuild extends CrashSensitiveIndex {
  readonly durationMs: number;
}

export interface CrashSensitiveIndexRebuildResult {
  readonly rebuilt: readonly CrashSensitiveIndexRebuild[];
  readonly totalDurationMs: number;
}

/** A `REINDEX` failed. Indexes ordered before `index` were already rebuilt. */
export class CrashSensitiveIndexRebuildError extends Error {
  readonly index: string;

  constructor(index: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to rebuild crash-sensitive index "${index}": ${detail}`, { cause });
    this.name = 'CrashSensitiveIndexRebuildError';
    this.index = index;
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Derived from the catalog, never a hardcoded index-name list, so a new index
 * on a crash-sensitive access method is covered the moment a migration creates
 * it. Ordered by name so a rebuild pass is deterministic.
 */
export async function listCrashSensitiveIndexes(
  db: CrashSensitiveIndexDb
): Promise<readonly CrashSensitiveIndex[]> {
  const result = await db.query<CrashSensitiveIndex>(
    `SELECT c.relname::text AS "index", t.relname::text AS "table", am.amname::text AS "accessMethod"
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_am am ON am.oid = c.relam
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE am.amname = ANY($1::text[]) AND n.nspname = $2
     ORDER BY c.relname`,
    [[...CRASH_SENSITIVE_INDEX_ACCESS_METHODS], APPLICATION_SCHEMA]
  );
  return result.rows;
}

/**
 * `REINDEX`es every crash-sensitive index, one statement each. The first
 * failure throws {@link CrashSensitiveIndexRebuildError} naming the index; a
 * partial pass is never reported as success.
 */
export async function rebuildCrashSensitiveIndexes(
  db: CrashSensitiveIndexDb,
  clock: () => number = () => performance.now()
): Promise<CrashSensitiveIndexRebuildResult> {
  const passStart = clock();
  const rebuilt: CrashSensitiveIndexRebuild[] = [];
  for (const entry of await listCrashSensitiveIndexes(db)) {
    const started = clock();
    try {
      await db.exec(
        `REINDEX INDEX ${quoteIdentifier(APPLICATION_SCHEMA)}.${quoteIdentifier(entry.index)}`
      );
    } catch (error) {
      throw new CrashSensitiveIndexRebuildError(entry.index, error);
    }
    rebuilt.push({ ...entry, durationMs: clock() - started });
  }
  return { rebuilt, totalDurationMs: clock() - passStart };
}
