// A test double of the indexer's blob side (the real one is PR 5's derived store). It keeps the M0-A2 Indexer contract
// the purge orchestration relies on (spike src/indexer.ts, src/derived.ts):
//   - ONE serial queue: a purge's re-index runs after any pass already queued;
//   - it reads the truth only through SqliteReader, the read-only reader;
//   - reference counts are per (thread, seq) and counted only after catching up with every thread named;
//   - dropThread returns the hashes the dropped thread referenced;
//   - reset closes every handle it holds on the root.
// It stores no FTS or vectors, so it proves nothing about the derived store's own purge (that is PR 5's).

import { blobsOf } from '../../src/run-log-format.mjs';
import { readAll, SqliteReader } from '../../src/sqlite-reader.js';
import type { IndexerPort } from '../../src/state-store.js';

export class TruthIndexer implements IndexerPort {
  private readonly reader: SqliteReader;
  private readonly refs = new Map<string, Map<number, readonly string[]>>();
  private readonly cursor = new Map<string, number>();
  private q: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(root: string) {
    this.reader = new SqliteReader(root);
  }

  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const p = this.q.then(() => {
      if (this.closed) {
        throw new Error('indexer is closed');
      }
      return fn();
    });
    this.q = p.catch(() => undefined);
    return p;
  }

  private pass(thread: string): void {
    let m = this.refs.get(thread);
    if (!m) {
      m = new Map();
      this.refs.set(thread, m);
    }
    const from = (this.cursor.get(thread) ?? 0) + 1;
    for (const it of this.reader.read(thread, from)) {
      if (it.kind === 'event') {
        m.set(it.seq, blobsOf(it.raw));
      }
      this.cursor.set(thread, it.kind === 'event' ? it.seq : (it.toSeq ?? it.fromSeq));
    }
  }

  private passAll(thread: string): void {
    for (;;) {
      const before = this.cursor.get(thread) ?? 0;
      this.pass(thread);
      if ((this.cursor.get(thread) ?? 0) === before) {
        return;
      }
    }
  }

  catchUp(threads: readonly string[]): Promise<void> {
    return this.enqueue(() => {
      for (const t of threads) {
        this.passAll(t);
      }
    });
  }

  reindex(threadId: string, seq: number): Promise<void> {
    return this.enqueue(() => {
      const it = readAll(this.reader, threadId).find((x) => x.kind === 'event' && x.seq === seq);
      if (it?.kind !== 'event') {
        throw new Error(`reindex: ${threadId}#${seq} not found in truth`);
      }
      this.refs.get(threadId)?.set(seq, blobsOf(it.raw));
    });
  }

  gcCheck(
    threads: readonly string[],
    hashes: readonly string[]
  ): Promise<Readonly<Record<string, number>>> {
    return this.enqueue(() => {
      for (const t of threads) {
        this.passAll(t);
      }
      const out: Record<string, number> = {};
      for (const h of hashes) {
        out[h] = 0;
      }
      for (const m of this.refs.values()) {
        for (const hs of m.values()) {
          for (const h of hs) {
            if (h in out) {
              out[h] = (out[h] ?? 0) + 1;
            }
          }
        }
      }
      return out;
    });
  }

  dropThread(threadId: string): Promise<readonly string[]> {
    return this.enqueue(() => {
      const hs = new Set<string>();
      for (const v of this.refs.get(threadId)?.values() ?? []) {
        for (const h of v) {
          hs.add(h);
        }
      }
      this.refs.delete(threadId);
      this.cursor.delete(threadId);
      return [...hs];
    });
  }

  reset(): Promise<void> {
    return this.enqueue(() => {
      this.reader.close();
      this.closed = true;
    });
  }

  close(): void {
    this.reader.close();
  }
}
