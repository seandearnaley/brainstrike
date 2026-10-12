// Append-only run_events log in PGlite. The RunHost is the ONLY writer.
// Per-thread monotonic seq; writes are serialized through one promise chain.
// B4: payload is `json` (not `jsonb`): stored text is the exact JSON.stringify output, so object KEY ORDER (and therefore
// every byte a model projection re-serializes) survives the round trip. jsonb normalizes key order.
import { PGlite } from '@electric-sql/pglite';
import type { UIMessageChunk } from 'ai';
import { DirLock, type DirLockEvents } from './dir-lock.js';
import type { HostEvent } from './events.js';

export interface LogRow {
  threadId: string;
  seq: number;
  event: HostEvent;
  /** raw (pre-coalescing) chunk count for ui.chunk rows — used by F3 to align with the live stream */
  rawCount?: number;
  /** wall-clock append time (ms since epoch) */
  ts?: number;
}

export class RunEventLog {
  private seqByThread = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  /** B2: PGlite 0.5.8 spins at 100% CPU forever when closed during an in-flight query: reads are tracked, close drains them, later use throws */
  private inflight = new Set<Promise<unknown>>();
  private closed = false;
  private track<T>(q: () => Promise<T>): Promise<T> { if (this.closed) return Promise.reject(new Error('RunEventLog is closed')); const p = q(); this.inflight.add(p); void p.finally(() => this.inflight.delete(p)).catch(() => {}); return p; }

  private constructor(readonly db: PGlite, readonly lock: DirLock | null, readonly startParams: string[]) {}

  /** S-DUR: start params for the log's PGlite. fsync on = PGlite.defaultStartParams minus '-F' (pglite.ts:149-170).
   *  NOTE (D1): on NODEFS (PGlite 0.5.8) fsync=on reaches no OS sync call; it is pinned by test/d1-fsync.test.ts. */
  static startParams(o: LogOpenOptions = {}): string[] {
    const base = (o.fsync ?? true) ? PGlite.defaultStartParams.filter((p) => p !== '-F') : [...PGlite.defaultStartParams];
    return [...base, ...Object.entries(o.gucs ?? {}).flatMap(([k, v]) => ['-c', `${k}=${v}`])];
  }

  static async open(dataDir?: string, o: LogOpenOptions = {}): Promise<RunEventLog> {
    // D5: a file-backed dir is exclusively owned (PGlite has no dir lock: electric-sql/pglite#1106)
    const lock = dataDir && (o.lock ?? true) ? DirLock.acquire(dataDir, o.lockEvents) : null;
    const startParams = RunEventLog.startParams(o);
    let db: PGlite | undefined;
    try {
      db = dataDir ? await PGlite.create(dataDir, { startParams }) : await PGlite.create({ startParams });
      await db.exec(`CREATE TABLE IF NOT EXISTS run_events (
        thread_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, run_id text,
        payload json NOT NULL, raw_count integer, created_at double precision NOT NULL,
        PRIMARY KEY (thread_id, seq))`);
      const log = new RunEventLog(db, lock, startParams);
      if (o.checkpoint) log.checkpointPolicy = { ...o.checkpoint, lastCheckAt: performance.now(), sinceLsn: await log.walLsn() };
      return log;
    } catch (e) {
      if (db && !db.closed) await db.close(); // never release the lock while this process still has the dir open
      lock?.release();
      throw e;
    }
  }

  // ---------- D4: checkpoint policy (PGlite 0.4.4+ has no checkpointer: WAL grows without bound otherwise) ----------
  private checkpointPolicy: (CheckpointPolicy & { lastCheckAt: number; sinceLsn: bigint }) | null = null;
  readonly checkpoints: Array<{ at: number; walBytes: number; ms: number }> = [];
  async walLsn(): Promise<bigint> {
    const r = await this.db.query<{ lsn: string }>('SELECT pg_current_wal_insert_lsn()::text AS lsn');
    const [hi, lo] = r.rows[0]!.lsn.split('/');
    return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
  }
  /** runs inside the append chain, after the batch committed and was published */
  private async maybeCheckpoint() {
    const p = this.checkpointPolicy;
    if (!p) return;
    const now = performance.now();
    if (now - p.lastCheckAt < p.checkEveryMs) return;
    p.lastCheckAt = now;
    const lsn = await this.walLsn();
    const walBytes = Number(lsn - p.sinceLsn);
    if (walBytes < p.walBytes) return;
    const t0 = performance.now();
    await this.db.query('CHECKPOINT');
    this.checkpoints.push({ at: t0, walBytes, ms: performance.now() - t0 });
    p.sinceLsn = await this.walLsn();
  }

