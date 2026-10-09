import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  IndexerOptions,
  IndexScope,
  ScopedCoverage,
  VectorProfile,
} from '@brainstrike/indexer';
import { vectorProfileHash } from '@brainstrike/indexer';
import { afterEach, expect, it, vi } from 'vitest';
import { IndexReader, IndexWriter } from '../src/store.js';

const profile = {
  dimensions: 384,
  distance: 'cosine',
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  provider: 'local',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const collection = { embeddingSetId: 'collection', kind: 'collection' } as const;
const workspace = { kind: 'workspace', rootId: 'root' } as const;
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) {
    await dispose();
  }
});

async function fixture(outsideProfile: VectorProfile = profile): Promise<{
  options: IndexerOptions;
  reader: IndexReader;
  writer: IndexWriter;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-coverage-lookup-'));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  const rootless = {
    embeddingSetId: collection.embeddingSetId,
    fileId: 'retained',
    profile,
    relativePath: null,
    rootId: null,
    sourcePath: '/imports/retained.txt',
  };
  const rooted = { ...rootless, fileId: 'rooted', relativePath: 'source.txt', rootId: 'root' };
  const empty = { ...rootless, fileId: 'empty' };
  const outside = {
    ...rootless,
    embeddingSetId: 'outside',
    fileId: 'outside',
    profile: outsideProfile,
  };
  const options: IndexerOptions = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    fileBindings: [rooted, rootless, empty, outside],
    rootIds: ['root'],
    scopes: [workspace, collection, { embeddingSetId: 'outside', kind: 'collection' }],
  };
  const writer = new IndexWriter(options);
  cleanup.push(() => {
    if (writer.db.open) {
      writer.close();
    }
  });
  for (const [file, content] of [
    [rooted, 'first\nsecond\n'],
    [rootless, 'retained\n'],
    [empty, ''],
    [outside, 'foreign\n'],
  ] as const) {
    const { profile: fileProfile, ...snapshot } = file;
    const plan = writer.scoped.prepare({
      profile: fileProfile,
      snapshot: { ...snapshot, chunkLines: 1, content },
    });
    writer.scoped.commitVector({
      embeddings: plan.embeddingChunkIds.map((chunkId) => ({
        chunkId,
        vector: Array.from({ length: fileProfile.dimensions }, (_, index) => (index === 0 ? 1 : 0)),
      })),
      plan,
      profile: fileProfile,
    });
  }
  const reader = new IndexReader(options);
  cleanup.push(() => {
    if (reader.db.open) {
      reader.db.close();
    }
  });
  return { options, reader, writer };
}

/** Record actual native query parameters and returned rows without replacing validation. */
function bindingReads(reader: IndexReader): Array<{ ids: string[]; rows: number }> {
  const reads: Array<{ ids: string[]; rows: number }> = [];
  const original = reader.db.prepare.bind(reader.db);
  const statements: Array<() => void> = [];
  const preparation = vi.spyOn(reader.db, 'prepare').mockImplementation((sql) => {
    const statement = original(sql);
    if (sql.includes('FROM file_records WHERE scoped=1')) {
      const all = statement.all.bind(statement);
      const execution = vi
        .spyOn(statement, 'all')
        .mockImplementation((...parameters: unknown[]) => {
          expect(reader.db.inTransaction).toBe(true);
          const ids: unknown = JSON.parse(String(parameters[0]));
          if (!(Array.isArray(ids) && ids.every((id): id is string => typeof id === 'string'))) {
            throw new TypeError('Expected actual canonical binding IDs.');
          }
          const rows = Reflect.apply(all, statement, parameters) as unknown[];
          reads.push({ ids, rows: rows.length });
          return rows;
        });
      statements.push(() => execution.mockRestore());
    }
    return statement;
  });
  cleanup.push(() => {
    for (const restore of statements) {
      restore();
    }
    preparation.mockRestore();
  });
  return reads;
}

