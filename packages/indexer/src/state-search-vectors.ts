import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { sha256 } from './chunks.js';
import {
  decoder,
  type StateSearchPending,
  type StateSearchPendingRow,
  type StateSearchSimilar,
  type StateSearchSimilarHit,
  type StateSearchVectorBatch,
  type StateSearchVectorsResult,
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
 */
export class StateSearchVectors {
  static readonly definition = `
    CREATE TABLE state_search_vectors(event_pk INTEGER NOT NULL REFERENCES state_search_rows(event_pk) ON DELETE CASCADE,profile_hash TEXT NOT NULL,dimensions INTEGER NOT NULL CHECK(dimensions>0),emb BLOB NOT NULL CHECK(length(emb)=dimensions*4),PRIMARY KEY(event_pk,profile_hash)) WITHOUT ROWID;
  `;

  constructor(private readonly db: Database.Database) {}

  /** Rows of the threads with no vector under the profile, oldest first. */
  pending(request: StateSearchPending): readonly StateSearchPendingRow[] {
    const hash = profileHash(request.profile);
    const rows = decoder(
      Schema.Array(Schema.Struct({ seq: Schema.Int, text: Schema.String, threadId: Schema.String }))
    )(
      this.db
        .prepare(
          `SELECT s.thread_id AS threadId,s.seq,s.text FROM state_search_rows s
           WHERE s.thread_id IN (SELECT value FROM json_each(?))
             AND NOT EXISTS (SELECT 1 FROM state_search_vectors v WHERE v.event_pk=s.event_pk AND v.profile_hash=?)
           ORDER BY s.event_pk LIMIT ?`
        )
        .all(JSON.stringify(request.threadIds), hash, request.limit)
    );
    return decoder(Schema.Array(stateSearchPendingRowSchema))(
      rows.map((row) => ({ ...row, sourceHash: sha256(row.text) }))
    );
  }

  /** Stores each vector whose row still holds the text it was computed from. */
  put(request: StateSearchVectorBatch): StateSearchVectorsResult {
    const hash = profileHash(request.profile);
    // Validate the complete batch before any row is written.
    const prepared = request.rows.map((row) => ({
      ...row,
      emb: vectorBytes(row.vector, request.profile.dimensions),
    }));
    return this.db.transaction(() => {
      let stored = 0;
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
        this.db
          .prepare(
            'INSERT INTO state_search_vectors(event_pk,profile_hash,dimensions,emb) VALUES(?,?,?,?) ON CONFLICT(event_pk,profile_hash) DO UPDATE SET dimensions=excluded.dimensions,emb=excluded.emb'
          )
          .run(current.eventPk, hash, request.profile.dimensions, row.emb);
        stored += 1;
      }
      return { stale: prepared.length - stored, stored };
    })();
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
