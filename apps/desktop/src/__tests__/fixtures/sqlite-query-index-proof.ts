import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteQueryDeadlineError } from '@brainstrike/sqlite-query';
import { app } from 'electron';
import { IndexerHostManager } from '../../indexer-host-manager';
import { createNativeIndexSearchCapability } from '../../native-index-search';
import {
  closeAllIndexQueries,
  installIndexQueryTarget,
  openIndexQuery,
} from '../../sqlite-query-host-manager';

async function run(): Promise<void> {
  const directory = process.env['BRAINSTRIKE_QUERY_PROOF_DIR'];
  const fixturePath = process.env['BRAINSTRIKE_QUERY_PROOF_VECTOR'];
  assert.ok(directory && fixturePath, 'Isolated proof paths are required.');
  app.setPath('userData', directory);
  await app.whenReady();
  const fixture: {
    source: { text: string };
    profile: {
      modelId: string;
      revision: string;
      dtype: string;
      dimensions: number;
      maxInputTokens: number;
    };
    vector: number[];
  } = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.equal(fixture.vector.length, 384);
  assert.ok(fixture.vector.every(Number.isFinite));
  const profile = { ...fixture.profile, tokenCap: fixture.profile.maxInputTokens };
  const { modelId, revision, dtype, dimensions, tokenCap } = profile;
  const databasePath = path.join(directory, 'index.sqlite');
  const manager = await IndexerHostManager.create(
    {
      dbPath: databasePath,
      embedding: {
        indexMode: 'vector-configured',
        profile: { dimensions, dtype, modelId, revision, tokenCap },
      },
      rootIds: ['captured-root', 'runaway-root'],
    },
    { closeMs: 5000, exitMs: 1000, requestMs: 5000, startupMs: 5000 }
  );
  const index = await manager.start();
  const snapshot = {
    chunkLines: 1000,
    content: fixture.source.text,
    fileId: 'captured-file',
    relativePath: 'embedding.worker.ts',
    rootId: 'captured-root',
  };
  const plan = await index.prepareFile(snapshot);
  assert.equal(plan.chunks.length, 1, 'Recorded vector applies only to its exact captured text.');
  await index.commitFile({
    embeddings: plan.embeddingChunkIds.map((chunkId) => ({ chunkId, vector: fixture.vector })),
    plan,
    profile: { dimensions, dtype, modelId, revision, tokenCap },
  });
  // One line that `\w+\d` backtracks over quadratically (`\w` overlaps `\d`, so V8 cannot
  // make the `+` atomic): a grep that outlives any deadline here.
  const runawayPlan = await index.prepareFile({
    chunkLines: 1,
    content: `${'a'.repeat(300_000)}\n`,
    fileId: 'runaway-file',
    relativePath: 'runaway.txt',
    rootId: 'runaway-root',
  });
  await index.commitTextFile({ plan: runawayPlan });
  const runaway = {
    caseSensitive: true,
    isRegex: true,
    maxRows: 1,
    pattern: String.raw`\w+\d`,
    rootIds: ['runaway-root'],
  };
  // The reader loads no sqlite-vec, yet this vector-configured index holds a stored vector.
  const inspector = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(
      inspector.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='vec_chunks'").get()?.[
        'n'
      ],
      1
    );
    assert.ok(
      Number(inspector.prepare('SELECT count(*) AS n FROM vec_chunks_rowids').get()?.['n']) > 0
    );
  } finally {
    inspector.close();
  }
  installIndexQueryTarget(() => manager, { deadlineMs: 150, startupDeadlineMs: 5000 });
  const query = await openIndexQuery();
  const grep = await query.grep({
    caseSensitive: false,
    isRegex: false,
    maxRows: 100,
    pattern: 'embedding',
    rootIds: ['captured-root'],
  });
  assert.deepEqual(grep.identity, {
    embedding: (await index.info()).embedding,
    storeId: (await index.info()).storeId,
  });
  assert.equal(grep.rows[0]?.[0], plan.chunks[0]?.chunkId);
  const capability = createNativeIndexSearchCapability({
    acquireIndexer: async () => index,
    getAuthorizedRootIds: async () => ['captured-root'],
    getRootReadiness: async () => [{ rootId: 'captured-root', scanComplete: false }],
    openQuery: openIndexQuery,
  });
  const projectedGrep = await capability.grep({
    caseSensitive: false,
    isRegex: false,
    limit: 100,
    pattern: 'embedding',
    rootIds: ['captured-root'],
  });
  assert.equal(projectedGrep.hits[0]?.chunkId, plan.chunks[0]?.chunkId);
  assert.equal(projectedGrep.hits[0]?.content, fixture.source.text);
  assert.equal(projectedGrep.scanLimited, false);
  assert.deepEqual((await capability.status()).kind, 'ready');
  await assert.rejects(
    capability.grep({
      caseSensitive: false,
      isRegex: false,
      limit: 100,
      pattern: 'embedding',
      rootIds: ['disconnected-root'],
    }),
    /not currently authorized/
  );

  let parentTicks = 0;
  const ticker = setInterval(() => {
    parentTicks += 1;
  }, 5);
  try {
    await assert.rejects(query.grep(runaway), SqliteQueryDeadlineError);
  } finally {
    clearInterval(ticker);
  }
  assert.ok(parentTicks > 0, 'Main remains responsive during utility query execution.');
  await query.close();
  assert.equal(
    (await index.search({ limit: 10, mode: 'bm25', rootIds: ['captured-root'], text: 'embedding' }))
      .hits.length,
    1
  );
  // Host Stop, reset and shutdown join an in-flight grep through closeAllIndexQueries.
  await closeAllIndexQueries();
  installIndexQueryTarget(() => manager, { deadlineMs: 60_000, startupDeadlineMs: 5000 });
  const second = await openIndexQuery();
  const inflight = second.grep(runaway).catch((error: unknown) => error);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await closeAllIndexQueries();
  assert.match(String(await inflight), /SQLite query client is closed/);
  await assert.rejects(openIndexQuery(), /unavailable/);
  await manager.close();
  const reopened = await IndexerHostManager.create(
    {
      dbPath: databasePath,
      embedding: {
        indexMode: 'vector-configured',
        profile: { dimensions, dtype, modelId, revision, tokenCap },
      },
      rootIds: ['captured-root', 'runaway-root'],
    },
    { closeMs: 5000, exitMs: 1000, requestMs: 5000, startupMs: 5000 }
  );
  await reopened.start();
  installIndexQueryTarget(() => reopened, { deadlineMs: 1000, startupDeadlineMs: 5000 });
  const last = await openIndexQuery();
  assert.deepEqual(
    (
      await last.grep({
        caseSensitive: false,
        isRegex: false,
        maxRows: 100,
        pattern: 'embedding',
        rootIds: ['captured-root'],
      })
    ).rows.map((row) => row[0]),
    [plan.chunks[0]?.chunkId]
  );
  await closeAllIndexQueries();
  await reopened.destroy();
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    await assert.rejects(access(file));
  }
  console.log(
    JSON.stringify({
      electron: process.versions.electron,
      orderedReset: true,
      parentTicks,
      recordedVector: true,
      reopen: true,
    })
  );
}
void run().then(
  () => {
    console.log('SQLITE_QUERY_INDEX_PROOF_OK');
    app.exit(0);
  },
  (error) => {
    console.error(error);
    app.exit(1);
  }
);
