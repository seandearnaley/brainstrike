// The read-only truth reader (M0-A2 src/sqlite-log.ts SqliteReader): the indexer's own read-only connection to a data
// root's state DB. Damage is reported as explicit gaps, never a silent skip.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isCorrupt } from './run-log.mjs';
import { verified } from './run-log-format.mjs';
import { type Db, openRo } from './sqlite.js';

/** What a reader yields: a verified record, or an explicit gap where records could not be verified. */
export type ReadItem =
  | { readonly kind: 'event'; readonly seq: number; readonly raw: string }
  | {
      readonly kind: 'gap';
      readonly fromSeq: number;
      readonly toSeq: number | null;
      readonly reason: string;
    };

/** Authoritative Memory binding, checked in a short read-only snapshot. */
export interface MemoryThreadBinding {
  readonly resourceId: string;
  readonly threadId: string;
}
/** Existing native OM row, with its relational owner checked before projection. */
export interface MemoryObservationRecord {
  readonly id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly resourceId: string;
  readonly threadId: string | null;
}

interface Row {
  readonly crc: number;
  readonly payload: string;
  readonly seq: number;
}

/** Rows per `read` call. Bounded so that no read transaction stays open while a caller awaits between calls. */
export const READ_LIMIT = 2000;

export class SqliteReader {
  private db: Db | null = null;
  private readonly path: string;

  constructor(root: string) {
    this.path = join(root, 'state.db');
  }

  private conn(): Db | null {
    if (this.db && !existsSync(this.path)) {
      throw new Error('State truth database does not exist');
    }
    if (!this.db && existsSync(this.path)) {
      this.db = openRo(this.path);
    }
    return this.db;
  }

  threads(): string[] {
    const db = this.conn();
    if (!db) {
      return [];
    }
    return (
      db.prepare('SELECT DISTINCT thread_id AS t FROM run_events ORDER BY t').all() as Array<{
        t: string;
      }>
    ).map((r) => r.t);
  }

  watermark(id: string): number {
    const db = this.conn();
    if (!db) {
      throw new Error('State truth database does not exist');
    }
    const seq: unknown = db
      .prepare('SELECT COALESCE(MAX(seq),0) FROM run_events WHERE thread_id=?')
      .pluck()
      .get(id);
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error('State truth has an invalid sequence watermark');
    }
    return seq;
  }

  *read(id: string, fromSeq: number, toSeq = Number.MAX_SAFE_INTEGER): Generator<ReadItem> {
    const db = this.conn();
    if (!db) {
      return;
    }
    let expected = Math.max(1, fromSeq);
    // Rows are materialized (bounded) before anything is yielded, so no read transaction stays open while the caller
    // awaits: an open reader would pin the WAL and block a purge's TRUNCATE checkpoint.
    const rows: Row[] = [];
    let corrupt: string | null = null;
    try {
      const it = db
        .prepare(
          'SELECT seq, payload, crc FROM run_events WHERE thread_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?'
        )
        .iterate(id, expected, toSeq, READ_LIMIT) as IterableIterator<Row>;
      for (const r of it) {
        rows.push(r);
      }
    } catch (e) {
      if (!isCorrupt(e)) {
        throw e;
      }
      corrupt = String((e as Error).message); // rows before the damaged page are kept; nothing after it is reachable
    }
    for (const r of rows) {
      if (r.seq > expected) {
        yield {
          fromSeq: expected,
          kind: 'gap',
          reason: `missing seq ${expected}..${r.seq - 1}`,
          toSeq: r.seq - 1,
        };
      }
      if (verified(r)) {
        yield { kind: 'event', raw: r.payload, seq: r.seq };
      } else {
        yield { fromSeq: r.seq, kind: 'gap', reason: 'row crc mismatch', toSeq: r.seq };
      }
      expected = r.seq + 1;
    }
    if (corrupt) {
      yield { fromSeq: expected, kind: 'gap', reason: corrupt, toSeq: null };
    }
  }

  /** No vendor payload field can authorize a different relational owner. */
  memoryThreads(resourceId: string): readonly MemoryThreadBinding[] {
    const db = this.conn();
    if (!db) {
      throw new Error('State truth database does not exist');
    }
    const rows = db
      .prepare(`
      SELECT e.id, e.thread_id AS threadId, e.resource_id AS resourceId, e.payload
      FROM brainstrike_memory_entities e JOIN threads t ON t.id=e.thread_id
      WHERE e.kind='thread' AND e.resource_id=? ORDER BY e.id
    `)
      .all(resourceId) as Array<{
      id: string;
      threadId: string;
      resourceId: string;
      payload: string;
    }>;
    return rows.map((row) => {
      const payload: unknown = JSON.parse(row.payload);
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('id' in payload) ||
        payload.id !== row.id ||
        !('resourceId' in payload) ||
        payload.resourceId !== row.resourceId ||
        row.id !== row.threadId ||
        row.resourceId !== resourceId
      ) {
        throw new Error('State Memory thread/resource binding is invalid');
      }
      return { resourceId: row.resourceId, threadId: row.threadId };
    });
  }

  /** Read existing native OM witnesses; no caller metadata can change their relational owner. */
  memoryObservations(resourceId: string): readonly MemoryObservationRecord[] {
    const db = this.conn();
    if (!db) {
      throw new Error('State truth database does not exist');
    }
    const rows = db
      .prepare(`
      SELECT id,thread_id AS threadId,resource_id AS resourceId,payload
      FROM brainstrike_memory_entities WHERE kind='observation' AND resource_id=? ORDER BY id
    `)
      .all(resourceId) as Array<{
      id: string;
      threadId: string | null;
      resourceId: string;
      payload: string;
    }>;
    const threads = new Set(this.memoryThreads(resourceId).map((row) => row.threadId));
    return rows.map((row) => {
      const payload: unknown = JSON.parse(row.payload);
      if (
        typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        !('id' in payload) ||
        payload.id !== row.id ||
        !('resourceId' in payload) ||
        payload.resourceId !== row.resourceId ||
        !('threadId' in payload) ||
        payload.threadId !== row.threadId ||
        !('scope' in payload) ||
        payload.scope !== (row.threadId === null ? 'resource' : 'thread') ||
        row.resourceId !== resourceId ||
        (row.threadId !== null && !threads.has(row.threadId))
      ) {
        throw new Error('State Memory observation/resource binding is invalid');
      }
      return {
        id: row.id,
        payload: payload as Readonly<Record<string, unknown>>,
        resourceId: row.resourceId,
        threadId: row.threadId,
      };
    });
  }

  /** Materialize one verified committed snapshot; never retain it across an await. */
  snapshot<T>(read: () => T): T {
    const db = this.conn();
    if (!db) {
      throw new Error('State truth database does not exist');
    }
    return db.transaction(read)();
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/** Every verified item of a thread (the reader is bounded per call). */
export function* readAll(reader: SqliteReader, thread: string): Generator<ReadItem> {
  let from = 1;
  for (;;) {
    let n = 0;
    for (const it of reader.read(thread, from)) {
      n++;
      from = (it.kind === 'event' ? it.seq : (it.toSeq ?? it.fromSeq)) + 1;
      yield it;
      if (it.kind === 'gap' && it.toSeq === null) {
        return;
      }
    }
    if (n === 0) {
      return;
    }
  }
}
