import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IndexReader } from '../src/store.js';
import {
  compatibleFixture,
  deadlines,
  retained,
  truthHash,
} from './fixtures/schema-compatibility.js';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Compatibility qualification must not invoke live inference');
    })
  );
});
afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

async function assertQueries(
  port: Awaited<ReturnType<typeof openIndexer>>,
  f: Awaited<ReturnType<typeof compatibleFixture>>,
  before: readonly unknown[]
): Promise<void> {
  expect(await port.search(f.vectorQuery)).toEqual(before[0]);
  expect(
    await port.search({ limit: 10, mode: 'bm25', rootIds: ['root'], text: 'webworker' })
  ).toEqual(before[1]);
  expect(
    await port.search({ limit: 10, mode: 'trigram', rootIds: ['root'], text: 'webwor' })
  ).toEqual(before[2]);
  expect(await port.searchScopes(f.scopedQuery)).toEqual(before[3]);
  expect(await port.matchState('thread', 'committed')).toEqual([1]);
  if (f.recorded.version === 9) {
    expect(await port.queryStateMessageVectors(f.messageQuery)).toEqual([
      { messageId: '["thread",1]', score: 1, segmentOrdinal: 0, seq: 1, threadId: 'thread' },
    ]);
  }
}

for (const version of [8, 9] as const) {
  it(`preserves native schema ${version} read-only search, rows, vectors, grants and truth through upgrade/reopen`, async () => {
    const f = await compatibleFixture(version);
    let port: Awaited<ReturnType<typeof openIndexer>> | undefined;
    try {
      const bytes = readFileSync(f.dbPath);
      const truth = truthHash(f.root);
      const baseline = retained(f.dbPath, version);
      const reader = new IndexReader(f.options);
      let searches: readonly unknown[];
      try {
        const results = [
          reader.search(f.vectorQuery),
          reader.search({ limit: 10, mode: 'bm25', rootIds: ['root'], text: 'webworker' }),
          reader.search({ limit: 10, mode: 'trigram', rootIds: ['root'], text: 'webwor' }),
          reader.scoped.search(f.scopedQuery),
        ];
        for (const result of results) {
          expect(result.hits).toHaveLength(1);
        }
        searches = results;
        expect(reader.db.pragma('query_only', { simple: true })).toBe(1);
      } finally {
        reader.db.close();
      }
      expect(readFileSync(f.dbPath)).toEqual(bytes);
      expect(truthHash(f.root)).toBe(truth);
      port = await openIndexer(f.options, deadlines);
      await assertQueries(port, f, searches);
      await port.close();
      port = undefined;
      const upgraded = retained(f.dbPath, version);
      expect(upgraded).toEqual(baseline);
      const audit = openConnection(f.dbPath, { readonly: true });
      try {
        expect(audit.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(12);
        expect(audit.prepare('SELECT count(*) FROM state_observation_vectors').pluck().get()).toBe(
          0
        );
        // The upgrade retains the acquisition's bound Root/resource grants unchanged.
        expect(audit.prepare('SELECT resource_grants FROM state_index_source').pluck().get()).toBe(
          version === 8 ? '[]' : JSON.stringify(f.options.stateResources)
        );
      } finally {
        audit.close();
      }
      port = await openIndexer(f.options, deadlines);
      await assertQueries(port, f, searches);
      expect(retained(f.dbPath, version)).toEqual(baseline);
      expect(truthHash(f.root)).toBe(truth);
    } finally {
      await port?.close();
      await f.close();
      expect(existsSync(f.root)).toBe(false);
    }
  });

  it(`rolls back schema ${version} additions and owner fences on native final-stamp failure`, async () => {
    const f = await compatibleFixture(version);
    try {
      const db = openConnection(f.dbPath);
      db.exec(
        "CREATE TRIGGER recorded_stamp_refusal BEFORE UPDATE OF schema_version ON index_metadata BEGIN SELECT RAISE(ABORT,'recorded final stamp refusal'); END"
      );
      db.close();
      const baseline = retained(f.dbPath, version, false);
      const truth = truthHash(f.root);
      await expect(openIndexer(f.options, deadlines)).rejects.toThrow(
        'recorded final stamp refusal'
      );
      expect(retained(f.dbPath, version, false)).toEqual(baseline);
      const audit = openConnection(f.dbPath);
      try {
        expect(audit.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(
          version
        );
        expect(
          audit
            .prepare("SELECT count(*) FROM sqlite_schema WHERE name='state_observation_vectors'")
            .pluck()
            .get()
        ).toBe(0);
        if (version === 8) {
          expect(
            audit
              .prepare("SELECT count(*) FROM sqlite_schema WHERE name='state_message_vectors'")
              .pluck()
              .get()
          ).toBe(0);
        }
        audit.exec('DROP TRIGGER recorded_stamp_refusal');
      } finally {
        audit.close();
      }
      const retry = await openIndexer(f.options, deadlines);
      await retry.close();
      expect(retained(f.dbPath, version)).toEqual(retainedBaseline(baseline));
      expect(truthHash(f.root)).toBe(truth);
    } finally {
      await f.close();
    }
  });

  it(`recovers schema ${version} after actual SIGKILL between additive DDL and version stamp`, async () => {
    const f = await compatibleFixture(version);
    try {
      const baseline = retained(f.dbPath, version, false);
      const truth = truthHash(f.root);
      const optionsPath = join(f.root, 'crash-options.json');
      const receiptPath = join(f.root, 'crash-receipt.json');
      writeFileSync(optionsPath, JSON.stringify(f.options));
      await expect(
        promisify(execFile)(process.execPath, [
          new URL('./fixtures/schema-compatibility-crash.mjs', import.meta.url).pathname,
          optionsPath,
          receiptPath,
        ])
      ).rejects.toMatchObject({ signal: 'SIGKILL' });
      expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual({
        added: 1,
        inTransaction: true,
        version,
      });
      expect(retained(f.dbPath, version, false)).toEqual(baseline);
      const audit = openConnection(f.dbPath, { readonly: true });
      try {
        expect(audit.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(
          version
        );
        expect(
          audit
            .prepare("SELECT count(*) FROM sqlite_schema WHERE name='state_observation_vectors'")
            .pluck()
            .get()
        ).toBe(0);
      } finally {
        audit.close();
      }
      const retry = await openIndexer(f.options, deadlines);
      expect((await retry.search(f.vectorQuery)).hits).toHaveLength(1);
      await retry.close();
      expect(retained(f.dbPath, version)).toEqual(retainedBaseline(baseline));
      expect(truthHash(f.root)).toBe(truth);
    } finally {
      await f.close();
    }
  });
}

function retainedBaseline(baseline: ReturnType<typeof retained>): ReturnType<typeof retained> {
  const {
    index_scope_authority: _epoch,
    state_message_generation: _generation,
    ...tables
  } = baseline.tables;
  return { ...baseline, tables };
}

for (const version of [8, 9] as const) {
  for (const invalid of [
    'root',
    'producer',
    'grants',
    'profile',
    'vector',
    'partial',
    'unknown',
  ] as const) {
    it(`refuses schema ${version} ${invalid} mismatch without admitting additions or changing truth`, async () => {
      const f = await compatibleFixture(version);
      try {
        const db = openConnection(f.dbPath);
        try {
          if (invalid === 'root') {
            db.prepare('UPDATE state_index_source SET root=?').run(`${f.root}/foreign`);
          }
          if (invalid === 'producer') {
            db.prepare('UPDATE state_index_source SET projection_identity=?').run(
              'foreign-producer'
            );
          }
          if (invalid === 'grants' && version === 9) {
            db.prepare('UPDATE state_index_source SET resource_grants=?').run('[]');
          }
          if (invalid === 'profile') {
            db.prepare('UPDATE index_metadata SET profile_hash=?').run('a'.repeat(64));
          }
          if (invalid === 'vector') {
            db.prepare('DELETE FROM vec_chunks').run();
          }
          if (invalid === 'partial') {
            db.exec('CREATE TABLE state_observation_vectors(counterfeit TEXT)');
          }
          if (invalid === 'unknown') {
            db.prepare('UPDATE index_metadata SET schema_version=13').run();
          }
        } finally {
          db.close();
        }
        const baseline = retained(f.dbPath, version, false);
        const truth = truthHash(f.root);
        const options =
          invalid === 'grants' && version === 8
            ? {
                ...f.options,
                stateResources: [{ resourceId: 'resource', rootId: 'root' }],
              }
            : f.options;
        await expect(openIndexer(options, deadlines)).rejects.toThrow(
          /rebuild-required|invalid|disagree|different|changed/i
        );
        expect(retained(f.dbPath, version, false)).toEqual(baseline);
        const audit = openConnection(f.dbPath, { readonly: true });
        try {
          expect(audit.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(
            invalid === 'unknown' ? 13 : version
          );
          expect(
            audit
              .prepare("SELECT count(*) FROM sqlite_schema WHERE name='state_observation_vectors'")
              .pluck()
              .get()
          ).toBe(invalid === 'partial' ? 1 : 0);
          if (version === 8) {
            expect(
              audit
                .prepare("SELECT count(*) FROM sqlite_schema WHERE name='state_message_vectors'")
                .pluck()
                .get()
            ).toBe(0);
          }
        } finally {
          audit.close();
        }
        expect(truthHash(f.root)).toBe(truth);
      } finally {
        await f.close();
      }
    });
  }
}

for (const invalid of [
  'message-profile',
  'message-dimension',
  'message-nonfinite',
  'message-orphan',
  'generation',
  'missing-index',
] as const) {
  it(`refuses recorded schema 9 ${invalid} corruption and rolls back observation additions`, async () => {
    const f = await compatibleFixture(9);
    try {
      const db = openConnection(f.dbPath);
      try {
        if (invalid === 'message-profile') {
          db.prepare('UPDATE state_message_profiles SET json=?').run(
            JSON.stringify({ ...f.recorded.memoryProfile, revision: 'b'.repeat(40) })
          );
        }
        if (invalid === 'message-dimension') {
          db.prepare('UPDATE state_message_vectors SET dimensions=7,emb=?').run(Buffer.alloc(28));
        }
        if (invalid === 'message-nonfinite') {
          const vector = Buffer.alloc(32);
          vector.writeFloatLE(Number.NaN, 0);
          db.prepare('UPDATE state_message_vectors SET emb=?').run(vector);
        }
        if (invalid === 'message-orphan') {
          db.pragma('foreign_keys=OFF');
          db.prepare('UPDATE state_message_vectors SET profile_hash=?').run('b'.repeat(64));
        }
        if (invalid === 'generation') {
          db.prepare('UPDATE state_message_generation SET generation=?').run(
            Number.MAX_SAFE_INTEGER + 1
          );
        }
        if (invalid === 'missing-index') {
          db.exec('DROP INDEX state_message_scope');
        }
      } finally {
        db.close();
      }
      const baseline = retained(f.dbPath, 9, false);
      const truth = truthHash(f.root);
      await expect(openIndexer(f.options, deadlines)).rejects.toThrow();
      expect(retained(f.dbPath, 9, false)).toEqual(baseline);
      const audit = openConnection(f.dbPath, { readonly: true });
      try {
        expect(audit.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(9);
        expect(
          audit
            .prepare("SELECT count(*) FROM sqlite_schema WHERE name='state_observation_vectors'")
            .pluck()
            .get()
        ).toBe(0);
      } finally {
        audit.close();
      }
      expect(truthHash(f.root)).toBe(truth);
    } finally {
      await f.close();
    }
  });
}

it('preserves the retained schema 9 cleanup failure fence during upgrade and reopen', async () => {
  const f = await compatibleFixture(9);
  let port: Awaited<ReturnType<typeof openIndexer>> | undefined;
  try {
    const db = openConnection(f.dbPath);
    db.prepare('UPDATE state_message_generation SET pending_cleanup=1').run();
    db.close();
    const baseline = retained(f.dbPath, 9);
    port = await openIndexer(f.options, deadlines);
    await expect(port.queryStateMessageVectors(f.messageQuery)).rejects.toThrow('cleanup failed');
    await port.close();
    port = undefined;
    port = await openIndexer(f.options, deadlines);
    await expect(port.queryStateMessageVectors(f.messageQuery)).rejects.toThrow('cleanup failed');
    expect(retained(f.dbPath, 9)).toEqual(baseline);
  } finally {
    await port?.close();
    await f.close();
  }
});

for (const [version, alteration] of [
  [9, 'extra-profile-column'],
  [9, 'altered-scope-index'],
  [8, 'missing-source-check'],
  [9, 'missing-source-check'],
  [8, 'ordinary-length'],
  [9, 'ordinary-length'],
  [8, 'ordinary-nan'],
  [9, 'ordinary-nan'],
  [8, 'ordinary-infinity'],
  [9, 'ordinary-infinity'],
] as const) {
  it(`refuses schema ${version} ${alteration} before DDL and leaves the original image unchanged`, async () => {
    const f = await compatibleFixture(version);
    let admitted: Awaited<ReturnType<typeof openIndexer>> | undefined;
    try {
      const db = openConnection(f.dbPath);
      try {
        if (alteration === 'extra-profile-column') {
          db.exec('ALTER TABLE state_message_profiles ADD COLUMN reviewed_extra TEXT');
        }
        if (alteration === 'altered-scope-index') {
          db.exec('DROP INDEX state_message_scope');
          db.exec(
            'CREATE INDEX state_message_scope ON state_message_vectors(resource_id,thread_id,profile_hash)'
          );
        }
        if (alteration === 'missing-source-check') {
          const source = f.recorded.schema.find((object) => object.name === 'state_index_source');
          if (!source) {
            throw new Error('Recorded source schema is missing');
          }
          db.exec('ALTER TABLE state_index_source RENAME TO reviewed_source_backup');
          db.exec(source.sql.replace(' CHECK(singleton=1)', ''));
          db.exec('INSERT INTO state_index_source SELECT * FROM reviewed_source_backup');
          db.exec('DROP TABLE reviewed_source_backup');
        }
        if (alteration.startsWith('ordinary-')) {
          const vector = Buffer.alloc(alteration === 'ordinary-length' ? 4 : 384 * 4);
          if (alteration === 'ordinary-nan') {
            vector.writeFloatLE(Number.NaN, 0);
          }
          if (alteration === 'ordinary-infinity') {
            vector.writeFloatLE(Number.POSITIVE_INFINITY, 0);
          }
          const original = f.recorded.rows['vec_chunks']?.[0];
          const id = original?.['id'];
          const rootId = original?.['root_id'];
          const bin = original?.['bin'];
          if (
            typeof id !== 'number' ||
            typeof rootId !== 'string' ||
            typeof bin !== 'object' ||
            bin === null
          ) {
            throw new Error('Recorded ordinary vector is missing');
          }
          db.transaction(() => {
            db.prepare('DELETE FROM vec_chunks').run();
            db.prepare('INSERT INTO vec_chunks(id,root_id,bin,emb) VALUES(?,?,vec_bit(?),?)').run(
              BigInt(id),
              rootId,
              Buffer.from(bin.hex, 'hex'),
              vector
            );
          })();
        }
      } finally {
        db.close();
      }
      const baseline = retained(f.dbPath, version, false);
      const bytes = readFileSync(f.dbPath);
      const truth = truthHash(f.root);
      const result = await openIndexer(f.options, deadlines).then(
        async (port) => {
          admitted = port;
          let lateFailure: string | undefined;
          try {
            if (alteration === 'extra-profile-column') {
              const messageId = '["thread",1]';
              const plan = await port.prepareStateMessageVectors({
                messages: [{ messageId, seq: 1 }],
                profile: f.recorded.memoryProfile,
                scope: f.messageQuery.scope,
              });
              await port.upsertStateMessageVectors({
                embeddings: [{ messageId, vectors: [f.recorded.memoryVector] }],
                plan,
              });
            } else if (alteration.startsWith('ordinary-')) {
              await port.search(f.vectorQuery);
            }
          } catch (error) {
            lateFailure = error instanceof Error ? error.message : String(error);
          }
          const audit = openConnection(f.dbPath, { readonly: true });
          try {
            return {
              admittedSchema: audit
                .prepare('SELECT schema_version FROM index_metadata')
                .pluck()
                .get(),
              lateFailure,
            };
          } finally {
            audit.close();
          }
        },
        (error: unknown) => error
      );
      expect(result).toMatchObject({ code: 'rebuild-required' });
      expect(readFileSync(f.dbPath)).toEqual(bytes);
      expect(retained(f.dbPath, version, false)).toEqual(baseline);
      const audit = openConnection(f.dbPath, { readonly: true });
      try {
        expect(audit.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(
          version
        );
        expect(
          audit
            .prepare("SELECT count(*) FROM sqlite_schema WHERE name='state_observation_vectors'")
            .pluck()
            .get()
        ).toBe(0);
        if (version === 8) {
          expect(
            audit
              .prepare("SELECT count(*) FROM sqlite_schema WHERE name='state_message_vectors'")
              .pluck()
              .get()
          ).toBe(0);
        }
      } finally {
        audit.close();
      }
      expect(truthHash(f.root)).toBe(truth);
    } finally {
      await admitted?.close();
      await f.close();
    }
  });
}
