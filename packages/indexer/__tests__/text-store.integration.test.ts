import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openIndexer } from '@brainstrike/indexer';
import { openConnection } from '@brainstrike/sqlite-native';
import { expect, it } from 'vitest';

const deadlines = { closeMs: 5000 };
it('acquires text storage without a model and keeps its identity across reopen', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'brainstrike-text-store-'));
  const options = {
    dbPath: path.join(directory, 'index.sqlite'),
    embedding: { indexMode: 'text-only' },
    rootIds: ['root'],
  } as const;
  let port = await openIndexer(options, deadlines);
  try {
    const info = await port.info();
    expect(info.storeId).toMatch(/^[a-f0-9]{64}$/u);
    const snapshot = {
      chunkLines: 1,
      content: 'canonical text\n',
      fileId: 'file',
      relativePath: 'file.ts',
      rootId: 'root',
    };
    const plan = await port.prepareFile(snapshot);
    expect(plan.chunks[0]?.embeddingHash).toBeNull();
    await port.commitTextFile({ plan });
    const found = await port.search({
      limit: 10,
      mode: 'bm25',
      rootIds: ['root'],
      text: 'canonical',
    });
    expect(found.storeId).toBe(info.storeId);
    expect(found.hits).toHaveLength(1);
    await port.close();
    port = await openIndexer(options, deadlines);
    expect((await port.info()).storeId).toBe(info.storeId);
    await port.close();
    port = await openIndexer({ ...options, embedding: { indexMode: 'open-existing' } }, deadlines);
    expect((await port.info()).storeId).toBe(info.storeId);
    expect(
      (await port.search({ limit: 10, mode: 'bm25', rootIds: ['root'], text: 'canonical' })).hits
    ).toEqual(found.hits);
    await port.commitTextFile({
      plan: await port.prepareFile({ ...snapshot, content: 'canonical text\nadditional text\n' }),
    });
    expect((await port.coverage({ rootIds: ['root'] })).totals).toEqual({
      chunks: 2,
      indexedFiles: 1,
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