it('reads and decodes each overlapping binding once while retaining ordered independent native counts', async () => {
  const { reader } = await fixture();
  const reads = bindingReads(reader);
  const batch = reader.scoped.coverageBatch([
    { profile, scope: workspace },
    { profile, scope: collection },
  ]);
  expect(batch.map((result) => result.counts.chunks)).toEqual([2, 3]);
  expect(batch.map((result) => result.scope)).toEqual([workspace, collection]);
  expect(batch.every((result) => result.vectorCoverageComplete)).toBe(true);
  expect(reads).toEqual([
    { ids: ['rooted'], rows: 1 },
    { ids: ['retained', 'empty'], rows: 2 },
  ]);
  expect(reader.db.inTransaction).toBe(false);
});

it('validates disjoint scopes including rootless and zero-chunk canonical files', async () => {
  const { reader } = await fixture();
  const reads = bindingReads(reader);
  const outside = { embeddingSetId: 'outside', kind: 'collection' } as const;
  const batch = reader.scoped.coverageBatch([
    { profile, scope: outside },
    { profile, scope: collection },
  ]);
  expect(batch.map((result) => result.counts.chunks)).toEqual([1, 3]);
  expect(batch.map((result) => result.scope)).toEqual([outside, collection]);
  expect(reads).toEqual([
    { ids: ['outside'], rows: 1 },
    { ids: ['rooted', 'retained', 'empty'], rows: 3 },
  ]);
});

it('removes the second native binding query when selections completely overlap', async () => {
  const { reader } = await fixture();
  const reads = bindingReads(reader);
  const batch = reader.scoped.coverageBatch([
    { profile, scope: collection },
    { profile, scope: collection },
  ]);
  expect(batch.map((result) => result.counts.chunks)).toEqual([3, 3]);
  expect(reads).toEqual([{ ids: ['rooted', 'retained', 'empty'], rows: 3 }]);
});

it('retains incomplete coverage for missing canonical rows on a fresh transaction', async () => {
  const { reader, writer } = await fixture();
  reader.scoped.coverageBatch([{ profile, scope: collection }]);
  writer.scoped.remove({ fileId: 'rooted', scope: workspace });
  const reads = bindingReads(reader);
  const batch = reader.scoped.coverageBatch([
    { profile, scope: workspace },
    { profile, scope: collection },
  ]);
  expect(batch.map((result) => result.counts.chunks)).toEqual([0, 1]);
  expect(batch.map((result) => result.counts.indexedFiles)).toEqual([0, 2]);
  expect(batch.every((result) => !result.vectorCoverageComplete)).toBe(true);
  expect(reads).toEqual([
    { ids: ['rooted'], rows: 0 },
    { ids: ['retained', 'empty'], rows: 2 },
  ]);
});

it.each([
  { fileId: 'rooted', kind: 'foreign metadata' },
  { fileId: 'retained', kind: 'foreign metadata' },
  { fileId: 'rooted', kind: 'invalid metadata bytes' },
  { fileId: 'retained', kind: 'invalid metadata bytes' },
] as const)('rejects $kind committed between batches on $fileId', async ({ fileId, kind }) => {
  const { reader, writer } = await fixture();
  const requests = [
    { profile, scope: workspace },
    { profile, scope: collection },
  ];
  reader.scoped.coverageBatch(requests);
  writer.db
    .prepare('UPDATE file_records SET source_path=? WHERE id=?')
    .run(kind === 'foreign metadata' ? '/changed' : Buffer.from([255]), fileId);
  expect(() => reader.scoped.coverageBatch(requests)).toThrow(
    kind === 'foreign metadata'
      ? expect.objectContaining({ code: 'file-ownership-changed' })
      : TypeError
  );
  expect(reader.db.inTransaction).toBe(false);
});

