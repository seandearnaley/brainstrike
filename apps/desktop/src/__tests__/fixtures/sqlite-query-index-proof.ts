import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteQueryDeadlineError } from '@brainstrike/sqlite-query';
import { app } from 'electron';
import { IndexerHostManager } from '../../indexer-host-manager';
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
      rootIds: ['captured-root'],
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
  installIndexQueryTarget(() => manager, { deadlineMs: 150, startupDeadlineMs: 5000 });
  const query = await openIndexQuery();
  assert.deepEqual(
    (
      await query.query('SELECT $1 AS duplicate, $1 AS duplicate', {
        bindings: { ['$1']: "x'; DELETE FROM file_chunks; --" },
      })
    ).rows,
    [["x'; DELETE FROM file_chunks; --", "x'; DELETE FROM file_chunks; --"]]
  );
  assert.equal(
    (
      await query.query(
        "SELECT COUNT(*) FROM file_chunks_fts WHERE file_chunks_fts MATCH 'embedding'"
      )
    ).rows[0]?.[0],
    1
  );
  assert.equal((await query.query('SELECT count(*) FROM vec_chunks')).rows[0]?.[0], 1);
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
  let parentTicks = 0;
  const ticker = setInterval(() => {
    parentTicks += 1;
  }, 5);
  try {
    await assert.rejects(
      query.query(
        'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT sum(n) FROM r'
      ),
      SqliteQueryDeadlineError
    );
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
  const second = await openIndexQuery();
  await closeAllIndexQueries();
  await assert.rejects(second.query('SELECT 1'));
  await assert.rejects(openIndexQuery(), /unavailable/);
  await manager.close();
  const reopened = await IndexerHostManager.create(
    {
      dbPath: databasePath,
      embedding: {
        indexMode: 'vector-configured',
        profile: { dimensions, dtype, modelId, revision, tokenCap },
      },
      rootIds: ['captured-root'],
    },
    { closeMs: 5000, exitMs: 1000, requestMs: 5000, startupMs: 5000 }
  );
  await reopened.start();
  installIndexQueryTarget(() => reopened, { deadlineMs: 1000, startupDeadlineMs: 5000 });
  const last = await openIndexQuery();
  assert.equal((await last.query('SELECT count(*) FROM file_chunks')).rows[0]?.[0], 1);
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
