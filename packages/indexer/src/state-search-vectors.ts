import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { sha256 } from './chunks.js';
import {
  decoder,
  type StateSearchCoverage,
  type StateSearchCoverageRequest,
  type StateSearchPending,
  type StateSearchPendingRow,
  type StateSearchSimilar,
  type StateSearchSimilarHit,
  type StateSearchVectorBatch,
  type StateSearchVectorsResult,
  stateSearchCoverageResultSchema,
  stateSearchPendingRowSchema,
  stateSearchSimilarHitSchema,
} from './contracts.js';
import { profileHash, vectorBytes } from './state-message-vectors.js';

/**
 * The Threads panel's semantic arm over the host's conversation rows: one
 * vector per search row and profile, derived and rebuildable. The writer is
 * this index; inference stays with the caller (ADR-0007), which embeds the
 * rows `pending` returns and hands the vectors back to `put`. A vector is
 * keyed by its row, so a rewritten or dropped row takes its vectors with it.
 *
 * A row the caller could not embed records why, as legacy's `embedding_error`
 * does: it leaves the backlog and counts as errored until the retry window
 * passes, then it is pending again. A vector for it clears the failure.
 */
export class StateSearchVectors {
  static readonly definition = `
    CREATE TABLE state_search_vectors(event_pk INTEGER NOT NULL REFERENCES state_search_rows(event_pk) ON DELETE CASCADE,profile_hash TEXT NOT NULL,dimensions INTEGER NOT NULL CHECK(dimensions>0),emb BLOB NOT NULL CHECK(length(emb)=dimensions*4),PRIMARY KEY(event_pk,profile_hash)) WITHOUT ROWID;
  `;
  /** Schema 13: the rows whose last embedding failed, per profile. */
  static readonly failureDefinition = `
    CREATE TABLE state_search_vector_failures(event_pk INTEGER NOT NULL REFERENCES state_search_rows(event_pk) ON DELETE CASCADE,profile_hash TEXT NOT NULL,error TEXT NOT NULL,failed_at INTEGER NOT NULL,PRIMARY KEY(event_pk,profile_hash)) WITHOUT ROWID;
  `;
  /** Legacy thread search's `EMBEDDING_ERROR_RETRY_MS`: a failed row is retried after this. */
  static readonly retryAfterMs = 300_000;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now
  ) {}

  /** Rows of the threads with no vector and no recent failure under the profile, oldest first. */
  pending(request: StateSearchPending): readonly StateSearchPendingRow[] {
    const hash = profileHash(request.profile);
    const retryBefore = this.now() - StateSearchVectors.retryAfterMs;
    const rows = decoder(
      Schema.Array(Schema.Struct({ seq: Schema.Int, text: Schema.String, threadId: Schema.String }))
    )(
      this.db
        .prepare(
          `SELECT s.thread_id AS threadId,s.seq,s.text FROM state_search_rows s
           WHERE s.thread_id IN (SELECT value FROM json_each(?))
             AND NOT EXISTS (SELECT 1 FROM state_search_vectors v WHERE v.event_pk=s.event_pk AND v.profile_hash=?)
             AND NOT EXISTS (SELECT 1 FROM state_search_vector_failures f WHERE f.event_pk=s.event_pk AND f.profile_hash=? AND f.failed_at>?)
           ORDER BY s.event_pk LIMIT ?`
        )
        .all(JSON.stringify(request.threadIds), hash, hash, retryBefore, request.limit)
    );
    return decoder(Schema.Array(stateSearchPendingRowSchema))(
      rows.map((row) => ({ ...row, sourceHash: sha256(row.text) }))
    );
  }

  /**
   * Stores each vector, or each failure, whose row still holds the text it was
   * computed from.
   */
  put(request: StateSearchVectorBatch): StateSearchVectorsResult {
    const hash = profileHash(request.profile);
    // Validate the complete batch before any row is written.
    const prepared = request.rows.map((row) =>
      'vector' in row
        ? { ...row, emb: vectorBytes(row.vector, request.profile.dimensions) }
        : { ...row, emb: null }
    );
    const failedAt = this.now();
    return this.db.transaction(() => {
      let stored = 0;
      let failed = 0;
      for (const row of prepared) {
        const current = decoder(
          Schema.UndefinedOr(Schema.Struct({ eventPk: Schema.Int, text: Schema.String }))
        )(
          this.db
            .prepare(
              'SELECT event_pk AS eventPk,text FROM state_search_rows WHERE thread_id=? AND seq=?'
            )
            .get(row.threadId, row.seq)
        );
        if (current === undefined || sha256(current.text) !== row.sourceHash) {
          continue;
        }
        if ('error' in row) {
          this.db
            .prepare(
              'INSERT INTO state_search_vector_failures(event_pk,profile_hash,error,failed_at) VALUES(?,?,?,?) ON CONFLICT(event_pk,profile_hash) DO UPDATE SET error=excluded.error,failed_at=excluded.failed_at'
            )
            .run(current.eventPk, hash, row.error, failedAt);
          failed += 1;
          continue;
        }
        this.db
          .prepare(
            'INSERT INTO state_search_vectors(event_pk,profile_hash,dimensions,emb) VALUES(?,?,?,?) ON CONFLICT(event_pk,profile_hash) DO UPDATE SET dimensions=excluded.dimensions,emb=excluded.emb'
          )
          .run(current.eventPk, hash, request.profile.dimensions, row.emb);
        this.db
          .prepare('DELETE FROM state_search_vector_failures WHERE event_pk=? AND profile_hash=?')
          .run(current.eventPk, hash);
        stored += 1;
      }
      return { failed, stale: prepared.length - stored - failed, stored };
    })();
  }

  /** The threads' rows, embedded rows and recently failed rows under the profile. */
  coverage(request: StateSearchCoverageRequest): StateSearchCoverage {
    const hash = profileHash(request.profile);
    return decoder(stateSearchCoverageResultSchema)(
      this.db
        .prepare(
          `SELECT count(*) AS rows,
             count(v.event_pk) AS embedded,
             count(CASE WHEN v.event_pk IS NULL AND f.failed_at>? THEN 1 END) AS errored
           FROM state_search_rows s
           LEFT JOIN state_search_vectors v ON v.event_pk=s.event_pk AND v.profile_hash=?
           LEFT JOIN state_search_vector_failures f ON f.event_pk=s.event_pk AND f.profile_hash=?
           WHERE s.thread_id IN (SELECT value FROM json_each(?))`
        )
        .get(
          this.now() - StateSearchVectors.retryAfterMs,
          hash,
          hash,
          JSON.stringify(request.threadIds)
        )
    );
  }

  /** The threads' rows nearest the query vector, at or above the threshold, best first. */
  similar(request: StateSearchSimilar): readonly StateSearchSimilarHit[] {
    const hash = profileHash(request.profile);
    const vector = vectorBytes(request.vector, request.profile.dimensions);
    return decoder(Schema.Array(stateSearchSimilarHitSchema))(
      this.db
        .prepare(
          `SELECT threadId,seq,runId,role,text,score FROM (
             SELECT s.thread_id AS threadId,s.seq,s.run_id AS runId,s.role,s.text,
               max(-1,min(1,1-vec_distance_cosine(v.emb,?))) AS score
             FROM state_search_vectors v JOIN state_search_rows s ON s.event_pk=v.event_pk
             WHERE v.profile_hash=? AND s.thread_id IN (SELECT value FROM json_each(?))
           ) WHERE score>=? ORDER BY score DESC,threadId,seq LIMIT ?`
        )
        .all(vector, hash, JSON.stringify(request.threadIds), request.threshold, request.limit)
    );
  }
}