it('keeps distinct-profile validation fatal when other requests share already-validated bindings', async () => {
  const other = { ...profile, revision: 'b'.repeat(40) };
  const { reader, writer } = await fixture(other);
  const reads = bindingReads(reader);
  const requests = [
    { profile, scope: workspace },
    { profile, scope: collection },
    { scope: { embeddingSetId: 'outside', kind: 'collection' } as const },
    { profile: other, scope: { embeddingSetId: 'outside', kind: 'collection' } as const },
  ];
  const batch = reader.scoped.coverageBatch(requests);
  expect(batch.map((result) => result.profileHash)).toEqual([
    vectorProfileHash(profile),
    vectorProfileHash(profile),
    null,
    vectorProfileHash(other),
  ]);
  expect(batch.map((result) => result.counts.chunks)).toEqual([2, 3, 1, 1]);
  expect(reads.flatMap((read) => read.ids)).toEqual(['rooted', 'retained', 'empty', 'outside']);
  const corrupt = Buffer.alloc(other.dimensions * 4);
  corrupt.writeFloatLE(Number.NaN, 0);
  writer.db
    .prepare('UPDATE scoped_vectors SET emb=? WHERE profile_hash=?')
    .run(corrupt, vectorProfileHash(other));
  expect(() => reader.scoped.coverageBatch(requests)).toThrow('finite');
  expect(reader.db.inTransaction).toBe(false);
});

function coveragePlan(
  reader: IndexReader,
  scope: IndexScope
): { details: string; result: ScopedCoverage } {
  const preparation = vi.spyOn(reader.db, 'prepare');
  try {
    const result = reader.scoped.coverage({ profile, scope });
    const sql = preparation.mock.calls
      .map(([statement]) => statement)
      .find((statement) => statement.startsWith('SELECT count(DISTINCT f.id)'));
    if (!sql) {
      throw new Error('Actual scoped coverage did not prepare its count query.');
    }
    const selected = reader.scoped.authority.selectedFiles([scope]).map((file) => file.fileId);
    const rows = reader.db
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(
        vectorProfileHash(profile),
        scope.kind === 'workspace' ? scope.rootId : scope.embeddingSetId,
        JSON.stringify(selected)
      );
    return { details: rows.map((row) => row.detail).join('\n'), result };
  } finally {
    preparation.mockRestore();
  }
}

it('uses native file-ID lookup for actual workspace and collection counts with identical results', async () => {
  const { reader, writer } = await fixture();
  expect(reader.db.pragma('query_only', { simple: true })).toBe(1);
  const indexed = [workspace, collection].map((scope) => coveragePlan(reader, scope));
  for (const plan of indexed) {
    expect(plan.details).toMatch(/SEARCH c USING COVERING INDEX chunks_file_record/u);
    expect(plan.details).not.toMatch(/SCAN c /u);
  }
  expect(indexed[0]?.result.counts).toEqual({
    chunks: 2,
    indexedFiles: 1,
    missingVectors: 0,
    vectors: 2,
  });
  expect(indexed[1]?.result.counts).toEqual({
    chunks: 3,
    indexedFiles: 3,
    missingVectors: 0,
    vectors: 3,
  });
  writer.db.exec('DROP INDEX chunks_file_record');
  for (const [index, scope] of [workspace, collection].entries()) {
    const original = coveragePlan(reader, scope);
    expect(original.details).toMatch(/SCAN c /u);
    expect(original.result).toEqual(indexed[index]?.result);
  }
  writer.db.exec('CREATE INDEX chunks_file_record ON file_chunks(file_record_id)');
  for (const [index, scope] of [workspace, collection].entries()) {
    const restored = coveragePlan(reader, scope);
    expect(restored.details).toMatch(/SEARCH c USING COVERING INDEX chunks_file_record/u);
    expect(restored.result).toEqual(indexed[index]?.result);
  }
  expect(reader.scoped.coverage({ scope: collection }).counts).toEqual({
    chunks: 3,
    indexedFiles: 3,
    missingVectors: 3,
    vectors: 0,
  });
  expect(writer.db.inTransaction).toBe(false);
});

