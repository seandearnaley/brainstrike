import assert from 'node:assert/strict';
import test from 'node:test';
import { createBenchmarkProgress } from './benchmark-progress.ts';
import { nativeBuildComplete } from './native-benchmark.ts';

const baseline = {
  authorizedCollectionIds: ['collection'],
  authorizedRootIds: ['root'],
  collectionReadiness: [{ embeddingSetId: 'collection', scanComplete: false }],
  embedding: {
    indexMode: 'vector-configured',
    profile: {
      dimensions: 384,
      dtype: 'fp16',
      modelId: 'model',
      revision: 'revision',
      tokenCap: 256,
    },
    profileHash: 'profile-hash',
  },
  kind: 'ready',
  queryPlan: {
    inferencePlan: {
      device: 'webgpu',
      dimensions: 384,
      dtype: 'fp16',
      modelId: 'model',
      revision: 'revision',
    },
    modelKey: 'local::model',
  },
  rootReadiness: [{ rootId: 'root', scanComplete: false }],
  storeId: 'store',
};

function fixture(initial = baseline) {
  let now = 0;
  let status = structuredClone(initial);
  let coverage = null;
  const records = [];
  const baselines = [];
  const progress = createBenchmarkProgress({
    baseline: structuredClone(initial),
    now: () => now,
    readCoverage: async () => coverage,
    readStatus: async () => {
      if (status instanceof Error) {
        throw status;
      }
      return status;
    },
    record: async (phase, value) => {
      (phase === 'benchmark-proved-progress' ? records : baselines).push({ phase, value });
    },
    startedAt: 0,
  });
  return {
    baselines,
    progress,
    records,
    setCoverage: (value) => {
      coverage = value;
    },
    setStatus: (value) => {
      status = value;
    },
    time: (value) => {
      now = value;
    },
  };
}

function complete(status = baseline) {
  return {
    ...structuredClone(status),
    collectionReadiness: [{ embeddingSetId: 'collection', scanComplete: true }],
    rootReadiness: [{ rootId: 'root', scanComplete: true }],
  };
}

test('historical publication credits each scope once while rejected coverage remains null', async () => {
  const f = fixture();
  f.time(100_000);
  f.setStatus({
    ...structuredClone(baseline),
    rootReadiness: [{ rootId: 'root', scanComplete: true }],
  });
  assert.equal(await f.progress.observe(), null);
  f.time(200_000);
  f.setStatus(complete());
  assert.equal(await f.progress.observe(), null);
  assert.equal(f.records.length, 2);
  assert.equal(f.baselines.length, 1);
  assert.equal(f.baselines[0].value.atMs, 0);
  assert.deepEqual(
    f.records.map((record) => record.value.elapsedMs),
    [100_000, 200_000]
  );
  f.time(400_000);
  f.progress.assertLive();
  f.time(400_001);
  assert.throws(f.progress.assertLive, /200-second stall window/);
});

test('repeats, rewinds and baseline-true receipts cannot refresh the guard', async () => {
  for (const initial of [baseline, complete()]) {
    const f = fixture(initial);
    await f.progress.observe();
    f.setStatus(complete());
    await f.progress.observe();
    const credits = f.records.length;
    for (const status of [complete(), baseline, complete()]) {
      f.time(200_000);
      f.setStatus(status);
      await f.progress.observe();
    }
    assert.equal(f.records.length, credits);
    assert.equal(credits, initial === baseline ? 2 : 0);
    f.time(200_001);
    assert.throws(f.progress.assertLive, /200-second stall window/);
  }
});

