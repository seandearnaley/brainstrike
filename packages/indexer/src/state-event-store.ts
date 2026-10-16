import { blobsOf } from '@brainstrike/state-store/run-log-format';
import type { StateTruthReader } from '@brainstrike/state-store/state-truth-reader';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import type { IndexerOptions } from './contracts.js';
import {
  decoder,
  IndexerError,
  type StateProjectionStats,
  type StateSearchCoverage,
  type StateSearchHit,
  type StateSearchPendingRow,
  type StateSearchRow,
  type StateSearchSimilarHit,
  type StateSearchVectorsResult,
  stateCatchUpStepSchema,
  stateEventIdentitySchema,
  stateGcSchema,
  stateMatchSchema,
  stateSearchCoverageSchema,
  stateSearchHitSchema,
  stateSearchPendingSchema,
  stateSearchSchema,
  stateSearchSimilarSchema,
  stateSearchVectorBatchSchema,
  stateStatsSchema,
  stateThreadsSchema,
} from './contracts.js';
import { INDEX_SCHEMA_VERSION, type IndexSchemaVersion } from './index-metadata.js';
import { PromptVectors } from './prompt-vectors.js';
import { StateMessageVectors } from './state-message-vectors.js';
import { StateObservationVectors } from './state-observation-vectors.js';
import type { StateProjection } from './state-projection.js';
import { StateSearchVectors } from './state-search-vectors.js';

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodeCount = decoder(count);
const stateSourceColumns =
  'singleton INTEGER PRIMARY KEY CHECK(singleton=1),root TEXT,projection_identity TEXT';
const stateSourceDefinition = `CREATE TABLE state_index_source(${stateSourceColumns},resource_grants TEXT NOT NULL)`;
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
const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;
// Normalize only SQL whitespace; quoted constraint/default literals retain their exact bytes.
const normalizedDefinition = (sql: string): string =>
  sql.replace(/'(?:''|[^'])*'|\s+/gu, (token) => (token.startsWith("'") ? token : ' ')).trim();

