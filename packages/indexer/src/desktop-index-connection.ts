import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';
import { SqliteReader } from '@brainstrike/state-store';
import Database from 'better-sqlite3';
import type { IndexConnection } from './index-connection.ts';
import { validateIndexerOptions } from './transport.ts';

/**
 * The writer's index: its options' file, opened by better-sqlite3, and the
 * state root's own read-only truth reader. Every refusal that needs no
 * database is made before the file is created.
 */
export function openDesktopIndex(input: unknown): IndexConnection {
  const options = validateIndexerOptions(input);
  const fresh = !existsSync(options.dbPath);
  mkdirSync(path.dirname(options.dbPath), { recursive: true });
  return {
    db: new Database(options.dbPath),
    fresh,
    owner: { pid: process.pid, writerThreadId: threadId },
    truth: new SqliteReader(options.stateRoot),
  };
}
