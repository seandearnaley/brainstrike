import { sha256Hex } from '@brainstrike/utils/crypto';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqliteBlobStore } from '../blob-store';
import { SqliteWasmDatabase } from '../sqlite-wasm-database';
import { loadSqliteWasm } from './drivers';

let sqlite3: Sqlite3Static;
let files = 0;

beforeAll(async () => {
  sqlite3 = await loadSqliteWasm();
});

/** A blob database on the Node build's file system, as the writer opens one in its pool. */
function store(): SqliteBlobStore {
  const file = `/blobs-${++files}.db`;
  return new SqliteBlobStore(new SqliteWasmDatabase(sqlite3, new sqlite3.oo1.DB(file, 'c'), file));
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

describe('the browser blob store', () => {
  it('keeps a blob durably and reads it back verified', () => {
    const blobs = store();
    try {
      const content = `tool output ✓ ${'x'.repeat(20_000)}`;
      const hash = sha256Hex(content);
      blobs.put(hash, content);
      blobs.put(hash, content);
      expect(blobs.read(hash, 1_000_000)).toBe(content);
      expect(blobs.read(hash, 100)).toBeNull();
      expect(new TextDecoder().decode(blobs.bytes(hash))).toBe(content);
      expect(blobs.db.pragma('synchronous', { simple: true })).toBe(2);
      expect(blobs.db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      blobs.close();
    }
  });

  it('refuses a mismatched hash, a missing blob and damaged bytes', () => {
    const blobs = store();
    try {
      expect(message(() => blobs.put(sha256Hex('one'), 'two'))).toContain(
        'blob hash does not match its content'
      );
      const absent = 'a'.repeat(64);
      expect(message(() => blobs.verify(absent))).toContain(`missing blob ${absent}`);
      expect(message(() => blobs.verify('not-a-hash'))).toContain('invalid blob hash');
      const hash = sha256Hex('spooled bytes');
      blobs.put(hash, 'spooled bytes');
      blobs.db
        .prepare('UPDATE blobs SET content = ? WHERE hash = ?')
        .run(new TextEncoder().encode('other bytes'), hash);
      expect(message(() => blobs.verify(hash))).toContain(`blob ${hash} checksum mismatch`);
      expect(message(() => blobs.put(hash, 'spooled bytes'))).toContain('checksum mismatch');
      expect(message(() => blobs.read(hash, 1000))).toContain('checksum mismatch');
    } finally {
      blobs.close();
    }
  });

  it('unlinks only the blobs that exist', () => {
    const blobs = store();
    try {
      const hash = sha256Hex('collect me');
      blobs.put(hash, 'collect me');
      expect(blobs.unlink([hash, 'b'.repeat(64)])).toEqual([hash]);
      expect(message(() => blobs.verify(hash))).toContain('missing blob');
    } finally {
      blobs.close();
    }
  });
});
