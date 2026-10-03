import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { IndexerHostManager } from '../../indexer-host-manager';

const profile = {
  dimensions: 384,
  dtype: 'q8',
  modelId: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  tokenCap: 512,
} as const;
const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
const directory = process.env['BRAINSTRIKE_INDEXER_PROOF_DIR'];
if (!directory) {
  throw new Error('Indexer proof directory is required.');
}
const dbPath = path.join(directory, 'index.sqlite');
const entryPath = process.env['BRAINSTRIKE_INDEXER_PROOF_ENTRY'];
if (!entryPath) {
  throw new Error('Indexer proof entry is required.');
}
const mode = process.env['BRAINSTRIKE_INDEXER_PROOF_MODE'];
const deadlines = {
  closeMs: mode === 'close' ? 150 : 5000,
  exitMs: 1000,
  requestMs: mode === 'request' ? 150 : 5000,
  startupMs: mode === 'startup' ? 150 : 5000,
};
async function run(): Promise<void> {
  await app.whenReady();
  const { openIndexer } = await import('@brainstrike/indexer');
  await assert.rejects(
    openIndexer({ dbPath, profile, rootIds: ['root-a'] }, deadlines),
    /Standalone indexer requires Node/
  );
  const manager = await IndexerHostManager.create(
    { dbPath, profile, rootIds: ['root-a', 'root-b'] },
    deadlines,
    mode === 'positive' ? undefined : entryPath
  );
  if (mode === 'startup') {
    await assert.rejects(manager.start(), /startup exceeded/);
    await manager.close();
    await assert.rejects(manager.start(), /closed/);
    return;
  }
  const port = await manager.start();
  assert.equal(await manager.start(), port);
  const info = await port.info();
  assert.notEqual(info.pid, process.pid);
  assert.ok(info.writerThreadId > 0);
  assert.equal(info.journalMode, 'wal');
  assert.equal(info.readerQueryOnly, 1);
  assert.equal(info.vecVersion, 'v0.1.9');
  if (mode === 'request') {
    await assert.rejects(
      port.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'sqlite' }),
      /request exceeded/
    );
    assert.equal(manager.exited, true);
    await manager.close();
    return;
  }
  if (mode === 'close') {
    await assert.rejects(manager.close(), /close failed/);
    assert.equal(manager.exited, true);
    await manager.close();
    return;
  }
  const snapshot = {
    chunkLines: 1,
    content: 'canonical sqlite utility indexing\n',
    fileId: 'file-1',
    relativePath: 'proof.ts',
    rootId: 'root-a',
  };
  const plan = await port.prepareFile(snapshot);
  await port.commitTextFile({ plan });
  assert.equal(
    (await port.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'sqlite' })).hits
      .length,
    1
  );
  assert.equal(
    (await port.search({ limit: 10, mode: 'vector', profile, rootIds: ['root-a'], vector })).hits
      .length,
    0
  );
  const backfill = await port.prepareFile(snapshot);
  assert.equal(backfill.unchanged, true);
  assert.equal(backfill.embeddingChunkIds.length, 1);
  await port.commitFile({
    embeddings: backfill.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
    plan: backfill,
    profile,
  });
  const search = { limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'sqlite' };
  assert.equal((await port.search(search)).hits.length, 1);
  assert.equal((await port.search({ ...search, rootIds: ['root-b'] })).hits.length, 0);
  assert.equal(
    (await port.search({ limit: 10, mode: 'vector', profile, rootIds: ['root-a'], vector })).hits
      .length,
    1
  );
  assert.equal((await port.prepareFile(snapshot)).embeddingChunkIds.length, 0);
  const changed = await port.prepareFile({ ...snapshot, content: 'replacement utility content\n' });
  await port.commitFile({
    embeddings: changed.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
    plan: changed,
    profile,
  });
  assert.equal((await port.search(search)).hits.length, 0);
  assert.equal((await port.search({ ...search, text: 'replacement' })).hits.length, 1);
  await manager.close();
  assert.equal(manager.exited, true);
  const reopened = await IndexerHostManager.create(
    { dbPath, profile, rootIds: ['root-a', 'root-b'] },
    deadlines,
    mode === 'positive' ? undefined : entryPath
  );
  const again = await reopened.start();
  assert.equal((await again.search({ ...search, text: 'replacement' })).hits.length, 1);
  await reopened.destroy();
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    await assert.rejects(access(file));
  }
  console.log(
    JSON.stringify({
      electron: process.versions.electron,
      incremental: true,
      info,
      mode,
      reopen: true,
      reset: true,
    })
  );
}
void run().then(
  () => {
    console.log(`INDEXER_UTILITY_PROOF_OK:${mode}`);
    app.exit(0);
  },
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