/** The same derived writer owns this projection, FTS, references and physical purge. */
export class StateEventStore {
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
      ${StateSearchVectors.definition}
      ${StateSearchVectors.failureDefinition}
      ${PromptVectors.definition}
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
    options: IndexerOptions,
    version: IndexSchemaVersion = INDEX_SCHEMA_VERSION
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
    const grants =
      version === 8
        ? '[]'
        : decoder(Schema.String)(
            db
              .prepare('SELECT resource_grants FROM state_index_source WHERE singleton=1')
              .pluck()
              .get()
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

  /** Exact additive frontier: a legacy label must not hide partial or counterfeit additions. */
  static validateLayout(db: Database.Database, version: IndexSchemaVersion): void {
    const additions: readonly (readonly [string, string, boolean])[] = [
      ['state_index_source', 'table', true],
      ['state_message_generation', 'table', version >= 9],
      ['state_message_profiles', 'table', version >= 9],
      ['state_message_vectors', 'table', version >= 9],
      ['state_message_scope', 'index', version >= 9],
      ['state_observation_vectors', 'table', version >= 10],
      ['state_observation_scope', 'index', version >= 10],
      ['state_search_rows', 'table', version >= 11],
      ['state_search_thread', 'index', version >= 11],
      ['state_search_fts', 'table', version >= 11],
      ['state_search_vectors', 'table', version >= 12],
      ['state_search_vector_failures', 'table', version >= 13],
      ['prompt_vectors', 'table', version >= 14],
    ];
    const objects = decoder(
      Schema.Array(Schema.Struct({ name: Schema.String, sql: Schema.String, type: Schema.String }))
    )(
      db
        .prepare(
          'SELECT name,sql,type FROM sqlite_schema WHERE name IN (SELECT value FROM json_each(?))'
        )
        .all(JSON.stringify(additions.map(([name]) => name)))
    );
    for (const [name, type, expected] of additions) {
      const found = objects.find((object) => object.name === name);
      if (expected ? found?.type !== type : found !== undefined) {
        throw new IndexerError(
          'rebuild-required',
          'Declared derived schema disagrees with its additive layout.'
        );
      }
    }
    if (version !== INDEX_SCHEMA_VERSION) {
      const required = [
        {
          name: 'state_index_source',
          sql:
            version === 8
              ? `CREATE TABLE state_index_source(${stateSourceColumns})`
              : stateSourceDefinition,
        },
        ...(version === 9 ? StateMessageVectors.definitions : []),
      ];
      for (const { name, sql } of required) {
        const stored = objects.find((object) => object.name === name);
        if (!stored || normalizedDefinition(stored.sql) !== normalizedDefinition(sql)) {
          throw new IndexerError('rebuild-required', `Legacy derived definition changed: ${name}.`);
        }
      }
    }
    const columns = decoder(Schema.Array(Schema.String))(
      db
        .prepare("SELECT name FROM pragma_table_info('state_index_source') ORDER BY cid")
        .pluck()
        .all()
    );
    if (
      JSON.stringify(columns) !==
      JSON.stringify([
        'singleton',
        'root',
        'projection_identity',
        ...(version === 8 ? [] : ['resource_grants']),
      ])
    ) {
      throw new IndexerError(
        'rebuild-required',
        'State source schema disagrees with its declared version.'
      );
    }
  }

  /** Caller owns the native transaction; no rows or existing authority are replaced. */
  static addCompatibleStorage(db: Database.Database, version: IndexSchemaVersion): void {
    if (version === 8) {
      db.exec(
        "ALTER TABLE state_index_source ADD COLUMN resource_grants TEXT NOT NULL DEFAULT '[]'"
      );
      StateMessageVectors.initialize(db);
    }
    if (version < 10) {
      StateObservationVectors.initialize(db);
    }
    if (version < 11) {
      db.exec(searchDefinition);
    }
    if (version < 12) {
      db.exec(StateSearchVectors.definition);
    }
    if (version < 13) {
      db.exec(StateSearchVectors.failureDefinition);
    }
    if (version < 14) {
      db.exec(PromptVectors.definition);
    }
    StateMessageVectors.validateStorage(db);
  }

  /** Caller owns the native transaction: additions, acquisition and their backfill commit together. */
  static acquire(
    db: Database.Database,
    root: string | undefined,
    truth: StateTruthReader | undefined,
    projection: StateProjection | undefined,
    options: IndexerOptions,
    version: IndexSchemaVersion
  ): StateEventStore | undefined {
    StateEventStore.addCompatibleStorage(db, version);
    StateEventStore.validateRoot(db, root, projection, options);
    if (root === undefined) {
      return;
    }
    if (!projection) {
      throw new TypeError('State projection requires its acquired producer schema.');
    }
    if (!truth) {
      throw new TypeError('State projection requires its authoritative truth reader.');
    }
    const store = new StateEventStore(db, truth, projection, options);
    if (version < 11) {
      store.backfillSearch();
    }
    return store;
  }

  /** An upgraded store's search rows, projected from the committed events it already holds. */
  private backfillSearch(): void {
    const rows = decoder(
      Schema.Array(
        Schema.Struct({ payload: Schema.String, pk: count, seq: count, threadId: Schema.String })
      )
    )(
      this.db
        .prepare('SELECT pk,thread_id AS threadId,seq,payload FROM state_event_rows ORDER BY pk')
        .all()
    );
    for (const row of rows) {
      this.writeSearch(row.pk, row.threadId, row.seq, this.projection.decode(row.payload).search);
    }
  }

  private writeSearch(pk: number, threadId: string, seq: number, search: StateSearchRow): void {
    this.db.prepare('DELETE FROM state_search_rows WHERE event_pk=?').run(pk);
    if (search) {
      this.db
        .prepare(
          'INSERT INTO state_search_rows(event_pk,thread_id,seq,run_id,role,text) VALUES(?,?,?,?,?,?)'
        )
        .run(pk, threadId, seq, search.runId, search.role, search.text);
    }
  }

  readonly prompts: PromptVectors;
  readonly messages: StateMessageVectors;
  readonly observations: StateObservationVectors;
  private readonly searchVectors: StateSearchVectors;

  /** `truth` reads the state DB this store projects; its host owns the connection under it. */
  constructor(
    private readonly db: Database.Database,
    private readonly truth: StateTruthReader,
    private readonly projection: StateProjection,
    options: IndexerOptions
  ) {
    this.messages = new StateMessageVectors(db, this.truth, projection, options);
    this.observations = new StateObservationVectors(db, this.truth, projection, this.messages);
    this.searchVectors = new StateSearchVectors(db);
    this.prompts = new PromptVectors(db);
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

  private project(threads: readonly string[], maxEvents: number): boolean {
    let budget = maxEvents;
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
        if (budget <= 0) {
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
          this.db
            .prepare(
              'INSERT INTO state_thread_cursors VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET seq=excluded.seq'
            )
            .run(threadId, next - 1);
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

  /**
   * Gap 10: committed conversation rows in the requested threads that contain
   * every query word (or, when asked, any of them), best bm25 match first,
   * each with a marked snippet.
   */
  search(input: unknown): readonly StateSearchHit[] {
    const request = decoder(stateSearchSchema)(input);
    const words = request.query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (words.length === 0 || request.threadIds.length === 0) {
      return [];
    }
    // Like the blob check, a search first catches up to its threads' committed truth.
    this.catchUp(request.threadIds);
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

  /** The semantic arm's backlog: rows of the threads, caught up, with no vector under the profile. */
  searchPending(input: unknown): readonly StateSearchPendingRow[] {
    const request = decoder(stateSearchPendingSchema)(input);
    if (request.threadIds.length === 0) {
      return [];
    }
    this.catchUp(request.threadIds);
    return this.searchVectors.pending(request);
  }

  /** Vectors the caller computed for `searchPending` rows; a changed row's vector is not stored. */
  putSearchVectors(input: unknown): StateSearchVectorsResult {
    return this.searchVectors.put(decoder(stateSearchVectorBatchSchema)(input));
  }

  /** The semantic arm's coverage of the threads, caught up first like `search`. */
  searchCoverage(input: unknown): StateSearchCoverage {
    const request = decoder(stateSearchCoverageSchema)(input);
    if (request.threadIds.length === 0) {
      return { embedded: 0, errored: 0, rows: 0 };
    }
    this.catchUp(request.threadIds);
    return this.searchVectors.coverage(request);
  }

  /** The semantic arm: the threads' rows nearest the query vector, caught up first like `search`. */
  searchSimilar(input: unknown): readonly StateSearchSimilarHit[] {
    const request = decoder(stateSearchSimilarSchema)(input);
    if (request.threadIds.length === 0) {
      return [];
    }
    this.catchUp(request.threadIds);
    return this.searchVectors.similar(request);
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
