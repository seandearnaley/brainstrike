import assert from 'node:assert/strict';
import { test } from 'node:test';

import { analyzeWorkspaceIndexEvidence } from '../../apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs';

function createSnapshot({ embedded, elapsedMs, fallbackApplied = false, device = 'webgpu' }) {
  return {
    elapsedMs,
    snapshot: {
      chunkStatsByRoot: [
        {
          chunk_count: 100,
          embedded_chunk_count: embedded,
          pending_chunk_count: 100 - embedded,
          root_id: 'root-1',
        },
      ],
      embeddingHostStatus: {
        available: true,
        status: {
          embeddingRuntime: {
            actualWorkerMetadata: {
              device,
              dtype: 'fp32',
              fallbackApplied,
            },
            backendMismatch: device !== 'webgpu' || fallbackApplied,
            selectedDevicePreference: 'webgpu',
          },
        },
      },
      expectedCounts: [
        {
          expectedFileCount: 10,
          rootPath: '/workspace/root',
        },
      ],
      fileRecordsByRoot: [
        {
          chunked_file_count: embedded === 100 ? 10 : 5,
          file_count: 10,
          root_id: 'root-1',
          unchunked_file_count: embedded === 100 ? 0 : 5,
        },
      ],
      jobQueue: embedded === 100 ? [] : [{ count: 1, state: 'queued' }],
      memorySample: {
        usedJSHeapSize: 128 * 1024 * 1024,
      },
      selectedDevicePreference: {
        devicePref: 'webgpu',
        devicePrefConfigured: true,
      },
      syncStatus: {
        state: embedded === 100 ? 'idle' : 'running',
      },
    },
  };
}

function createEvidence(overrides = {}) {
  return {
    fatalLogMatches: [],
    requiredDevice: 'webgpu',
    roots: ['/workspace/root'],
    samples: [createSnapshot({ elapsedMs: 0, embedded: 0 }), createSnapshot({ elapsedMs: 10_000, embedded: 100 })],
    ...overrides,
  };
}

test('analyzeWorkspaceIndexEvidence accepts a completed WebGPU run and computes throughput', () => {
  const result = analyzeWorkspaceIndexEvidence(createEvidence(), {
    requireDevice: 'webgpu',
    stageCeilings: {
      chunkingCeilingChunksPerSecond: 20,
      dbCompletionCeilingChunksPerSecond: 20,
      embeddingCeilingChunksPerSecond: 20,
      importCeilingEquivalentChunksPerSecond: 20,
    },
  });

  assert.equal(result.finalCounts.embeddedChunkCount, 100);
  assert.equal(result.integratedChunksPerSecond, 10);
  assert.equal(result.bottleneckChunksPerSecond, 20);
  assert.equal(result.integratedToBottleneckRatio, 0.5);
});

test('analyzeWorkspaceIndexEvidence rejects actual backend mismatch', () => {
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({
          samples: [
            createSnapshot({ elapsedMs: 0, embedded: 0 }),
            createSnapshot({ device: 'wasm', elapsedMs: 10_000, embedded: 100 }),
          ],
        }),
        { requireDevice: 'webgpu' }
      ),
    /actual embedding backend mismatch/
  );
});

test('analyzeWorkspaceIndexEvidence rejects fallback-applied runtime metadata', () => {
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({
          samples: [
            createSnapshot({ elapsedMs: 0, embedded: 0 }),
            createSnapshot({ elapsedMs: 10_000, embedded: 100, fallbackApplied: true }),
          ],
        }),
        { requireDevice: 'webgpu' }
      ),
    /fallbackApplied=true/
  );
});

test('analyzeWorkspaceIndexEvidence rejects fatal log matches', () => {
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(createEvidence({ fatalLogMatches: ['DB host request timed out'] }), {
        requireDevice: 'webgpu',
      }),
    /fatal log patterns/
  );
});

test('analyzeWorkspaceIndexEvidence rejects incomplete terminal counts', () => {
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({
          samples: [
            createSnapshot({ elapsedMs: 0, embedded: 0 }),
            createSnapshot({ elapsedMs: 10_000, embedded: 90 }),
          ],
        }),
        { requireDevice: 'webgpu' }
      ),
    /did not complete/
  );
});
