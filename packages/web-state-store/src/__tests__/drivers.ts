import sqlite3InitModule, { type Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import BetterSqlite3 from 'better-sqlite3';
import { asBetterSqlite3, SqliteWasmDatabase } from '../sqlite-wasm-database';

let engine: Promise<Sqlite3Static> | undefined;

/** sqlite-wasm's Node build, loaded once per test file. */
export function loadSqliteWasm(): Promise<Sqlite3Static> {
  engine ??= sqlite3InitModule();
  return engine;
}

/**
 * The same work on the desktop driver (better-sqlite3) and on the browser
 * writer's (sqlite-wasm through `SqliteWasmDatabase`), each on a fresh
 * in-memory database. `before` runs ahead of each driver's work, so state the
 * work depends on (generated ids, the clock) starts the same for both.
 */
export function bothDrivers<T>(
  sqlite3: Sqlite3Static,
  work: (db: BetterSqlite3.Database) => T,
  before: () => void = () => undefined
): { desktop: T; web: T } {
  const desktop = new BetterSqlite3(':memory:');
  const web = new SqliteWasmDatabase(sqlite3, new sqlite3.oo1.DB(':memory:'), ':memory:');
  // Both writers turn foreign keys on; better-sqlite3 is built with them on by default, the official wasm build is not.
  desktop.pragma('foreign_keys = ON');
  web.pragma('foreign_keys = ON');
  try {
    before();
    const desktopResult = work(desktop);
    before();
    return { desktop: desktopResult, web: work(asBetterSqlite3(web)) };
  } finally {
    desktop.close();
    web.close();
  }
}

/** A throw's identity as both drivers report it: the error's name and SQLite code. */
export function caught(fn: () => unknown): { code?: unknown; name: string } {
  try {
    fn();
  } catch (error) {
    return { code: (error as { code?: unknown }).code, name: (error as Error).name };
  }
  throw new Error('expected a throw');
}
