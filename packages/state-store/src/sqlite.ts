// Read-only connections (M0-A2 src/sqlite.ts).
import Database from 'better-sqlite3';

export type Db = Database.Database;

/** A read-only connection. It never writes the truth (M0-A2 item 7: the indexer opens it read-only). */
export function openRo(path: string): Db {
  const db = new Database(path, { fileMustExist: true, readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}
