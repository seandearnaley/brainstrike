import { realpathSync } from 'node:fs';
import path from 'node:path';
import { blobsOf, SqliteReader } from '@brainstrike/state-store';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import type { IndexerOptions } from './contracts.js';
import {
  decoder,
  IndexerError,
  type StateProjectionStats,
  stateEventIdentitySchema,
  stateGcSchema,
  stateMatchSchema,
  stateStatsSchema,
  stateThreadsSchema,
} from './contracts.js';
import { StateMessageVectors } from './state-message-vectors.js';
import { StateObservationVectors } from './state-observation-vectors.js';
import type { StateProjection } from './state-projection.js';

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodeCount = decoder(count);

/** The same derived writer owns this projection, FTS, references and physical purge. */
export class StateEventStore {
  private readonly truth: SqliteReader;
  private readonly failures: string[] = [];

  static assertProjection(root: string | undefined, projection: StateProjection | undefined): void {
    if (root !== undefined && !projection) {
      throw new TypeError('State writer requires its acquired producer schema.');
    }
  }

  static initialize(
    db: Database.Database,
    root: string | undefined,
    projection: StateProjection | undefined,
    options: IndexerOptions
  ): void {
    db.exec(`
      CREATE TABLE state_index_source(singleton INTEGER PRIMARY KEY CHECK(singleton=1),root TEXT,projection_identity TEXT,resource_grants TEXT NOT NULL);
      CREATE TABLE state_event_rows(pk INTEGER PRIMARY KEY,thread_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),payload TEXT NOT NULL,content TEXT,gap_reason TEXT,UNIQUE(thread_id,seq));
      CREATE TABLE state_event_blob_refs(event_pk INTEGER NOT NULL REFERENCES state_event_rows(pk) ON DELETE CASCADE,hash TEXT NOT NULL,PRIMARY KEY(event_pk,hash)) WITHOUT ROWID;
      CREATE INDEX state_blob_hash ON state_event_blob_refs(hash);
      CREATE TABLE state_thread_cursors(thread_id TEXT PRIMARY KEY,seq INTEGER NOT NULL CHECK(seq>=0)) WITHOUT ROWID;
      CREATE TABLE state_dropped_blob_refs(thread_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(thread_id,hash)) WITHOUT ROWID;
      CREATE VIRTUAL TABLE state_events_fts USING fts5(content,content='state_event_rows',content_rowid='pk',tokenize='unicode61');
      CREATE TRIGGER state_event_insert AFTER INSERT ON state_event_rows BEGIN
        INSERT INTO state_events_fts(rowid,content) VALUES(new.pk,new.content);
      END;
      CREATE TRIGGER state_event_delete AFTER DELETE ON state_event_rows BEGIN
        INSERT INTO state_events_fts(state_events_fts,rowid,content) VALUES('delete',old.pk,old.content);
      END;
      CREATE TRIGGER state_event_update AFTER UPDATE ON state_event_rows BEGIN
        INSERT INTO state_events_fts(state_events_fts,rowid,content) VALUES('delete',old.pk,old.content);
        INSERT INTO state_events_fts(rowid,content) VALUES(new.pk,new.content);
      END;
      INSERT INTO state_events_fts(state_events_fts,rank) VALUES('secure-delete',1);
    `);
    StateMessageVectors.initialize(db);
    StateObservationVectors.initialize(db);
    db.prepare('INSERT INTO state_index_source VALUES(1,?,?,?)').run(
      root ?? null,
      projection?.identity ?? null,
      JSON.stringify(options.stateResources ?? [])
    );
  }

