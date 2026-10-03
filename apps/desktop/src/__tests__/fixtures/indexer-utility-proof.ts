import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { IndexerHostManager } from '../../indexer-host-manager';
import {
  acquireIndexerHost,
  closeIndexerRuntime,
  destroyIndexerRuntime,
  getReadyIndexerHost,
  getReadyIndexerPort,
} from '../../indexer-runtime';

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
  const options = { dbPath, profile, rootIds: ['root-a', 'root-b'] };
  if (mode === 'positive') {
    assert.throws(getReadyIndexerHost, /unavailable/);
  }
  const manager =
    mode === 'positive'
      ? await acquireIndexerHost(options, deadlines)
      : await IndexerHostManager.create(
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
  if (mode === 'positive') {
    assert.equal(getReadyIndexerHost(), manager);
    assert.equal(getReadyIndexerPort(), port);
    assert.equal(await acquireIndexerHost(options, deadlines), manager);
    await assert.rejects(
      acquireIndexerHost({ ...options, rootIds: ['root-a'] }, deadlines),
      /explicitly closed/
    );
  }
  assert.equal(await manager.start(), port);
  const info = await port.info();
  assert.notEqual(info.pid, process.pid);
  assert.ok(info.writerThreadId > 0);
  assert.equal(info.journalMode, 'wal');
  assert.equal(info.readerQueryOnly, 1);
  assert.equal(info.vecVersion, 'v0.1.9');
  if (mode === 'positive') {
    await assert.rejects(
      closeIndexerRuntime(async () => {
        throw new Error('Reader cleanup held');
      }),
      /Reader cleanup held/
    );
    assert.throws(getReadyIndexerHost, /unavailable/);
    assert.equal((await port.info()).pid, info.pid);
    const readers = Promise.withResolvers<void>();
    const closing = closeIndexerRuntime(async () => readers.promise);
    await assert.rejects(
      destroyIndexerRuntime(async () => {}),
      /different close\/destroy/
    );
    readers.resolve();
    await closing;
    assert.equal(manager.exited, true);
    // The retained old owner was explicitly joined before fresh-host recovery below.
  }
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
  const activeManager =
    mode === 'positive' ? await acquireIndexerHost(options, deadlines) : manager;
  const activePort = await activeManager.start();
  const plan = await activePort.prepareFile(snapshot);
  await activePort.commitTextFile({ plan });
  assert.equal(
    (await activePort.search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'sqlite' })).hits
      .length,
    1
  );
  assert.equal(
    (await activePort.search({ limit: 10, mode: 'vector', profile, rootIds: ['root-a'], vector }))
      .hits.length,
    0
  );
  const backfill = await activePort.prepareFile(snapshot);
  assert.equal(backfill.unchanged, true);
  assert.equal(backfill.embeddingChunkIds.length, 1);
  await activePort.commitFile({
    embeddings: backfill.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
    plan: backfill,
    profile,
  });
  const search = { limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'sqlite' };
  assert.equal((await activePort.search(search)).hits.length, 1);
  assert.equal((await activePort.search({ ...search, rootIds: ['root-b'] })).hits.length, 0);
  assert.equal(
    (await activePort.search({ limit: 10, mode: 'vector', profile, rootIds: ['root-a'], vector }))
      .hits.length,
    1
  );
  assert.equal((await activePort.prepareFile(snapshot)).embeddingChunkIds.length, 0);
  const changed = await activePort.prepareFile({
    ...snapshot,
    content: 'replacement utility content\n',
  });
  await activePort.commitFile({
    embeddings: changed.embeddingChunkIds.map((chunkId) => ({ chunkId, vector })),
    plan: changed,
    profile,
  });
  assert.equal((await activePort.search(search)).hits.length, 0);
  assert.equal((await activePort.search({ ...search, text: 'replacement' })).hits.length, 1);
  if (mode === 'positive') {
    await closeIndexerRuntime(async () => {});
  } else {
    await activeManager.close();
  }
  assert.equal(activeManager.exited, true);
  const reopened =
    mode === 'positive'
      ? await acquireIndexerHost(options, deadlines)
      : await IndexerHostManager.create(
          { dbPath, profile, rootIds: ['root-a', 'root-b'] },
          deadlines,
          mode === 'positive' ? undefined : entryPath
        );
  const again = await reopened.start();
  assert.equal((await again.search({ ...search, text: 'replacement' })).hits.length, 1);
  if (mode === 'positive') {
    let readersJoined = false;
    await destroyIndexerRuntime(async () => {
      assert.equal((await again.info()).pid > 0, true);
      readersJoined = true;
    });
    assert.equal(readersJoined, true);
    assert.throws(getReadyIndexerHost, /unavailable/);
  } else {
    await reopened.destroy();
  }
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
