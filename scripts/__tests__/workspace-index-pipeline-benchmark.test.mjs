import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeWorkspaceIndexEvidence,
  integratedBenchmarkEnv,
  parseArgs,
  summarizeIntegratedBenchmarkEvidence,
} from '../../apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs';

const PIPELINE_SCRIPT = fileURLToPath(
  new URL('../../apps/desktop/scripts/benchmark-workspace-index-pipeline.mjs', import.meta.url)
);
const RECORDED_INTEGRATED_EVIDENCE = fileURLToPath(
  new URL('./fixtures/foreground-latency-evidence.recorded.json', import.meta.url)
);

// Evidence recorded by e2e/foreground-latency-under-index-build.desktop.test.ts
// (raw sample arrays trimmed to three entries).
function readRecordedIntegratedEvidence() {
  return JSON.parse(
    readFileSync(
      new URL('./fixtures/foreground-latency-evidence.recorded.json', import.meta.url),
      'utf8'
    )
  );
}

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
    samples: [
      createSnapshot({ elapsedMs: 0, embedded: 0 }),
      createSnapshot({ elapsedMs: 10_000, embedded: 100 }),
    ],
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
      analyzeWorkspaceIndexEvidence(
        createEvidence({ fatalLogMatches: ['DB host request timed out'] }),
        {
          requireDevice: 'webgpu',
        }
      ),
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

test('summarizeIntegratedBenchmarkEvidence returns the metric set of a valid run without raw samples', () => {
  const recorded = readRecordedIntegratedEvidence();
  assert.equal(recorded.status, 'valid');

  const summary = summarizeIntegratedBenchmarkEvidence(recorded);

  assert.equal(summary.status, 'valid');
  assert.equal(summary.commit, recorded.commit);
  assert.deepEqual(summary.build, recorded.build);
  assert.deepEqual(summary.metrics, recorded.metrics);
  assert.equal('rawSamplesMs' in summary, false);
});

test('summarizeIntegratedBenchmarkEvidence refuses an invalid run and names why', () => {
  const recorded = readRecordedIntegratedEvidence();
  const invalid = {
    ...recorded,
    invalidReasons: ['the build finished in 9896 ms, under the 60000 ms floor'],
    status: 'invalid',
  };

  assert.throws(() => summarizeIntegratedBenchmarkEvidence(invalid), /under the 60000 ms floor/);
});

test('summarizeIntegratedBenchmarkEvidence refuses evidence of another schema', () => {
  assert.throws(
    () => summarizeIntegratedBenchmarkEvidence(createEvidence()),
    /not foreground-latency benchmark evidence/
  );
});

test('parseArgs reads the integrated corpus size and rejects a non-positive one', () => {
  assert.equal(parseArgs(['--mode', 'integrated', '--files', '120']).files, 120);
  assert.throws(() => parseArgs(['--files', '0']), /--files requires a positive integer/);
});

test('integratedBenchmarkEnv hands the device, corpus size and evidence path to the spec', () => {
  const env = integratedBenchmarkEnv({ files: 120, requireDevice: 'wasm' }, '/tmp/evidence.json', {
    PATH: '/bin',
  });

  assert.equal(env.PATH, '/bin');
  assert.equal(env.BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_DEVICE, 'wasm');
  assert.equal(env.BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_FILES, '120');
  assert.equal(
    env.BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_EVIDENCE_PATH,
    '/tmp/evidence.json'
  );
});

test('summarizeIntegratedBenchmarkEvidence enforces a required device on both the configured and actual device', () => {
  const recorded = readRecordedIntegratedEvidence();
  assert.equal(recorded.config.device, 'webgpu');

  assert.equal(
    summarizeIntegratedBenchmarkEvidence(recorded, { requireDevice: 'webgpu' }).status,
    'valid'
  );
  assert.throws(
    () => summarizeIntegratedBenchmarkEvidence(recorded, { requireDevice: 'wasm' }),
    /requires device wasm, but the run was configured for webgpu and embedded on webgpu/
  );
  const actualMismatch = { ...recorded, build: { ...recorded.build, actualDevice: 'wasm' } };
  assert.throws(
    () => summarizeIntegratedBenchmarkEvidence(actualMismatch, { requireDevice: 'webgpu' }),
    /configured for webgpu and embedded on wasm/
  );
});

function runPipelineCli(args) {
  return spawnSync(process.execPath, [PIPELINE_SCRIPT, ...args], { encoding: 'utf8' });
}

test('the CLI exits non-zero when recorded integrated evidence ran on another device', () => {
  const mismatch = runPipelineCli([
    '--evidence',
    RECORDED_INTEGRATED_EVIDENCE,
    '--require-device',
    'wasm',
  ]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /requires device wasm/);

  const match = runPipelineCli([
    '--evidence',
    RECORDED_INTEGRATED_EVIDENCE,
    '--require-device',
    'webgpu',
  ]);
  assert.equal(match.status, 0, match.stderr);
  assert.equal(JSON.parse(match.stdout).status, 'valid');
});
