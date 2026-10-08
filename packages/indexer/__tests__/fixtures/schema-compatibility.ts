import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConnection } from '@brainstrike/sqlite-native';
import type Database from 'better-sqlite3';
import { Schema } from 'effect';
import { decoder, profileSchema, vectorProfileSchema, vectorSchema } from '../../src/contracts.js';
import { loadStateProjection } from '../../src/state-projection.js';

const value = Schema.Union([
  Schema.Null,
  Schema.String,
  Schema.Finite,
  Schema.Struct({ hex: Schema.String }),
]);
const rows = Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, value)));
const objects = Schema.Array(
  Schema.Struct({ name: Schema.String, sql: Schema.String, type: Schema.String })
);
const fixtureSchema = Schema.Struct({
  ftsConfig: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ k: Schema.String, v: Schema.Int }))
  ),
  memoryProfile: vectorProfileSchema,
  memoryVector: Schema.Array(Schema.Finite).check(Schema.isBetweenLength(8, 8)),
  profile: profileSchema,
  rows,
  schema: objects,
  source: Schema.String,
  truthRows: rows,
  truthSchema: objects,
  version: Schema.Literals([8, 9]),
});
export const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };

function insert(db: Database.Database, tables: typeof rows.Type): void {
  for (const [table, records] of Object.entries(tables)) {
    for (const row of records) {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((column) => (column === 'bin' ? 'vec_bit(?)' : '?')).join(',')})`
      ).run(
        ...Object.entries(row).map(([column, cell]) => {
          if (typeof cell === 'object' && cell !== null) {
            return Buffer.from(cell.hex, 'hex');
          }
          // vec0 requires INTEGER bindings, unlike ordinary SQLite table affinity.
          if (
            column === 'id' &&
            (table === 'vec_chunks' || table === 'scope_vec_384') &&
            typeof cell === 'number'
          ) {
            return BigInt(cell);
          }
          return cell;
        })
      );
    }
  }
}

/**
 * SQL and native rows were recorded from actual isolated production writers at the immutable
 * source commits in each JSON file, using the existing MiniLM fixture (no inference).
 * Virtual-table shadow DDL is omitted: executing the recorded native CREATE generates it.
 * Only the disposable Root/path-based producer acquisition is rebound before the baseline;
 * persisted IDs, profiles, grants, graph, committed CRC truth and vector bytes stay recorded.
 */
export async function compatibleFixture(version: 8 | 9) {
  const recorded = decoder(fixtureSchema)(
    JSON.parse(readFileSync(new URL(`./schema-${version}-native.json`, import.meta.url), 'utf8'))
  );
  const miniLm = decoder(
    Schema.Struct({
      profile: Schema.Unknown,
      runtime: Schema.Unknown,
      source: Schema.Unknown,
      vector: vectorSchema,
    })
  )(JSON.parse(readFileSync(new URL('./fused-minilm-384.json', import.meta.url), 'utf8')));
  const root = realpathSync(await mkdtemp(join(tmpdir(), `state-schema-${version}-`)));
  const dbPath = join(root, 'index.sqlite');
  const collection = { embeddingSetId: 'legacy-collection', kind: 'collection' } as const;
  const localProfile = { ...recorded.profile, distance: 'cosine', provider: 'local' } as const;
  const options = {
    dbPath,
    embedding: { indexMode: 'open-existing' },
    fileBindings: [
      {
        embeddingSetId: collection.embeddingSetId,
        fileId: 'legacy-scoped-file',
        profile: localProfile,
        relativePath: null,
        rootId: null,
        sourcePath: '/recorded/source.ts',
      },
    ],
    rootIds: ['root'],
    scopes: [collection],
    stateProjection: {
      mode: 'dev',
      module: new URL(
        version === 8 ? './state-schema.mjs' : './state-message-schema.mjs',
        import.meta.url
      ).href,
    },
    ...(version === 9
      ? {
          stateResources: [
            { profile: recorded.memoryProfile, resourceId: 'resource', rootId: 'root' },
          ],
        }
      : {}),
    stateRoot: root,
  } as const;
  const projection = await loadStateProjection(options.stateProjection, root);
  const db = openConnection(dbPath);
  const truth = openConnection(join(root, 'state.db'));
  let restored = false;
  try {
    db.transaction(() => {
      for (const object of recorded.schema) {
        db.exec(object.sql);
      }
      insert(db, recorded.rows);
      for (const [table, records] of Object.entries(recorded.ftsConfig)) {
        for (const row of records) {
          if (row.k === 'version') {
            if (db.prepare(`SELECT v FROM ${table} WHERE k='version'`).pluck().get() !== row.v) {
              throw new Error('Native FTS fixture version disagrees');
            }
          } else {
            const fts = table.slice(0, -'_config'.length);
            db.prepare(`INSERT INTO ${fts}(${fts},rank) VALUES(?,?)`).run(row.k, BigInt(row.v));
          }
        }
      }
      db.prepare(
        'UPDATE state_index_source SET root=?,projection_identity=? WHERE singleton=1'
      ).run(root, projection.identity);
    })();
    truth.transaction(() => {
      for (const object of recorded.truthSchema) {
        truth.exec(object.sql);
      }
      insert(truth, recorded.truthRows);
    })();
    restored = true;
  } finally {
    truth.close();
    db.close();
    if (!restored) {
      await rm(root, { force: true, recursive: true });
    }
  }
  return {
    close: () => rm(root, { force: true, recursive: true }),
    dbPath,
    messageQuery: {
      limit: 10,
      profile: recorded.memoryProfile,
      scope: { resourceId: 'resource', rootId: 'root', threadId: 'thread' },
      vector: recorded.memoryVector,
    },
    options,
    recorded,
    root,
    scopedQuery: {
      limit: 10,
      mode: 'vector',
      profile: localProfile,
      scopes: [collection],
      vector: miniLm.vector,
    },
    vectorQuery: {
      limit: 10,
      mode: 'vector',
      profile: recorded.profile,
      rootIds: ['root'],
      vector: miniLm.vector,
    },
  };
}

/** Stable persisted facts; normal reopening changes only owner epoch/generation and version. */
export function retained(dbPath: string, version: 8 | 9 | 10, omitOwner = true) {
  const db = openConnection(dbPath, { readonly: true });
  try {
    const tables = [
      'file_records',
      'file_chunks',
      'file_symbols',
      'file_symbol_refs',
      'vec_chunks',
      'vector_profiles',
      'scoped_vectors',
      'scope_vec_384',
      'state_event_rows',
      'state_event_blob_refs',
      'state_thread_cursors',
      'state_dropped_blob_refs',
      ...['file_chunks_fts', 'file_chunks_trigram', 'state_events_fts'].flatMap((table) =>
        ['data', 'idx', 'docsize', 'config'].map((suffix) => `${table}_${suffix}`)
      ),
      ...(version >= 9 ? ['state_message_profiles', 'state_message_vectors'] : []),
      ...(omitOwner
        ? []
        : ['index_scope_authority', ...(version >= 9 ? ['state_message_generation'] : [])]),
    ];
    return {
      identity: db
        .prepare('SELECT store_id,index_mode,profile_json,profile_hash FROM index_metadata')
        .get(),
      source: db
        .prepare(
          `SELECT root,projection_identity${version >= 9 ? ',resource_grants' : ''} FROM state_index_source`
        )
        .get(),
      tables: Object.fromEntries(
        tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])
      ),
    };
  } finally {
    db.close();
  }
}
export function truthHash(root: string): string {
  return createHash('sha256')
    .update(readFileSync(join(root, 'state.db')))
    .digest('hex');
}