  static validateRoot(
    db: Database.Database,
    root: string | undefined,
    projection: StateProjection | undefined,
    options: IndexerOptions
  ): void {
    const stored = decoder(Schema.NullOr(Schema.String))(
      db.prepare('SELECT root FROM state_index_source WHERE singleton=1').pluck().get()
    );
    const identity = decoder(Schema.NullOr(Schema.String))(
      db
        .prepare('SELECT projection_identity FROM state_index_source WHERE singleton=1')
        .pluck()
        .get()
    );
    const grants = decoder(Schema.String)(
      db.prepare('SELECT resource_grants FROM state_index_source WHERE singleton=1').pluck().get()
    );
    if (grants !== JSON.stringify(options.stateResources ?? [])) {
      throw new IndexerError(
        'rebuild-required',
        'State message resource/Root acquisition grants changed.'
      );
    }
    if (stored !== (root ?? null) || identity !== (projection?.identity ?? null)) {
      throw new IndexerError(
        'rebuild-required',
        'State projection belongs to a different immutable truth root or producer schema.'
      );
    }
  }

  static acquire(
    db: Database.Database,
    root: string | undefined,
    projection: StateProjection | undefined,
    options: IndexerOptions
  ): StateEventStore | undefined {
    StateEventStore.validateRoot(db, root, projection, options);
    if (root === undefined) {
      return;
    }
    if (!projection) {
      throw new TypeError('State projection requires its acquired producer schema.');
    }
    return new StateEventStore(db, root, projection, options);
  }

  readonly messages: StateMessageVectors;
  readonly observations: StateObservationVectors;

  constructor(
    private readonly db: Database.Database,
    root: string,
    private readonly projection: StateProjection,
    options: IndexerOptions
  ) {
    if (!path.isAbsolute(root) || realpathSync(root) !== root) {
      throw new TypeError('State projection requires the trusted canonical absolute truth root.');
    }
    this.truth = new SqliteReader(root);
    this.messages = new StateMessageVectors(db, this.truth, projection, options);
    this.observations = new StateObservationVectors(db, this.truth, projection, this.messages);
    db.exec("INSERT INTO state_events_fts(state_events_fts,rank) VALUES('integrity-check',1)");
  }

  close(): void {
    this.truth.close();
  }

  private replace(threadId: string, seq: number, payload: string): void {
    const row = this.projection.decode(payload);
    if (row.seq !== seq) {
      throw new Error('State event schema changed the committed sequence identity');
    }
    const hashes = blobsOf(payload);
    const pk = decodeCount(
      this.db
        .prepare(`
      INSERT INTO state_event_rows(thread_id,seq,payload,content,gap_reason) VALUES(?,?,?,?,?)
      ON CONFLICT(thread_id,seq) DO UPDATE SET payload=excluded.payload,content=excluded.content,gap_reason=excluded.gap_reason RETURNING pk
    `)
        .pluck()
        .get(threadId, seq, payload, row.text, row.gap)
    );
    this.db.prepare('DELETE FROM state_event_blob_refs WHERE event_pk=?').run(pk);
    for (const hash of hashes) {
      this.db.prepare('INSERT INTO state_event_blob_refs VALUES(?,?)').run(pk, hash);
    }
  }

  catchUp(input: unknown): boolean {
    const threads = decoder(stateThreadsSchema)(input);
    for (const threadId of new Set(threads)) {
      const tail = this.truth.watermark(threadId);
      let next =
        decodeCount(
          this.db
            .prepare('SELECT COALESCE((SELECT seq FROM state_thread_cursors WHERE thread_id=?),0)')
            .pluck()
            .get(threadId)
        ) + 1;
      if (next > tail + 1) {
        throw new Error('State projection is ahead of its authoritative truth');
      }
      while (next <= tail) {
        const rows = [...this.truth.read(threadId, next, tail)];
        if (rows.length === 0) {
          throw new Error('State truth ended before its committed watermark');
        }
        this.db.transaction(() => {
          for (const row of rows) {
            if (row.kind !== 'event' || row.seq !== next) {
              throw new Error('State truth has a CRC or contiguous-sequence gap');
            }
            this.replace(threadId, row.seq, row.raw);
            next++;
          }
          this.db
            .prepare(
              'INSERT INTO state_thread_cursors VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET seq=excluded.seq'
            )
            .run(threadId, next - 1);
        })();
      }
    }
    return true;
  }

