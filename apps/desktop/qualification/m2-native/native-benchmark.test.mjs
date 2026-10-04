import assert from 'node:assert/strict';
import test from 'node:test';
import { assessNativeBenchmark, nativeBuildComplete } from './native-benchmark.ts';

const profile = {
  dimensions: 384,
  dtype: 'fp16',
  modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
  revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  tokenCap: 256,
};
const embedding = { indexMode: 'vector-configured', profile, profileHash: 'fixture-profile-hash' };
const counts = { chunks: 6962, indexedFiles: 1000, missingVectors: 0, vectors: 6962 };
const status = {
  authorizedRootIds: ['root'],
  embedding,
  kind: 'ready',
  rootReadiness: [{ rootId: 'root', scanComplete: true }],
  storeId: 'store',
};
const coverage = {
  embedding,
  roots: [{ rootId: 'root', ...counts }],
  storeId: 'store',
  totals: counts,
  vectorCoverageComplete: true,
};
const scope = { files: 1000, mode: 'vector', profile, rootId: 'root', storeId: 'store' };
const pairScope = { ...scope, collectionId: 'collection' };
const pairStatus = {
  ...status,
  authorizedCollectionIds: ['collection'],
  collectionReadiness: [{ embeddingSetId: 'collection', scanComplete: true }],
};
const collectionCoverage = {
  ...coverage,
  collections: [{ embeddingSetId: 'collection', ...counts }],
  roots: [],
};

test('workspace completion and full collection counters cannot finish an unsettled collection', () => {
  assert.equal(
    nativeBuildComplete(
      {
        ...pairStatus,
        collectionReadiness: [{ embeddingSetId: 'collection', scanComplete: false }],
      },
      coverage,
      pairScope,
      collectionCoverage
    ),
    false
  );
});

test('both settled scopes must match the captured store, collection, profile and full coverage', () => {
  assert.equal(nativeBuildComplete(pairStatus, coverage, pairScope, collectionCoverage), true);
  const invalid = [
    [pairStatus, null],
    [{ ...pairStatus, collectionReadiness: [] }, collectionCoverage],
    [{ ...pairStatus, authorizedCollectionIds: ['replacement'] }, collectionCoverage],
    [
      {
        ...pairStatus,
        collectionReadiness: [{ embeddingSetId: 'replacement', scanComplete: true }],
      },
      collectionCoverage,
    ],
    [pairStatus, { ...collectionCoverage, storeId: 'retired-store' }],
    [
      pairStatus,
      { ...collectionCoverage, collections: [{ embeddingSetId: 'replacement', ...counts }] },
    ],
    [
      pairStatus,
      {
        ...collectionCoverage,
        embedding: { ...embedding, profile: { ...profile, revision: 'main' } },
      },
    ],
    [
      pairStatus,
      { ...collectionCoverage, embedding: { ...embedding, profileHash: 'retired-profile' } },
    ],
    [pairStatus, { ...collectionCoverage, totals: { ...counts, indexedFiles: 999 } }],
    [
      pairStatus,
      {
        ...collectionCoverage,
        collections: [{ embeddingSetId: 'collection', ...counts, vectors: 0 }],
      },
    ],
    [pairStatus, { ...collectionCoverage, vectorCoverageComplete: false }],
  ];
  for (const [currentStatus, currentCoverage] of invalid) {
    assert.equal(nativeBuildComplete(currentStatus, coverage, pairScope, currentCoverage), false);
  }
});

test('the fully settled TEXT pair uses both current receipts without claiming vector work', () => {
  const textEmbedding = { indexMode: 'text-only' };
  const textCounts = { ...counts, missingVectors: counts.chunks, vectors: 0 };
  const textStatus = { ...pairStatus, embedding: textEmbedding };
  const textCoverage = {
    ...coverage,
    embedding: textEmbedding,
    roots: [{ rootId: 'root', ...textCounts }],
    totals: textCounts,
    vectorCoverageComplete: false,
  };
  const textCollection = {
    ...collectionCoverage,
    collections: [{ embeddingSetId: 'collection', ...textCounts }],
    embedding: textEmbedding,
    totals: textCounts,
    vectorCoverageComplete: false,
  };
  assert.equal(
    nativeBuildComplete(textStatus, textCoverage, { ...pairScope, mode: 'text' }, textCollection),
    true
  );
});

test('native completion rejects complete counters without canonical scan or current identity', () => {
  assert.equal(nativeBuildComplete(status, coverage, scope), true);
  assert.equal(
    nativeBuildComplete(
      { ...status, rootReadiness: [{ rootId: 'root', scanComplete: false }] },
      coverage,
      scope
    ),
    false
  );
  assert.equal(
    nativeBuildComplete(status, { ...coverage, storeId: 'retired-store' }, scope),
    false
  );
  assert.equal(
    nativeBuildComplete({ ...status, authorizedRootIds: ['foreign'] }, coverage, scope),
    false
  );
  assert.equal(
    nativeBuildComplete(status, { ...coverage, vectorCoverageComplete: false }, scope),
    false
  );
  assert.equal(
    nativeBuildComplete(status, coverage, { ...scope, profile: { ...profile, revision: 'main' } }),
    false
  );
});

test('TEXT completion cannot satisfy vector coverage or profile requirements', () => {
  const textStatus = { ...status, embedding: { indexMode: 'text-only' } };
  const textCounts = { ...counts, missingVectors: 6962, vectors: 0 };
  const textCoverage = {
    ...coverage,
    embedding: textStatus.embedding,
    roots: [{ rootId: 'root', ...textCounts }],
    totals: textCounts,
    vectorCoverageComplete: false,
  };
  assert.equal(nativeBuildComplete(textStatus, textCoverage, { ...scope, mode: 'text' }), true);
  assert.equal(nativeBuildComplete(textStatus, textCoverage, scope), false);
});

test('completion rejects root counters that contradict the full coverage totals', () => {
  assert.equal(
    nativeBuildComplete(
      status,
      { ...coverage, roots: [{ rootId: 'root', ...counts, vectors: 0 }] },
      scope
    ),
    false
  );
});

test('fast historical corpus reports throughput but refuses sustained latency qualification', () => {
  const samples = {
    completedChunks: 6962,
    elapsedMs: 32_000,
    errors: [],
    idleChat: [6.5],
    idleFrames: [16.7],
    idleTool: [5],
    loadedChat: new Array(100).fill(10),
    loadedFrames: [16.7],
    loadedLongTasks: [],
    loadedTool: new Array(100).fill(6),
  };
  const result = assessNativeBenchmark(samples);
  assert.ok(result.chunksPerSecond > 213);
  assert.match(result.validityErrors[0], /60-second/);
  assert.equal(result.gates.throughput, true);
});

test('responsiveness gates catch real frame, chat and native tool regressions', () => {
  const samples = {
    completedChunks: 6962,
    elapsedMs: 100_000,
    errors: [],
    idleChat: [6.5],
    idleFrames: [16.7],
    idleTool: [5],
    loadedChat: new Array(100).fill(55),
    loadedFrames: [51],
    loadedLongTasks: [50.1],
    loadedTool: new Array(100).fill(10.1),
  };
  assert.deepEqual(assessNativeBenchmark(samples).gates, {
    chat: false,
    frames: false,
    nativeTool: false,
    throughput: false,
  });
});
