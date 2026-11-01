import { blobsOf } from '@brainstrike/state-store/run-log-format';
import type { StateTruthReader } from '@brainstrike/state-store/state-truth-reader';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { checkedTruncateCheckpoint } from './checked-checkpoint.ts';
import {
  decoder,
  IndexerError,
  type StateProjectionStats,
  type StateSearchHit,
  type StateSearchRow,
  stateCatchUpStepSchema,
  stateEventIdentitySchema,
  stateGcSchema,
  stateMatchSchema,
  stateSearchHitSchema,
  stateSearchSchema,
  stateStatsSchema,
  stateThreadsSchema,
} from './contracts.ts';
import type { StateProjection } from './state-projection.ts';

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodeCount = decoder(count);
const stateSourceDefinition =
  'CREATE TABLE state_index_source(singleton INTEGER PRIMARY KEY CHECK(singleton=1),root TEXT,projection_identity TEXT)';
/** Gap 10: one searchable conversation row per committed event, with its own FTS. */
const searchDefinition = `
  CREATE TABLE state_search_rows(event_pk INTEGER PRIMARY KEY REFERENCES state_event_rows(pk) ON DELETE CASCADE,thread_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),run_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant')),text TEXT NOT NULL);
  CREATE INDEX state_search_thread ON state_search_rows(thread_id,seq);
  CREATE VIRTUAL TABLE state_search_fts USING fts5(text,content='state_search_rows',content_rowid='event_pk',tokenize='porter unicode61');
  CREATE TRIGGER state_search_insert AFTER INSERT ON state_search_rows BEGIN
    INSERT INTO state_search_fts(rowid,text) VALUES(new.event_pk,new.text);
  END;
  CREATE TRIGGER state_search_delete AFTER DELETE ON state_search_rows BEGIN
    INSERT INTO state_search_fts(state_search_fts,rowid,text) VALUES('delete',old.event_pk,old.text);
  END;
  INSERT INTO state_search_fts(state_search_fts,rank) VALUES('secure-delete',1);
`;
/**
 * The statements a catch-up runs for every event and thread it projects. Each
 * store prepares them once on its connection and reuses them (BST-2159); they
 * close with that connection, and a reopened index acquires a new store.
 */
function projectionStatements(db: Database.Database) {
  return {
    cursor: db
      .prepare('SELECT COALESCE((SELECT seq FROM state_thread_cursors WHERE thread_id=?),0)')
      .pluck(),
    deleteRefs: db.prepare('DELETE FROM state_event_blob_refs WHERE event_pk=?'),
    deleteSearch: db.prepare('DELETE FROM state_search_rows WHERE event_pk=?'),
    insertRef: db.prepare('INSERT INTO state_event_blob_refs VALUES(?,?)'),
    insertSearch: db.prepare(
      'INSERT INTO state_search_rows(event_pk,thread_id,seq,run_id,role,text) VALUES(?,?,?,?,?,?)'
    ),
    upsertEvent: db
      .prepare(`
      INSERT INTO state_event_rows(thread_id,seq,payload,content,gap_reason) VALUES(?,?,?,?,?)
      ON CONFLICT(thread_id,seq) DO UPDATE SET payload=excluded.payload,content=excluded.content,gap_reason=excluded.gap_reason RETURNING pk
    `)
      .pluck(),
    writeCursor: db.prepare(
      'INSERT INTO state_thread_cursors VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET seq=excluded.seq'
    ),
  };
}
const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;

/** The same derived writer owns this projection, FTS, references and physical purge. */
export class StateEventStore {
  private readonly failures: string[] = [];

  static initialize(db: Database.Database, root: string, projection: StateProjection): void {
    db.exec(`
      ${stateSourceDefinition};
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
      ${searchDefinition}
    `);
    db.prepare('INSERT INTO state_index_source VALUES(1,?,?)').run(root, projection.identity);
  }