  private async nextSeq(threadId: string): Promise<number> {
    let cur = this.seqByThread.get(threadId);
    if (cur === undefined) {
      const r = await this.db.query<{ m: number | null }>('SELECT max(seq) AS m FROM run_events WHERE thread_id = $1', [threadId]);
      cur = r.rows[0]?.m ?? 0;
    }
    this.seqByThread.set(threadId, cur + 1);
    return cur + 1;
  }

  /** Append rows (possibly across threads) in ONE statement; returns assigned rows. Serialized.
   *  S-DUR: `onCommitted` runs inside the serialized chain right after the statement's implicit COMMIT returned
   *  (single-statement autocommit: query() resolves after ReadyForQuery), before the next append starts. */
  append(items: Array<{ threadId: string; event: HostEvent; rawCount?: number }>, onCommitted?: () => void): Promise<LogRow[]> {
    if (this.closed) return Promise.reject(new Error('RunEventLog is closed'));
    const run = async () => {
      if (items.length === 0) { onCommitted?.(); return []; }
      const rows: LogRow[] = [];
      for (const it of items) rows.push({ threadId: it.threadId, seq: await this.nextSeq(it.threadId), event: it.event, rawCount: it.rawCount });
      const now = Date.now();
      const recs = rows.map((r) => ({
        thread_id: r.threadId, seq: r.seq, type: r.event.type,
        run_id: 'runId' in r.event ? (r.event as { runId: string }).runId : null,
        payload: r.event, raw_count: r.rawCount ?? null, created_at: now,
      }));
      await this.db.query(
        `INSERT INTO run_events (thread_id, seq, type, run_id, payload, raw_count, created_at)
         SELECT thread_id, seq, type, run_id, payload, raw_count, created_at FROM json_to_recordset($1::json)
         AS x(thread_id text, seq integer, type text, run_id text, payload json, raw_count integer, created_at double precision)`,
        [JSON.stringify(recs)],
      );
      onCommitted?.();
      await this.maybeCheckpoint();
      return rows;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async read(threadId: string, afterSeq = 0): Promise<LogRow[]> {
    const r = await this.track(() => this.db.query<{ seq: number; payload: HostEvent; raw_count: number | null; created_at: number }>(
      'SELECT seq, payload, raw_count, created_at FROM run_events WHERE thread_id = $1 AND seq > $2 ORDER BY seq', [threadId, afterSeq]));
    return r.rows.map((x) => ({ threadId, seq: x.seq, event: x.payload, rawCount: x.raw_count ?? undefined, ts: x.created_at }));
  }

  async threads(): Promise<string[]> {
    const r = await this.track(() => this.db.query<{ thread_id: string }>('SELECT DISTINCT thread_id FROM run_events ORDER BY thread_id'));
    return r.rows.map((x) => x.thread_id);
  }

  async close() { this.closed = true; await this.chain; await Promise.allSettled([...this.inflight]); await this.db.close(); this.lock?.release(); }
}

export interface CheckpointPolicy {
  /** CHECKPOINT once this much WAL was written since the last one */
  walBytes: number;
  /** how often (at most) the WAL position is sampled, piggybacked on appends */
  checkEveryMs: number;
}
export interface LogOpenOptions {
  /** PostgreSQL fsync GUC (default true = PGlite defaults minus '-F'). Inert on NODEFS 0.5.8: see report D1. */
  fsync?: boolean;
  /** extra `-c name=value` start params */
  gucs?: Record<string, string>;
  /** D5 data-directory lock for file-backed dirs (default true) */
  lock?: boolean;
  lockEvents?: DirLockEvents;
  /** D4 periodic CHECKPOINT policy (default off) */
  checkpoint?: CheckpointPolicy;
}

/** Merge adjacent deltas of the same part (text/reasoning/tool-input) — lossless for the fold. */
export function mergeChunk(batch: UIMessageChunk[], c: UIMessageChunk): void {
  const last = batch[batch.length - 1];
  if (last && last.type === c.type) {
    if ((c.type === 'text-delta' || c.type === 'reasoning-delta') && last.type === c.type && last.id === c.id && !c.providerMetadata && !last.providerMetadata) {
      last.delta += c.delta;
      return;
    }
    if (c.type === 'tool-input-delta' && last.type === 'tool-input-delta' && last.toolCallId === c.toolCallId) {
      last.inputTextDelta += c.inputTextDelta;
      return;
    }
  }
  batch.push({ ...c } as UIMessageChunk);
}

interface Pending { threadId: string; runId: string; chunks: UIMessageChunk[]; rawCount: number; enqueuedAt: number[] }
interface Shown { threadId: string; runId: string; c: UIMessageChunk; at: number }

/** S-DUR D2: when the UI (listeners) sees a chunk relative to its log commit.
 *  'before-commit' = B4 behaviour (shown at publish, committed up to flushMs + commit later).
 *  'after-commit'  = shown only after the batch holding it committed; order == publish order. */
export type PublishMode = 'before-commit' | 'after-commit';
export type Deliver = (threadId: string, runId: string, c: UIMessageChunk) => void;

/**
 * Coalesces ui.chunk events: one row per (run, flush window), adjacent deltas merged.
 * Boundary events (interactions, run.*) go through appendNow which flushes the thread's pending
 * chunks FIRST in the same statement, so log order == publish order.
 */
export class Coalescer {
  private pending: Pending[] = [];
  private shown: Shown[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** enqueue -> commit (ms), per raw chunk */
  readonly latencies: number[] = [];
  readonly flushDurations: number[] = [];
  /** publish -> handed to listeners (ms), per displayed chunk (D2 display latency) */
  readonly displayLatencies: number[] = [];

  constructor(private log: RunEventLog, private flushMs = 20, readonly mode: PublishMode = 'after-commit', private deliver: Deliver = () => {}) {}

  push(threadId: string, runId: string, chunk: UIMessageChunk) {
    let p = this.pending.findLast((x) => x.threadId === threadId);
    if (!p || p.runId !== runId) {
      p = { threadId, runId, chunks: [], rawCount: 0, enqueuedAt: [] };
      this.pending.push(p);
    }
    mergeChunk(p.chunks, chunk);
    p.rawCount++;
    p.enqueuedAt.push(performance.now());
    this.arm();
  }

  /** Hand a chunk to the UI. after-commit: queued behind everything already pushed, delivered when the next batch commits
   *  (a chunk pushed earlier is in that batch or an earlier, already-committed one). Also used for live-only chunks. */
  show(threadId: string, runId: string, c: UIMessageChunk) {
    const at = performance.now();
    if (this.mode === 'before-commit') { this.deliver(threadId, runId, c); this.displayLatencies.push(performance.now() - at); return; }
    this.shown.push({ threadId, runId, c, at });
    this.arm();
  }

  private arm() { if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.flushMs); }

  /** Flush everything pending (+ optional boundary events appended after them, + chunks to show for them). */
  async flush(extra: Array<{ threadId: string; event: HostEvent; rawCount?: number }> = [], extraShown: Array<{ threadId: string; runId: string; c: UIMessageChunk }> = []): Promise<LogRow[]> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const batch = this.pending;
    this.pending = [];
    for (const x of extraShown) this.show(x.threadId, x.runId, x.c);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const shown = this.shown;
    this.shown = [];
    const items = [
      ...batch.map((p) => ({ threadId: p.threadId, event: { type: 'ui.chunk', runId: p.runId, chunks: p.chunks } as HostEvent, rawCount: p.rawCount })),
      ...extra,
    ];
    const t0 = performance.now();
    const rows = await this.log.append(items, shown.length ? () => {
      for (const x of shown) { this.deliver(x.threadId, x.runId, x.c); this.displayLatencies.push(performance.now() - x.at); }
    } : undefined);
    const t1 = performance.now();
    this.flushDurations.push(t1 - t0);
    for (const p of batch) for (const at of p.enqueuedAt) this.latencies.push(t1 - at);
    return rows;
  }

  appendNow(threadId: string, event: HostEvent, rawCount?: number, shown?: Array<{ threadId: string; runId: string; c: UIMessageChunk }>) { return this.flush([{ threadId, event, rawCount }], shown); }
}
