// @ts-check
// The run log on the writing connection: `run_events` in the state DB. Ported from M0-A2 src/sqlite-log.ts (per-row crc,
// contiguity verified on first use, damaged threads are read-only, physical purge) and M0-A1 src/store-sqlite-worker.mjs
// (the batch append and the step-boundary op). It runs only inside the writer worker (src/writer-worker.mjs), except in
// tests that time it on a connection of their own.

import { crcOf, verified, withSeq } from './run-log-format.mjs';
import { checkpointTruncate } from './sqlite-checkpoint.mjs';

/** @typedef {import('better-sqlite3').Database} Db */
/** @typedef {{ kind: 'ok'; tail: number } | { kind: 'damaged'; atSeq: number; error: string }} ThreadStatus */
/** @typedef {{ seq: number; payload: string; crc: number; rawCount: number | null; ts: number }} Row */
/** One appended row: [threadId, type, runId, body (event JSON without seq), rawCount]. */
/** @typedef {[string, string, string | null, string, number | null]} AppendRow */
/** @typedef {{ log: number; checkpointed: number; busy: number }} CheckpointRow */

/**
 * @param {unknown} e
 * @returns {boolean}
 */
export const isCorrupt = (e) => {
  const code = /** @type {{ code?: unknown }} */ (e).code;
  return typeof code === 'string' && /^SQLITE_(CORRUPT|NOTADB)/.test(code);
};

/** A refusal (a damaged thread cannot be written), not a write failure: it does not fail the store. */
export class ThreadReadOnlyRefusal extends Error {
  /**
   * @param {string} threadId
   * @param {string} why
   */
  constructor(threadId, why) {
    super(`thread ${threadId} is read-only: ${why}`);
    this.name = 'ThreadReadOnlyError';
    this.threadId = threadId;
  }
}

export class ThreadDamage extends Error {
  /**
   * @param {string} threadId
   * @param {number} atSeq
   * @param {string} detail
   */
  constructor(threadId, atSeq, detail) {
    super(`thread ${threadId} is damaged at seq ${atSeq}: ${detail}`);
    this.name = 'ThreadDamagedError';
    this.threadId = threadId;
    this.atSeq = atSeq;
    this.detail = detail;
  }
}

export class RunLog {
  /**
   * @param {Db} db the writing connection
   * @param {string | null} dbDamage the integrity_check failure text if the state DB was found damaged at open
   */
  constructor(db, dbDamage) {
    /** @private */
    this.db = db;
    /** @private */
    this.dbDamage = dbDamage;
    /**
     * @private
     * @type {Map<string, ThreadStatus>}
     */
    this.st = new Map();
  }

  /** @returns {string[]} */
  threads() {
    return /** @type {Array<{ t: string }>} */ (
      this.db.prepare('SELECT DISTINCT thread_id AS t FROM run_events ORDER BY t').all()
    ).map((r) => r.t);
  }

  /**
   * Verifies every row of the thread (contiguity + crc) on first use: damage is found at open, not later.
   * @param {string} id
   * @returns {ThreadStatus}
   */
  status(id) {
    const have = this.st.get(id);
    if (have) {
      return have;
    }
    let expected = 1;
    /** @type {ThreadStatus | null} */
    let s = null;
    try {
      const rows = /** @type {IterableIterator<Row>} */ (
        this.db
          .prepare('SELECT seq, payload, crc FROM run_events WHERE thread_id = ? ORDER BY seq')
          .iterate(id)
      );
      for (const r of rows) {
        if (r.seq !== expected) {
          s = {
            atSeq: expected,
            error: `seq ${r.seq} where ${expected} expected`,
            kind: 'damaged',
          };
          break;
        }
        if (!verified(r)) {
          s = { atSeq: expected, error: 'row crc mismatch', kind: 'damaged' };
          break;
        }
        expected++;
      }
    } catch (e) {
      if (!isCorrupt(e)) {
        throw e;
      }
      s = { atSeq: expected, error: String(/** @type {Error} */ (e).message), kind: 'damaged' };
    }
    if (!s && this.dbDamage) {
      s = { atSeq: expected, error: `database damaged: ${this.dbDamage}`, kind: 'damaged' };
    }
    /** @type {ThreadStatus} */
    const out = s ?? { kind: 'ok', tail: expected - 1 };
    this.st.set(id, out);
    return out;
  }

