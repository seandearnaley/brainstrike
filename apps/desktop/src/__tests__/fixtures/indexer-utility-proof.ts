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
// Only the close ladder has clocks (lifecycle R5(b)); startup and requests have none.
const deadlines = {
  closeMs: mode === 'close' || mode === 'startup' ? 150 : 5000,
  exitMs: 1000,
};
/** Past every former startup or request deadline (150 ms in these modes). */
const pastFormerDeadline = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));
async function run(): Promise<void> {
  await app.whenReady();
  const { openIndexer } = await import('@brainstrike/indexer');
  await assert.rejects(
    openIndexer(
      { dbPath, embedding: { indexMode: 'vector-configured', profile }, rootIds: ['root-a'] },
      deadlines
    ),
    /Standalone indexer requires Node/
  );
  const options = {
    dbPath,
    embedding:
      mode === 'positive'
        ? { indexMode: 'text-only' as const }
        : { indexMode: 'vector-configured' as const, profile },
    rootIds: ['root-a', 'root-b'],
  };
  if (mode === 'positive') {
    assert.throws(getReadyIndexerHost, /unavailable/);
  }
  const manager =
    mode === 'positive'
      ? await acquireIndexerHost(options, deadlines)
      : await IndexerHostManager.create(
          {
            dbPath,
            embedding: { indexMode: 'vector-configured', profile },
            rootIds: ['root-a', 'root-b'],
          },
          deadlines,
          mode === 'positive' ? undefined : entryPath
        );
  if (mode === 'startup') {
    // A utility that never reports ready is waited for, not retired by a clock (R3);
    // close escalates its unanswered cooperative close to a kill and joins the exit (R5(b)).
    const starting = manager.start().then(
      () => 'ready',
      (error: unknown) => error
    );
    await pastFormerDeadline();
    assert.equal(manager.exited, false);
    await assert.rejects(manager.close(), /close failed/);
    assert.equal(manager.exited, true);
    assert.ok((await starting) instanceof Error);
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
    // An unanswered request retires nothing (R2): the same utility keeps serving, and its
    // exit at close is what ends the request.
    const unanswered = port
      .search({ limit: 10, mode: 'bm25', rootIds: ['root-a'], text: 'sqlite' })
      .then(
        () => 'answered',
        (error: unknown) => error
      );
    await pastFormerDeadline();
    assert.equal(manager.exited, false);
    assert.equal((await port.info()).pid, info.pid);
    await manager.close();
    assert.equal(manager.exited, true);
    assert.ok((await unanswered) instanceof Error);
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
  if (mode === 'positive') {
    const textInfo = await activePort.info();
    assert.deepEqual(textInfo.embedding, { indexMode: 'text-only' });
    await assert.rejects(
      activePort.search({ limit: 10, mode: 'vector', profile, rootIds: ['root-a'], vector }),
      /not configured/
    );
    const configured = await activePort.configureVectorProfile(profile);
    assert.equal(configured.storeId, textInfo.storeId);
  } else {
    assert.equal(
      (await activePort.search({ limit: 10, mode: 'vector', profile, rootIds: ['root-a'], vector }))
        .hits.length,
      0
    );
  }
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
      ? await acquireIndexerHost(
          { ...options, embedding: { indexMode: 'open-existing' } },
          deadlines
        )
      : await IndexerHostManager.create(
          {
            dbPath,
            embedding: { indexMode: 'vector-configured', profile },
            rootIds: ['root-a', 'root-b'],
          },
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
