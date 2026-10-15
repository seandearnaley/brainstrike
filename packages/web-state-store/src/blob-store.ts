/**
 * The browser writer's content-addressed blobs: the desktop writer's blob
 * directory (`writer-worker.mjs` putBlob/unlinkBlobs), as rows of their own
 * database in the store's OPFS pool, which Factory Reset removes whole.
 *
 * SQLite rather than one OPFS file per blob, because the shared state
 * projection decodes rows synchronously (`@brainstrike/agent-host`'s
 * host-state-producer): a spooled body or a run snapshot is read in the same
 * call that reads its row. `synchronous = FULL` makes a stored blob durable
 * before the append that names it commits, as desktop's fsync does. Every read
 * verifies the bytes against their hash.
 */
import { sha256Hex } from '@brainstrike/utils/crypto';
import type { SqliteWasmDatabase } from './sqlite-wasm-database';

const HASH = /^[a-f0-9]{64}$/;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder('utf-8', { fatal: true });

export const BLOB_SCHEMA = `CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
  content BLOB NOT NULL
) STRICT`;

function checkedHash(hash: string): string {
  if (!HASH.test(hash)) {
    throw new Error(`invalid blob hash ${hash}`);
  }
  return hash;
}

export class SqliteBlobStore {
  /** `db` is the pool's blob database; the store configures it and keeps it open. */
  constructor(readonly db: SqliteWasmDatabase) {
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(BLOB_SCHEMA);
  }

  /** Stores `content` under `hash`; an existing blob is kept after its bytes are verified. */
  put(hash: string, content: string): void {
    const bytes = utf8.encode(content);
    if (!HASH.test(hash) || sha256Hex(bytes) !== hash) {
      throw new Error('blob hash does not match its content');
    }
    if (this.stored(hash)) {
      this.verify(hash);
      return;
    }
    this.db.prepare('INSERT INTO blobs (hash, content) VALUES (?, ?)').run(hash, bytes);
  }

  /** Throws unless `hash` names a stored blob whose bytes still hash to it. */
  verify(hash: string): void {
    this.bytes(hash);
  }

  /** A stored blob's verified bytes. */
  bytes(hash: string): Uint8Array {
    const bytes = this.stored(hash);
    if (!bytes) {
      throw new Error(`event references missing blob ${hash}`);
    }
    if (sha256Hex(bytes) !== hash) {
      throw new Error(`blob ${hash} checksum mismatch`);
    }
    return bytes;
  }

  /** The blob's text, verified; null when it is larger than `maxBytes`. */
  read(hash: string, maxBytes: number): string | null {
    const size = this.db
      .prepare('SELECT length(content) FROM blobs WHERE hash = ?')
      .pluck()
      .get(checkedHash(hash));
    if (typeof size !== 'number') {
      throw new Error(`blob ${hash} is missing`);
    }
    return size > maxBytes ? null : fromUtf8.decode(this.bytes(hash));
  }

  /** Removes the named blobs that exist; returns the hashes actually removed. */
  unlink(hashes: readonly string[]): string[] {
    const remove = this.db.prepare('DELETE FROM blobs WHERE hash = ?');
    return this.db.transaction(() =>
      hashes.filter((hash) => remove.run(checkedHash(hash)).changes > 0)
    )();
  }

  close(): void {
    this.db.close();
  }

  private stored(hash: string): Uint8Array | undefined {
    const content = this.db
      .prepare('SELECT content FROM blobs WHERE hash = ?')
      .pluck()
      .get(checkedHash(hash));
    return content instanceof Uint8Array ? content : undefined;
  }
}
