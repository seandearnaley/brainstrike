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

  *read(id: string, fromSeq: number): Generator<ReadItem> {
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
          'SELECT seq, payload, crc FROM run_events WHERE thread_id = ? AND seq >= ? ORDER BY seq LIMIT ?'
        )
        .iterate(id, expected, READ_LIMIT) as IterableIterator<Row>;
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
