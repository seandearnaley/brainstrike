import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { openConnection } from '@brainstrike/sqlite-native';
import { SqliteReader } from '@brainstrike/state-store';
import { decoder, optionsSchema } from './contracts.js';
import type { IndexConnection, IndexReaderConnection } from './index-connection.js';
import { assertFreshOpen } from './options.js';
import { ScopeAuthority } from './scope-authority.js';
import { StateEventStore } from './state-event-store.js';
import type { StateProjection } from './state-projection.js';
import { validateIndexerOptions } from './transport.js';
import { sqliteVecEngine } from './vector-engine.js';

/**
 * The desktop writer's index: its options' file, opened by better-sqlite3
 * with sqlite-vec loaded, and the state root's own read-only truth reader.
 * Every refusal that needs no database is made before the file is created.
 */
export function openDesktopIndex(input: unknown, projection?: StateProjection): IndexConnection {
  const options = validateIndexerOptions(input);
  StateEventStore.assertProjection(options.stateRoot, projection);
  new ScopeAuthority(options);
  const fresh = !existsSync(options.dbPath);
  assertFreshOpen(options, fresh);
  mkdirSync(path.dirname(options.dbPath), { recursive: true });
  return {
    db: openConnection(options.dbPath),
    engine: sqliteVecEngine,
    fresh,
    owner: { pid: process.pid, writerThreadId: threadId },
    truth: options.stateRoot === undefined ? undefined : new SqliteReader(options.stateRoot),
  };
}

/** A desktop read-only connection to an existing index, as the coverage and search readers use. */
export function openDesktopIndexReader(input: unknown): IndexReaderConnection {
  const options = decoder(optionsSchema)(input);
  const db = openConnection(options.dbPath, { fileMustExist: true, readonly: true });
  try {
    db.pragma('query_only = ON');
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, engine: sqliteVecEngine };
}