  reindex(input: unknown): boolean {
    const { threadId, seq } = decoder(stateEventIdentitySchema)(input);
    const row = this.truth.read(threadId, seq, seq).next().value;
    if (row?.kind !== 'event' || row.seq !== seq) {
      throw new Error('State reindex requires the exact verified committed truth event');
    }
    // Persist retirement before fallible projection/observation reads; a failed cleanup stays fenced.
    this.messages.invalidate(threadId, seq);
    this.db.transaction(() => {
      this.observations.invalidate(threadId);
      this.replace(threadId, seq, row.raw);
    })();
    this.messages.finishCleanup();
    return true;
  }

  rebuild(input: unknown): boolean {
    const threadId = decoder(Schema.NonEmptyString)(input);
    this.messages.invalidate(threadId);
    this.db.transaction(() => {
      this.observations.invalidate(threadId);
      this.db.prepare('DELETE FROM state_event_rows WHERE thread_id=?').run(threadId);
      this.db.prepare('DELETE FROM state_thread_cursors WHERE thread_id=?').run(threadId);
      this.catchUp([threadId]);
    })();
    this.messages.finishCleanup();
    return true;
  }

  stats(input: unknown): StateProjectionStats {
    const threadId = decoder(Schema.NonEmptyString)(input);
    const docs = decodeCount(
      this.db
        .prepare('SELECT count(*) FROM state_event_rows WHERE thread_id=? AND content IS NOT NULL')
        .pluck()
        .get(threadId)
    );
    const cursor = decodeCount(
      this.db
        .prepare('SELECT COALESCE((SELECT seq FROM state_thread_cursors WHERE thread_id=?),0)')
        .pluck()
        .get(threadId)
    );
    const gaps = this.db
      .prepare(
        'SELECT seq AS "from",seq AS "to",gap_reason AS reason FROM state_event_rows WHERE thread_id=? AND gap_reason IS NOT NULL ORDER BY seq'
      )
      .all(threadId);
    return decoder(stateStatsSchema)({ cursor, docs, gaps });
  }

  match(input: unknown): readonly number[] {
    const { threadId, query } = decoder(stateMatchSchema)(input);
    return decoder(Schema.Array(Schema.Int.check(Schema.isGreaterThan(0))))(
      this.db
        .prepare(
          'SELECT e.seq FROM state_events_fts JOIN state_event_rows e ON e.pk=state_events_fts.rowid WHERE state_events_fts MATCH ? AND e.thread_id=? ORDER BY e.seq'
        )
        .pluck()
        .all(query, threadId)
    );
  }

  recordFailure(error: unknown): void {
    this.failures.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  health(): { indexerErrors: readonly string[] } {
    return { indexerErrors: [...this.failures] };
  }

  gcCheck(input: unknown): Record<string, number> {
    const { threads, hashes } = decoder(stateGcSchema)(input);
    this.catchUp(threads);
    const counts: Record<string, number> = {};
    for (const hash of new Set(hashes)) {
      counts[hash] = decodeCount(
        this.db.prepare('SELECT count(*) FROM state_event_blob_refs WHERE hash=?').pluck().get(hash)
      );
    }
    return counts;
  }

  dropThread(input: unknown): readonly string[] {
    const threadId = decoder(Schema.NonEmptyString)(input);
    if (this.truth.watermark(threadId) !== 0) {
      throw new Error('State thread deletion requires authoritative truth deletion first');
    }
    this.messages.invalidate(threadId);
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO state_dropped_blob_refs SELECT ?,r.hash FROM state_event_blob_refs r JOIN state_event_rows e ON e.pk=r.event_pk WHERE e.thread_id=?'
        )
        .run(threadId, threadId);
      this.observations.invalidate(threadId);
      this.db.prepare('DELETE FROM state_event_rows WHERE thread_id=?').run(threadId);
      this.db.prepare('DELETE FROM state_thread_cursors WHERE thread_id=?').run(threadId);
    })();
    this.messages.finishCleanup();
    return decoder(Schema.Array(Schema.String))(
      this.db
        .prepare('SELECT hash FROM state_dropped_blob_refs WHERE thread_id=? ORDER BY hash')
        .pluck()
        .all(threadId)
    );
  }
}