  /**
   * Appends rows (possibly across threads) as ONE transaction. Every thread of the batch must be undamaged, or nothing
   * is written (a refusal). Seqs are taken from each thread's verified tail and the cached tails move only after COMMIT,
   * so a failed transaction never skips a seq.
   * @param {AppendRow[]} rows
   * @param {number} now
   * @param {boolean} boundary whether this transaction also commits its durable boundary marker
   * @returns {number[]}
   */
  append(rows, now, boundary = false) {
    /** @type {Map<string, number>} */
    const tails = new Map();
    for (const [t] of rows) {
      if (tails.has(t)) {
        continue;
      }
      const s = this.status(t);
      if (s.kind !== 'ok') {
        throw new ThreadReadOnlyRefusal(t, s.error);
      }
      tails.set(t, s.tail);
    }
    const ins = this.db.prepare(
      'INSERT INTO run_events (thread_id, seq, type, run_id, payload, crc, raw_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    /** @type {number[]} */
    const seqs = [];
    const next = new Map(tails);
    this.db.transaction(() => {
      for (const [t, type, runId, body, rawCount] of rows) {
        const seq = (next.get(t) ?? 0) + 1;
        next.set(t, seq);
        const payload = withSeq(seq, body);
        ins.run(t, seq, type, runId, payload, crcOf(payload), rawCount, now);
        this.db
          .prepare(
            'INSERT INTO threads (id,last_seq,created_at,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seq=excluded.last_seq, updated_at=excluded.updated_at'
          )
          .run(t, seq, now, now);
        seqs.push(seq);
      }
      if (boundary) {
        const mark = this.db.prepare(
          'INSERT INTO run_sync (thread_id, seq, at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET seq = excluded.seq, at = excluded.at'
        );
        for (const [threadId, tail] of next) {
          mark.run(threadId, tail, now);
        }
      }
    })();
    for (const [t, tail] of next) {
      this.st.set(t, { kind: 'ok', tail });
    }
    return seqs;
  }

  /**
   * Verified rows from `fromSeq` (at most `limit`). Damage before the end throws ThreadDamage after the rows before it.
   * @param {string} id
   * @param {number} fromSeq
   * @param {number} limit
   * @returns {{ rows: Row[]; damage: ThreadDamage | null }}
   */
  readFrom(id, fromSeq, limit) {
    const s = this.status(id);
    const from = Math.max(1, fromSeq);
    if (s.kind === 'damaged' && from >= s.atSeq) {
      return { damage: new ThreadDamage(id, s.atSeq, s.error), rows: [] };
    }
    const last = s.kind === 'ok' ? s.tail : s.atSeq - 1;
    let expected = from;
    /** @type {Row[]} */
    const rows = [];
    try {
      const it = /** @type {IterableIterator<Row>} */ (
        this.db
          .prepare(
            'SELECT seq, payload, crc, raw_count AS rawCount, created_at AS ts FROM run_events WHERE thread_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?'
          )
          .iterate(id, from, last, limit)
      );
      for (const r of it) {
        if (r.seq !== expected || !verified(r)) {
          /** @type {ThreadStatus} */
          const d = {
            atSeq: expected,
            error: r.seq === expected ? 'row crc mismatch' : `missing seq ${expected}`,
            kind: 'damaged',
          };
          this.st.set(id, d);
          return { damage: new ThreadDamage(id, expected, d.error), rows };
        }
        expected++;
        rows.push(r);
      }
    } catch (e) {
      if (!isCorrupt(e)) {
        throw e;
      }
      const error = String(/** @type {Error} */ (e).message);
      this.st.set(id, { atSeq: expected, error, kind: 'damaged' });
      return { damage: new ThreadDamage(id, expected, error), rows };
    }
    if (s.kind === 'damaged' && rows.length < limit) {
      return { damage: new ThreadDamage(id, s.atSeq, s.error), rows };
    }
    return { damage: null, rows };
  }

  /**
   * Replace event `seq` with `tombstoneRaw` so that no byte of the old event remains in the state DB files.
   * @param {string} id
   * @param {number} seq
   * @param {string} tombstoneRaw
   * @param {(() => void) | undefined} inTxn
   * @returns {void}
   */
  purge(id, seq, tombstoneRaw, inTxn) {
    const s = this.status(id);
    if (s.kind !== 'ok') {
      throw new ThreadReadOnlyRefusal(id, s.error);
    }
    if (!tombstoneRaw.startsWith(`{"seq":${seq},`)) {
      throw new Error('purge: tombstone must carry the purged seq');
    }
    this.db.transaction(() => {
      const r = this.db
        .prepare(
          'UPDATE run_events SET payload = ?, crc = ?, type = ?, run_id = NULL WHERE thread_id = ? AND seq = ?'
        )
        .run(tombstoneRaw, crcOf(tombstoneRaw), 'purged', id, seq);
      if (r.changes !== 1) {
        throw new Error(`purge: ${id} has no seq ${seq}`);
      }
      inTxn?.();
    })();
    checkpointTruncate(this.db);
  }

  /**
   * @param {string} id
   * @param {(() => void) | undefined} [beforeDelete]
   * @returns {void}
   */
  deleteThread(id, beforeDelete) {
    this.db.transaction(() => {
      beforeDelete?.();
      this.db.prepare('DELETE FROM run_events WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM run_sync WHERE thread_id = ?').run(id);
      this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
    })();
    this.st.delete(id);
    checkpointTruncate(this.db);
  }

  /**
   * The OS-crash contract at a step boundary (M0-A1): probe the WAL with `wal_checkpoint(NOOP)` ("does not checkpoint
   * any frames. It is used to obtain the returned values only"); once it holds `checkpointPages` frames or more run an
   * application-initiated PASSIVE checkpoint; then ONE `synchronous=FULL` commit of a marker row. "With synchronous=FULL
   * in WAL mode, an additional sync operation of the WAL file happens after each transaction commit" (pragma
   * synchronous), and the WAL is one file, so that sync also covers every earlier NORMAL commit.
   * @param {string} threadId
   * @param {'boundary' | 'sqlite-auto'} walCheckpoint
   * @param {number} checkpointPages
   * @returns {{ before: CheckpointRow; after: CheckpointRow } | null}
   */
  boundary(threadId, walCheckpoint, checkpointPages) {
    /** @type {{ before: CheckpointRow; after: CheckpointRow } | null} */
    let checkpoint = null;
    if (walCheckpoint === 'boundary') {
      const probe = /** @type {CheckpointRow[]} */ (this.db.pragma('wal_checkpoint(NOOP)'))[0];
      if (probe && probe.log >= checkpointPages) {
        checkpoint = { after: this.passive(), before: probe };
      }
    }
    const cached = this.st.get(threadId);
    const tail =
      cached?.kind === 'ok'
        ? cached.tail
        : /** @type {number | null} */ (
            this.db
              .prepare('SELECT max(seq) FROM run_events WHERE thread_id = ?')
              .pluck()
              .get(threadId) ?? 0
          );
    this.db.pragma('synchronous = FULL');
    try {
      this.db
        .prepare(
          'INSERT INTO run_sync (thread_id, seq, at) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET seq = excluded.seq, at = excluded.at'
        )
        .run(threadId, tail, Date.now());
    } finally {
      this.db.pragma('synchronous = NORMAL');
    }
    return checkpoint;
  }

  /** @returns {CheckpointRow} */
  passive() {
    const r = /** @type {CheckpointRow[]} */ (this.db.pragma('wal_checkpoint(PASSIVE)'))[0];
    if (!r) {
      throw new Error('wal_checkpoint(PASSIVE) returned no row');
    }
    return r;
  }

  /**
   * Reopen validity (M0-A1 kill verifier): `PRAGMA integrity_check` plus per-thread seq contiguity.
   * @returns {{ integrity: string; gaps: number }}
   */
  check() {
    return {
      gaps: /** @type {number} */ (
        this.db
          .prepare(
            'SELECT count(*) FROM (SELECT thread_id, seq, row_number() OVER (PARTITION BY thread_id ORDER BY seq) AS rn FROM run_events) WHERE seq != rn'
          )
          .pluck()
          .get()
      ),
      integrity: /** @type {string} */ (this.db.pragma('integrity_check', { simple: true })),
    };
  }
}
