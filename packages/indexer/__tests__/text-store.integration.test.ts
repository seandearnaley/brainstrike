import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { expect, it } from 'vitest';

const deadlines = { closeMs: 5000, exitMs: 5000, requestMs: 5000, startupMs: 5000 };
const profile = {
  dimensions: 384,
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  tokenCap: 256,
} as const;
it('acquires text storage without a model and explicitly configures vector identity without replacing text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-text-store-'));
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['root'],
  } as const;
  let port = await openIndexer(options, deadlines);
  try {
    const info = await port.info();
    expect(info.embedding).toEqual({ indexMode: 'text-only' });
    expect(info.storeId).toMatch(/^[a-f0-9]{64}$/u);
    const snapshot = {
      chunkLines: 1,
      content: 'canonical text\n',
      fileId: 'file',
      relativePath: 'file.ts',
      rootId: 'root',
    };
    const plan = await port.prepareFile(snapshot);
    expect(plan.embeddingChunkIds).toEqual([]);
    expect(plan.chunks[0]?.embeddingHash).toBeNull();
    await expect(port.commitFile({ embeddings: [], plan, profile })).rejects.toThrow(
      'not configured'
    );
    await port.commitTextFile({ plan });
    const found = await port.search({
      limit: 10,
      mode: 'bm25',
      rootIds: ['root'],
      text: 'canonical',
    });
    expect(found.storeId).toBe(info.storeId);
    expect(found.embedding).toEqual({ indexMode: 'text-only' });
    expect(found.hits).toHaveLength(1);
    await expect(
      port.search({
        limit: 10,
        mode: 'vector',
        profile,
        rootIds: ['root'],
        vector: Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0)),
      })
    ).rejects.toThrow('not configured');
    await port.close();
    port = await openIndexer(options, deadlines);
    expect((await port.info()).storeId).toBe(info.storeId);
    await expect(port.configureVectorProfile({ ...profile, dimensions: 768 })).rejects.toThrow(
      '384'
    );
    const mutation = openConnection(options.dbPath);
    mutation.exec(
      "CREATE TRIGGER abort_configuration BEFORE UPDATE OF embedding_hash ON file_chunks BEGIN SELECT RAISE(ABORT,'configuration rollback control'); END"
    );
    await expect(port.configureVectorProfile(profile)).rejects.toThrow('rollback control');
    expect((await port.info()).embedding).toEqual({ indexMode: 'text-only' });
    expect((await port.prepareFile(snapshot)).chunks[0]?.embeddingHash).toBeNull();
    mutation.exec('DROP TRIGGER abort_configuration');
    mutation.prepare('UPDATE file_chunks SET embedding_hash=?').run('f'.repeat(64));
    await expect(port.coverage({ rootIds: ['root'] })).rejects.toThrow('identity');
    mutation.prepare('UPDATE file_chunks SET embedding_hash=NULL').run();
    mutation.close();
    const transition = await port.configureVectorProfile(profile);
    expect(transition.storeId).toBe(info.storeId);
    expect(transition.embedding).toMatchObject({ indexMode: 'vector-configured', profile });
    await expect(port.commitTextFile({ plan })).rejects.toThrow('state');
    const backfill = await port.prepareFile(snapshot);
    expect(backfill.embeddingChunkIds).toHaveLength(1);
    const vector = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));
    await port.commitFile({
      embeddings: backfill.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
      plan: backfill,
      profile,
    });
    expect((await port.coverage({ rootIds: ['root'] })).vectorCoverageComplete).toBe(true);
    expect(await port.configureVectorProfile(profile)).toEqual(transition);
    await expect(port.configureVectorProfile({ ...profile, tokenCap: 512 })).rejects.toThrow(
      'rebuild'
    );
    expect((await port.info()).embedding).toEqual(transition.embedding);
    await port.close();
    await expect(openIndexer(options, deadlines)).rejects.toThrow('rebuild');
    port = await openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines);
    expect((await port.info()).embedding).toEqual(transition.embedding);
    expect((await port.info()).storeId).toBe(info.storeId);
    expect(
      (await port.search({ limit: 10, mode: 'bm25', rootIds: ['root'], text: 'canonical' })).hits
    ).toEqual(found.hits);
    await port.commitTextFile({
      plan: await port.prepareFile({ ...snapshot, content: 'canonical text\nadditional text\n' }),
    });
    expect((await port.coverage({ rootIds: ['root'] })).totals).toMatchObject({
      chunks: 2,
      missingVectors: 1,
      vectors: 1,
    });
  } finally {
    await port.close();
    await rm(directory, { force: true, recursive: true });
  }
});

it('explicit open-existing refuses missing, corrupt and prior-schema stores without creating or erasing files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-existing-index-'));
  const dbPath = path.join(directory, 'index.sqlite');
  const options = { dbPath, embedding: { indexMode: 'open-existing' }, rootIds: ['root'] };
  try {
    await expect(openIndexer(options, deadlines)).rejects.toMatchObject({
      code: 'index-not-found',
    });
    await expect(access(dbPath)).rejects.toThrow();
    const port = await openIndexer(
      { ...options, embedding: { indexMode: 'text-only' } },
      deadlines
    );
    await port.commitTextFile({
      plan: await port.prepareFile({
        chunkLines: 1,
        content: 'retained source',
        fileId: 'file',
        relativePath: 'file.ts',
        rootId: 'root',
      }),
    });
    await port.close();
    const db = openConnection(dbPath);
    const identity = db.prepare('SELECT store_id FROM index_metadata').get();
    db.prepare('UPDATE index_metadata SET schema_version=3').run();
    await expect(openIndexer(options, deadlines)).rejects.toMatchObject({
      code: 'rebuild-required',
    });
    expect(db.prepare('SELECT store_id FROM index_metadata').get()).toEqual(identity);
    expect(db.prepare('SELECT content FROM file_chunks').pluck().get()).toBe('retained source');
    db.prepare('UPDATE index_metadata SET schema_version=4,store_id=?').run('invalid');
    await expect(openIndexer(options, deadlines)).rejects.toMatchObject({
      code: 'rebuild-required',
    });
    expect(db.prepare('SELECT content FROM file_chunks').pluck().get()).toBe('retained source');
    db.close();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