  static validateRoot(db: Database.Database, root: string, projection: StateProjection): void {
    const stored = decoder(Schema.NullOr(Schema.String))(
      db.prepare('SELECT root FROM state_index_source WHERE singleton=1').pluck().get()
    );
    const identity = decoder(Schema.NullOr(Schema.String))(
      db
        .prepare('SELECT projection_identity FROM state_index_source WHERE singleton=1')
        .pluck()
        .get()
    );
    if (stored !== root || identity !== projection.identity) {
      throw new IndexerError(
        'rebuild-required',
        'State projection belongs to a different immutable truth root or producer schema.'
      );
    }
  }

  /** Exact layout: a partial or counterfeit derived schema refuses as rebuild-required. */
  static validateLayout(db: Database.Database): void {
    const objects: readonly (readonly [string, string])[] = [
      ['state_index_source', 'table'],
      ['state_search_rows', 'table'],
      ['state_search_thread', 'index'],
      ['state_search_fts', 'table'],
    ];
    const stored = decoder(
      Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }))
    )(
      db
        .prepare(
          'SELECT name,type FROM sqlite_schema WHERE name IN (SELECT value FROM json_each(?))'
        )
        .all(JSON.stringify(objects.map(([name]) => name)))
    );
    for (const [name, type] of objects) {
      if (stored.find((object) => object.name === name)?.type !== type) {
        throw new IndexerError(
          'rebuild-required',
          'Declared derived schema disagrees with its layout.'
        );
      }
    }
    const columns = decoder(Schema.Array(Schema.String))(
      db
        .prepare("SELECT name FROM pragma_table_info('state_index_source') ORDER BY cid")
        .pluck()
        .all()
    );
    if (JSON.stringify(columns) !== JSON.stringify(['singleton', 'root', 'projection_identity'])) {
      throw new IndexerError(
        'rebuild-required',
        'State source schema disagrees with its declared version.'
      );
    }
  }

  private writeSearch(pk: number, threadId: string, seq: number, search: StateSearchRow): void {
    this.statements.deleteSearch.run(pk);
    if (search) {
      this.statements.insertSearch.run(pk, threadId, seq, search.runId, search.role, search.text);
    }
  }

  private readonly statements: ReturnType<typeof projectionStatements>;
  /** Where the last bounded catch-up over this exact thread list stopped. */
  private resume: { readonly index: number; readonly key: string } | undefined;

  private readonly db: Database.Database;
  private readonly truth: StateTruthReader;
  private readonly projection: StateProjection;

  /** `truth` reads the state DB this store projects; its host owns the connection under it. */
  constructor(db: Database.Database, truth: StateTruthReader, projection: StateProjection) {
    this.db = db;
    this.truth = truth;
    this.projection = projection;
    this.statements = projectionStatements(db);
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
      this.statements.upsertEvent.get(threadId, seq, payload, row.text, row.gap)
    );
    this.statements.deleteRefs.run(pk);
    for (const hash of hashes) {
      this.statements.insertRef.run(pk, hash);
    }
    this.writeSearch(pk, threadId, seq, row.search);
  }

  catchUp(input: unknown): boolean {
    return this.project(decoder(stateThreadsSchema)(input), Number.POSITIVE_INFINITY);
  }

  /** Projects at most `maxEvents` events, committing each batch; true once every thread is current. */
  catchUpStep(input: unknown): boolean {
    const { maxEvents, threads } = decoder(stateCatchUpStepSchema)(input);
    return this.project(threads, maxEvents);
  }

  /**
   * A read projects its threads' backlog only within `budget`: past it the read
   * refuses as behind, so a deadline-bound caller steps again and never carries
   * a backlog in the read. An in-process caller with no deadline passes none.
   */
  private readable(threads: readonly string[], budget: number): void {
    if (!this.project(threads, budget)) {
      throw new IndexerError(
        'state-behind',
        'The requested threads are further behind their committed truth than this read may project.'
      );
    }
  }

  private project(threads: readonly string[], maxEvents: number): boolean {
    const ordered = [...new Set(threads)];
    const key = JSON.stringify(ordered);
    // A step over the same threads resumes at the one the last step stopped on, so
    // a late thread's backlog costs a visit per step rather than a pass over every
    // thread already current before it. A step reports current only after visiting
    // every thread within itself, so a thread that gained events behind the resume
    // point is still caught up (BST-2042).
    const start = this.resume?.key === key ? this.resume.index : 0;
    this.resume = undefined;
    let budget = maxEvents;
    const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];
    for (const [offset, threadId] of rotated.entries()) {
      const tail = this.truth.watermark(threadId);
      let next = decodeCount(this.statements.cursor.get(threadId)) + 1;
      if (next > tail + 1) {
        throw new Error('State projection is ahead of its authoritative truth');
      }
      while (next <= tail) {
        if (budget <= 0) {
          this.resume = { index: (start + offset) % ordered.length, key };
          return false;
        }
        const rows = [...this.truth.read(threadId, next, Math.min(tail, next + budget - 1))];
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
          this.statements.writeCursor.run(threadId, next - 1);
        })();
        budget -= rows.length;
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
    this.db.transaction(() => {
      this.replace(threadId, seq, row.raw);
    })();
    // A purge resolves only once the replaced row's pages are out of the WAL.
    checkedTruncateCheckpoint(this.db);
    return true;
  }

  /**
   * Re-projects the thread from its first event: its cursor is reset, and the
   * caller's bounded catch-up steps then overwrite every
   * row (`replace` upserts each row with its references, search row and text
   * index). No request deletes the thread's whole projection at once.
   */
  rebuild(input: unknown): boolean {
    const threadId = decoder(Schema.NonEmptyString)(input);
    this.db.prepare('DELETE FROM state_thread_cursors WHERE thread_id=?').run(threadId);
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
    const cursor = decodeCount(this.statements.cursor.get(threadId));
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

  /**
   * Gap 10: committed conversation rows in the requested threads that contain
   * every query word (or, when asked, any of them), best bm25 match first,
   * each with a marked snippet.
   */
  search(input: unknown, budget = Number.POSITIVE_INFINITY): readonly StateSearchHit[] {
    const request = decoder(stateSearchSchema)(input);
    const words = request.query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (words.length === 0 || request.threadIds.length === 0) {
      return [];
    }
    // Like the blob check, a search first catches up to its threads' committed truth.
    this.readable(request.threadIds, budget);
    return decoder(Schema.Array(stateSearchHitSchema))(
      this.db
        .prepare(
          `SELECT s.thread_id AS threadId,s.seq,s.run_id AS runId,s.role,bm25(state_search_fts) AS rank,
             snippet(state_search_fts,0,'<mark>','</mark>',' … ',18) AS snippet
           FROM state_search_fts JOIN state_search_rows s ON s.event_pk=state_search_fts.rowid
           WHERE state_search_fts MATCH ? AND s.thread_id IN (SELECT value FROM json_each(?))
           ORDER BY rank,s.thread_id,s.seq LIMIT ?`
        )
        .all(
          words.map(quote).join(request.match === 'any' ? ' OR ' : ' '),
          JSON.stringify(request.threadIds),
          request.limit
        )
    );
  }

  recordFailure(error: unknown): void {
    this.failures.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }

  health(): { indexerErrors: readonly string[] } {
    return { indexerErrors: [...this.failures] };
  }

  gcCheck(input: unknown, budget = Number.POSITIVE_INFINITY): Record<string, number> {
    const { threads, hashes } = decoder(stateGcSchema)(input);
    this.readable(threads, budget);
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
    checkedTruncateCheckpoint(this.db);
    return decoder(Schema.Array(Schema.String))(
      this.db
        .prepare('SELECT hash FROM state_dropped_blob_refs WHERE thread_id=? ORDER BY hash')
        .pluck()
        .all(threadId)
    );
  }
}