test('every exposed identity and scope inventory remains pinned after all scope credits', async () => {
  const mutations = [
    (s) => {
      s.storeId = 'other';
    },
    (s) => {
      s.embedding.indexMode = 'text-only';
    },
    (s) => {
      s.embedding.profileHash = 'other';
    },
    ...['modelId', 'revision', 'dtype', 'dimensions', 'tokenCap'].map((field) => (s) => {
      s.embedding.profile[field] = 'other';
    }),
    (s) => {
      s.queryPlan.modelKey = 'other';
    },
    ...['modelId', 'revision', 'dtype', 'dimensions', 'device'].map((field) => (s) => {
      s.queryPlan.inferencePlan[field] = 'other';
    }),
    (s) => {
      s.queryPlan = undefined;
    },
    (s) => {
      s.authorizedRootIds = ['other'];
    },
    (s) => {
      s.authorizedRootIds.push('root');
    },
    (s) => {
      s.authorizedCollectionIds = [];
    },
    (s) => {
      s.authorizedCollectionIds.push('collection');
    },
    (s) => {
      s.rootReadiness = [];
    },
    (s) => {
      s.rootReadiness = undefined;
    },
    (s) => {
      s.rootReadiness.push(s.rootReadiness[0]);
    },
    (s) => {
      s.rootReadiness[0].rootId = 'other';
    },
    (s) => {
      s.collectionReadiness[0].embeddingSetId = 'other';
    },
    (s) => {
      s.collectionReadiness = undefined;
    },
    (s) => {
      s.collectionReadiness.push(s.collectionReadiness[0]);
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(complete());
    await f.progress.observe();
    const changed = complete();
    mutate(changed);
    f.setStatus(changed);
    await assert.rejects(f.progress.observe, /identity|inventory/);
  }
});

test('accepted coverage cannot drift from cold identity and evidence failures remain fatal', async () => {
  const f = fixture(complete());
  f.setCoverage({ status: { ...complete(), storeId: 'other' } });
  await assert.rejects(f.progress.observe, /identity/);
  const failure = new Error('Evidence write failed');
  const progress = createBenchmarkProgress({
    baseline,
    now: () => 0,
    readCoverage: async () => assert.fail('Failed evidence must not continue'),
    readStatus: async () => baseline,
    record: async () => {
      throw failure;
    },
    startedAt: 0,
  });
  await assert.rejects(progress.observe, (error) => error === failure);
});

test('unavailable status and worker-only noise give no credit, while status exceptions stay fatal', async () => {
  const f = fixture();
  f.setStatus({ kind: 'unavailable', reason: 'retiring' });
  assert.equal(await f.progress.observe(), null);
  f.setStatus({ ...baseline, statusEvents: 999, workerActivity: 100 });
  await f.progress.observe();
  assert.equal(f.records.length, 0);
  const failure = new Error('Status transport failed');
  f.setStatus(failure);
  await assert.rejects(f.progress.observe, (error) => error === failure);
  f.time(200_001);
  assert.throws(f.progress.assertLive, /200-second stall window/);
});

test('scope receipt status cannot finish or replace accepted coverage; fresh full coverage still can', async () => {
  const f = fixture();
  const counts = { chunks: 1, indexedFiles: 1, missingVectors: 0, vectors: 1 };
  const scope = {
    collectionId: 'collection',
    files: 5000,
    mode: 'vector',
    profile: baseline.embedding.profile,
    rootId: 'root',
    storeId: 'store',
  };
  const snapshot = (totals, status) => ({
    collectionCoverage: {
      collections: [{ embeddingSetId: 'collection', ...totals }],
      embedding: baseline.embedding,
      roots: [],
      storeId: 'store',
      totals,
      vectorCoverageComplete: true,
    },
    coverage: {
      embedding: baseline.embedding,
      roots: [{ rootId: 'root', ...totals }],
      storeId: 'store',
      totals,
      vectorCoverageComplete: true,
    },
    inference: { active: false },
    status,
  });
  let accepted = snapshot(counts, baseline);
  f.setStatus(complete());
  assert.equal(await f.progress.observe(), null);
  assert.equal(
    nativeBuildComplete(accepted.status, accepted.coverage, scope, accepted.collectionCoverage),
    false
  );
  f.time(100_000);
  const fresh = snapshot(
    { chunks: 34_890, indexedFiles: 5000, missingVectors: 0, vectors: 34_890 },
    complete()
  );
  f.setCoverage(fresh);
  const observation = await f.progress.observe();
  assert.equal(observation, fresh);
  accepted = observation;
  assert.equal(
    nativeBuildComplete(accepted.status, accepted.coverage, scope, accepted.collectionCoverage),
    true
  );
  f.time(200_000);
  await f.progress.observe();
  f.time(300_001);
  assert.throws(f.progress.assertLive, /200-second stall window/);
});
