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

/**
 * One crash-sensitive index with the sizes the catalog reports in O(1). A rebuild's duration
 * scales with the table's stored content, so the host manager derives its deadline for the
 * rebuild from `heapBytes + toastBytes`: the per-phase deadline rule lives in
 * `docs/agents/platform-contracts.md` § "Graceful shutdown ownership" (the DB host bullet), and
 * the size report in `docs/agents/database.md`'s crash-sensitive index rule. Mirrored by
 * `DatabaseCrashSensitiveIndex` in `@brainstrike/types`.
 */
export interface CrashSensitiveIndex {
  readonly accessMethod: string;
  /** `pg_relation_size` of the indexed table's heap. */
  readonly heapBytes: number;
  readonly index: string;
  /** `pg_relation_size` of the index itself. */
  readonly indexBytes: number;
  readonly schema: string;
  readonly table: string;
  /** `pg_relation_size` of the table's TOAST relation; 0 when the table has none. */
  readonly toastBytes: number;
}

export interface CrashSensitiveIndexRebuildOptions {
  readonly clock?: () => number;
  /**
   * Called synchronously before each index's `REINDEX`, with that index's catalog sizes. A REINDEX
   * is one synchronous WASM statement, so this is the last moment the host can tell its parent
   * what it is about to do. A throw aborts the pass before the statement, unwrapped.
   */
  readonly onBeforeIndex?: (entry: CrashSensitiveIndex) => void;
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
 * it. Every user schema is included: filtering to one schema would silently
 * skip an index created elsewhere. Ordered by schema then name so a rebuild
 * pass is deterministic.
 */
type CatalogIndexRow = Omit<CrashSensitiveIndex, 'heapBytes' | 'indexBytes' | 'toastBytes'> &
  Record<'heapBytes' | 'indexBytes' | 'toastBytes', unknown>;

/** `int8` reaches JS as a number while safe and as a bigint past 2^53: make the declared type true. */
function toByteCount(
  row: CatalogIndexRow,
  field: 'heapBytes' | 'indexBytes' | 'toastBytes'
): number {
  const value = row[field];
  const count = typeof value === 'bigint' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(
      `Crash-sensitive index ${row.schema}.${row.index} reported ${field} ${String(value)}, not a safe non-negative byte count.`
    );
  }
  return count;
}

export async function listCrashSensitiveIndexes(
  db: CrashSensitiveIndexDb
): Promise<readonly CrashSensitiveIndex[]> {
  const result = await db.query<CatalogIndexRow>(
    `SELECT n.nspname::text AS "schema", c.relname::text AS "index", t.relname::text AS "table",
            am.amname::text AS "accessMethod",
            pg_relation_size(i.indexrelid)::bigint AS "indexBytes",
            pg_relation_size(i.indrelid)::bigint AS "heapBytes",
            COALESCE(pg_relation_size(NULLIF(t.reltoastrelid, 0)), 0)::bigint AS "toastBytes"
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     JOIN pg_class t ON t.oid = i.indrelid
     JOIN pg_am am ON am.oid = c.relam
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE am.amname = ANY($1::text[])
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'
     ORDER BY n.nspname, c.relname`,
    [[...CRASH_SENSITIVE_INDEX_ACCESS_METHODS]]
  );
  return result.rows.map((row) => ({
    ...row,
    heapBytes: toByteCount(row, 'heapBytes'),
    indexBytes: toByteCount(row, 'indexBytes'),
    toastBytes: toByteCount(row, 'toastBytes'),
  }));
}

/**
 * `REINDEX`es every crash-sensitive index, one statement each. The first
 * failure throws {@link CrashSensitiveIndexRebuildError} naming the index; a
 * partial pass is never reported as success.
 */
export async function rebuildCrashSensitiveIndexes(
  db: CrashSensitiveIndexDb,
  options: CrashSensitiveIndexRebuildOptions = {}
): Promise<CrashSensitiveIndexRebuildResult> {
  const clock = options.clock ?? (() => performance.now());
  const passStart = clock();
  const rebuilt: CrashSensitiveIndexRebuild[] = [];
  for (const entry of await listCrashSensitiveIndexes(db)) {
    options.onBeforeIndex?.(entry);
    const started = clock();
    try {
      await db.exec(
        `REINDEX INDEX ${quoteIdentifier(entry.schema)}.${quoteIdentifier(entry.index)}`
      );
    } catch (error) {
      throw new CrashSensitiveIndexRebuildError(entry.index, error);
    }
    rebuilt.push({ ...entry, durationMs: clock() - started });
  }
  return { rebuilt, totalDurationMs: clock() - passStart };
}
