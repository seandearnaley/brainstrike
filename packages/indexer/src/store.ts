import type { StateTruthReader } from '@brainstrike/state-store/state-truth-reader';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import {
  decoder,
  IndexerError,
  type IndexerIdentity,
  type IndexerInfo,
  type IndexerOptions,
} from './contracts.ts';
import type { IndexConnection } from './index-connection.ts';
import {
  freshIdentity,
  INDEX_SCHEMA_VERSION,
  readIndexIdentity,
  readIndexSchemaVersion,
} from './index-metadata.ts';
import { decodeIndexerOptions } from './options.ts';
import { StateEventStore } from './state-event-store.ts';
import type { StateProjection } from './state-projection.ts';

export class IndexWriter {
  readonly state: StateEventStore;
  readonly db: Database.Database;
  private readonly truth: StateTruthReader;
  readonly options: IndexerOptions;
  readonly info: IndexerInfo;
  private readonly projection: StateProjection;

  /** `connection` is the index database its host opened (`desktop-index-connection.ts`). */
  constructor(input: unknown, connection: IndexConnection, projection: StateProjection) {
    this.projection = projection;
    try {
      this.options = decodeIndexerOptions(input);
    } catch (error) {
      connection.db.close();
      connection.truth.close();
      throw error;
    }
    this.db = connection.db;
    this.truth = connection.truth;
    let acquired: StateEventStore | undefined;
    try {
      if (connection.fresh) {
        this.initialize();
      } else {
        readIndexIdentity(this.db);
      }
      const integrity = decoder(Schema.Array(Schema.String))(
        this.db.prepare('PRAGMA integrity_check').pluck().all()
      );
      if (integrity.length !== 1 || integrity[0] !== 'ok') {
        throw new IndexerError(
          'rebuild-required',
          'SQLite integrity_check refused the existing derived index.'
        );
      }
      readIndexSchemaVersion(this.db);
      StateEventStore.validateLayout(this.db);
      StateEventStore.validateRoot(this.db, this.options.stateRoot, this.projection);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('secure_delete = ON');
      acquired = this.db
        .transaction(() => {
          readIndexIdentity(this.db);
          StateEventStore.validateLayout(this.db);
          StateEventStore.validateRoot(this.db, this.options.stateRoot, this.projection);
          return new StateEventStore(this.db, this.truth, this.projection);
        })
        .immediate();
      this.state = acquired;
      this.info = {
        dbPath: this.options.dbPath,
        journalMode: decoder(Schema.String)(this.db.pragma('journal_mode', { simple: true })),
        pid: connection.owner.pid,
        ...this.identity,
        writerThreadId: connection.owner.writerThreadId,
      };
    } catch (error) {
      if (acquired) {
        acquired.close();
      } else {
        this.truth.close();
      }
      this.db.close();
      throw error;
    }
  }
  get identity(): IndexerIdentity {
    return readIndexIdentity(this.db);
  }
  private initialize(): void {
    this.db.transaction(() => {
      this.db.exec(
        'CREATE TABLE index_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),schema_version INTEGER NOT NULL,store_id TEXT NOT NULL)'
      );
      StateEventStore.initialize(this.db, this.options.stateRoot, this.projection);
      this.db
        .prepare('INSERT INTO index_metadata VALUES(1,?,?)')
        .run(INDEX_SCHEMA_VERSION, freshIdentity().storeId);
    })();
  }
  close(): void {
    try {
      this.state.close();
    } finally {
      this.db.close();
    }
  }
}