it('refuses schema6 unchanged and creates the lookup index only through explicit fresh rebuild', async () => {
  const { options, reader, writer } = await fixture();
  const storeId = writer.identity.storeId;
  reader.db.close();
  writer.db.prepare('UPDATE index_metadata SET schema_version=6').run();
  writer.close();
  const previous = await readFile(options.dbPath);
  const reopen = { ...options, embedding: { indexMode: 'open-existing' } };
  expect(() => new IndexWriter(reopen)).toThrow(
    expect.objectContaining({ code: 'rebuild-required' })
  );
  expect(() => new IndexReader(reopen)).toThrow(
    expect.objectContaining({ code: 'rebuild-required' })
  );
  expect(await readFile(options.dbPath)).toEqual(previous);
  const rebuilt = new IndexWriter({
    ...options,
    dbPath: path.join(path.dirname(options.dbPath), 'rebuilt.sqlite'),
  });
  try {
    expect(rebuilt.identity.storeId).not.toBe(storeId);
    expect(rebuilt.db.prepare('SELECT schema_version FROM index_metadata').pluck().get()).toBe(11);
    expect(rebuilt.db.prepare("PRAGMA index_info('chunks_file_record')").all()).toMatchObject([
      { name: 'file_record_id' },
    ]);
    expect(rebuilt.scoped.coverage({ profile, scope: collection }).counts.chunks).toBe(0);
    expect(await readFile(options.dbPath)).toEqual(previous);
  } finally {
    rebuilt.close();
  }
});

it('keeps fresh counts and fail-closed scope, profile and coarse-storage validation', async () => {
  const { reader, writer } = await fixture();
  expect(reader.scoped.coverage({ profile, scope: collection }).counts.chunks).toBe(3);
  writer.scoped.remove({ fileId: 'retained', scope: collection });
  expect(reader.scoped.coverage({ profile, scope: collection }).counts).toEqual({
    chunks: 2,
    indexedFiles: 2,
    missingVectors: 0,
    vectors: 2,
  });
  expect(() =>
    reader.scoped.coverage({ profile, scope: { kind: 'workspace', rootId: 'foreign' } })
  ).toThrow(expect.objectContaining({ code: 'scope-not-authorized' }));
  expect(() =>
    reader.scoped.coverage({ profile: { ...profile, tokenCap: 256 }, scope: collection })
  ).toThrow(expect.objectContaining({ code: 'profile-not-authorized' }));
  const id: unknown = writer.db
    .prepare('SELECT pk FROM scoped_vectors ORDER BY pk LIMIT 1')
    .pluck()
    .get();
  if (typeof id !== 'number') {
    throw new TypeError('Expected actual vector row ID.');
  }
  writer.db.prepare('DELETE FROM scope_vec_384 WHERE id=?').run(BigInt(id));
  expect(() => reader.scoped.coverage({ profile, scope: collection })).toThrow(
    expect.objectContaining({ code: 'rebuild-required' })
  );
});

it('keeps both coverage scopes in one WAL snapshot and invalidates the next batch after an external corrupt commit', async () => {
  const { reader, writer } = await fixture();
  const original = reader.db.prepare.bind(reader.db);
  let committed = false;
  const corrupt = Buffer.alloc(profile.dimensions * 4);
  corrupt.writeFloatLE(Number.NaN, 0);
  const prepare = vi.spyOn(reader.db, 'prepare').mockImplementation((sql) => {
    if (!committed && sql.startsWith('SELECT dimensions,emb FROM scoped_vectors')) {
      expect(reader.db.inTransaction).toBe(true);
      writer.db.prepare('UPDATE scoped_vectors SET emb=?').run(corrupt);
      committed = true;
    }
    return original(sql);
  });
  try {
    const batch = reader.scoped.coverageBatch([
      { profile, scope: workspace },
      { profile, scope: collection },
    ]);
    expect(reader.db.inTransaction).toBe(false);
    expect(committed).toBe(true);
    expect(batch.map((result) => result.counts.chunks)).toEqual([2, 3]);
    expect(batch[0]!.vectorCoverageComplete).toBe(true);
    expect(batch[1]!.vectorCoverageComplete).toBe(true);
    expect(
      prepare.mock.calls.filter(([sql]) =>
        sql.startsWith('SELECT dimensions,emb FROM scoped_vectors')
      )
    ).toHaveLength(1);
  } finally {
    prepare.mockRestore();
  }
  expect(() =>
    reader.scoped.coverageBatch([
      { profile, scope: workspace },
      { profile, scope: collection },
    ])
  ).toThrow('finite');
  expect(reader.db.inTransaction).toBe(false);
});
