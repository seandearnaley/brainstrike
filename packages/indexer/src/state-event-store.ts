import { realpathSync } from 'node:fs';
import path from 'node:path';
import { blobsOf, CheckpointBlockedError, SqliteReader } from '@brainstrike/state-store';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import {
  decoder,
  IndexerError,
  stateEventIdentitySchema,
  stateGcSchema,
  stateThreadsSchema,
} from './contracts.js';

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodeCount = decoder(count);

/** The same derived writer owns this projection, FTS, references and physical purge. */
export class StateEventStore {
  private readonly truth: SqliteReader;

  static initialize(db: Database.Database, root: string | undefined): void {
    db.exec(`
      CREATE TABLE state_index_source(singleton INTEGER PRIMARY KEY CHECK(singleton=1),root TEXT);
      CREATE TABLE state_event_rows(pk INTEGER PRIMARY KEY,thread_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),payload TEXT NOT NULL,UNIQUE(thread_id,seq));
      CREATE TABLE state_event_blob_refs(event_pk INTEGER NOT NULL REFERENCES state_event_rows(pk) ON DELETE CASCADE,hash TEXT NOT NULL,PRIMARY KEY(event_pk,hash)) WITHOUT ROWID;
      CREATE INDEX state_blob_hash ON state_event_blob_refs(hash);
      CREATE TABLE state_thread_cursors(thread_id TEXT PRIMARY KEY,seq INTEGER NOT NULL CHECK(seq>=0)) WITHOUT ROWID;
      CREATE TABLE state_dropped_blob_refs(thread_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(thread_id,hash)) WITHOUT ROWID;
      CREATE VIRTUAL TABLE state_events_fts USING fts5(payload,content='state_event_rows',content_rowid='pk',tokenize='unicode61');
      CREATE TRIGGER state_event_insert AFTER INSERT ON state_event_rows BEGIN
        INSERT INTO state_events_fts(rowid,payload) VALUES(new.pk,new.payload);
      END;
      CREATE TRIGGER state_event_delete AFTER DELETE ON state_event_rows BEGIN
        INSERT INTO state_events_fts(state_events_fts,rowid,payload) VALUES('delete',old.pk,old.payload);
      END;
      CREATE TRIGGER state_event_update AFTER UPDATE ON state_event_rows BEGIN
        INSERT INTO state_events_fts(state_events_fts,rowid,payload) VALUES('delete',old.pk,old.payload);
        INSERT INTO state_events_fts(rowid,payload) VALUES(new.pk,new.payload);
      END;
      INSERT INTO state_events_fts(state_events_fts,rank) VALUES('secure-delete',1);
    `);
    db.prepare('INSERT INTO state_index_source VALUES(1,?)').run(root ?? null);
  }

  static validateRoot(db: Database.Database, root: string | undefined): void {
    const stored = decoder(Schema.NullOr(Schema.String))(
      db.prepare('SELECT root FROM state_index_source WHERE singleton=1').pluck().get()
    );
    if (stored !== (root ?? null)) {
      throw new IndexerError(
        'rebuild-required',
        'State projection belongs to a different immutable truth root.'
      );
    }
  }

  static acquire(db: Database.Database, root: string | undefined): StateEventStore | undefined {
    StateEventStore.validateRoot(db, root);
    if (root === undefined) {
      return;
    }
    return new StateEventStore(db, root);
  }

  constructor(
    private readonly db: Database.Database,
    root: string
  ) {
    if (!path.isAbsolute(root) || realpathSync(root) !== root) {
      throw new TypeError('State projection requires the trusted canonical absolute truth root.');
    }
    this.truth = new SqliteReader(root);
    db.exec("INSERT INTO state_events_fts(state_events_fts,rank) VALUES('integrity-check',1)");
  }

  close(): void {
    this.truth.close();
  }

  private replace(threadId: string, seq: number, payload: string): void {
    const hashes = blobsOf(payload);
    const pk = decodeCount(
      this.db
        .prepare(`
      INSERT INTO state_event_rows(thread_id,seq,payload) VALUES(?,?,?)
      ON CONFLICT(thread_id,seq) DO UPDATE SET payload=excluded.payload RETURNING pk
    `)
        .pluck()
        .get(threadId, seq, payload)
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
    this.db.transaction(() => this.replace(threadId, seq, row.raw))();
    this.checkpoint();
    return true;
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
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO state_dropped_blob_refs SELECT ?,r.hash FROM state_event_blob_refs r JOIN state_event_rows e ON e.pk=r.event_pk WHERE e.thread_id=?'
        )
        .run(threadId, threadId);
      this.db.prepare('DELETE FROM state_event_rows WHERE thread_id=?').run(threadId);
      this.db.prepare('DELETE FROM state_thread_cursors WHERE thread_id=?').run(threadId);
    })();
    this.checkpoint();
    return decoder(Schema.Array(Schema.String))(
      this.db
        .prepare('SELECT hash FROM state_dropped_blob_refs WHERE thread_id=? ORDER BY hash')
        .pluck()
        .all(threadId)
    );
  }

  private checkpoint(): void {
    const busyTimeout = decodeCount(this.db.pragma('busy_timeout', { simple: true }));
    this.db.pragma('busy_timeout=0');
    try {
      const rows = decoder(
        Schema.Array(Schema.Struct({ busy: count, checkpointed: Schema.Int, log: Schema.Int }))
      )(this.db.pragma('wal_checkpoint(TRUNCATE)'));
      if (
        rows.length !== 1 ||
        rows[0]?.busy !== 0 ||
        rows[0].log !== 0 ||
        rows[0].checkpointed !== 0
      ) {
        throw new CheckpointBlockedError(
          'Derived state purge checkpoint is blocked by a pinned reader'
        );
      }
    } finally {
      this.db.pragma(`busy_timeout=${busyTimeout}`);
    }
  }
}
