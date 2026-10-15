import { isCorrupt } from '@brainstrike/state-store/run-log';
import { migrate } from '@brainstrike/state-store/schema';
import { asBetterSqlite3, type SqliteWasmDatabase } from './sqlite-wasm-database';

export interface OpenedStateDb {
  /** The damage found at open, or null; a damaged DB is open `query_only`. */
  readonly damage: string | null;
  readonly db: SqliteWasmDatabase;
}

/**
 * ADR-0011's web PRAGMAs, then `integrity_check`. EXCLUSIVE comes before WAL,
 * so SQLite keeps the WAL index in heap memory; the VFS has no shared memory.
 * The rest match the desktop writer: NORMAL sync with FULL at step
 * boundaries, zeroed deletes, foreign keys and checkpoints only at
 * boundaries. Returns the integrity failure text, or null.
 */
function configure(db: SqliteWasmDatabase): string | null {
  // The desktop driver's default page size (the official wasm build's is 8192), so the 1,000-page checkpoint threshold
  // means the same WAL size on both. It takes effect only on a new, empty database.
  db.pragma('page_size = 4096');
  db.pragma('locking_mode = EXCLUSIVE');
  const journal = db.pragma('journal_mode = WAL', { simple: true });
  if (journal !== 'wal') {
    throw new Error(`state DB journal mode is ${String(journal)}, not wal`);
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('secure_delete = ON');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 0');
  // One row per problem, in a column SQLite names after the pragma.
  const rows = (db.pragma('integrity_check') as Record<string, unknown>[]).map((row) =>
    String(row['integrity_check'])
  );
  return rows.length === 1 && rows[0] === 'ok' ? null : rows.join('; ');
}

/**
 * Opens the state DB as the desktop writer does (`writer-worker.mjs`): if
 * any step of the open finds the file corrupt, it reopens read-only and
 * `query_only`, and says so. A damaged DB is never migrated or written.
 * `open(readOnly)` opens the file on the caller's VFS.
 */
export function openStateDb(open: (readOnly: boolean) => SqliteWasmDatabase): OpenedStateDb {
  let db: SqliteWasmDatabase | undefined;
  let damage: string | null;
  try {
    db = open(false);
    damage = configure(db);
  } catch (error) {
    db?.close();
    if (!isCorrupt(error)) {
      throw error;
    }
    db = open(true);
    damage = String((error as Error).message);
  }
  try {
    if (damage) {
      db.pragma('query_only = ON');
    } else {
      migrate(asBetterSqlite3(db));
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return { damage, db };
}
