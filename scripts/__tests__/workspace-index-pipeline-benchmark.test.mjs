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
// Evidence recorded by e2e/full-workspace-index.desktop.test.ts over two real
// roots on WASM (samples trimmed to the first and the last two).
const RECORDED_FULL_RUN_EVIDENCE = fileURLToPath(
  new URL('./fixtures/full-workspace-index-evidence.recorded.json', import.meta.url)
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

function createSample({ elapsedMs, embedded, device = 'webgpu', scanComplete = embedded === 100 }) {
  return {
    capturedAt: new Date(1_800_000_000_000 + elapsedMs).toISOString(),
    elapsedMs,
    index: {
      actualDevice: device,
      authorizedRootIds: ['workspace-index-e2e-root-1'],
      chunkCount: 100,
      chunkedFileCount: 10,
      dtype: 'fp16',
      embeddedChunkCount: embedded,
      fileCount: 10,
      missingVectors: 100 - embedded,
      roots: [
        {
          chunks: 100,
          indexedFiles: 10,
          missingVectors: 100 - embedded,
          rootId: 'workspace-index-e2e-root-1',
          scanComplete,
          vectors: embedded,
        },
      ],
      scanComplete,
      status: 'ready',
      vectorCoverageComplete: embedded === 100,
    },
    memory: { embeddingHostWorkingSetMb: 512, rendererHeapUsedMb: 128 },
    worker: embedded > 0 ? { device, dtype: 'fp16', fallbackApplied: false } : null,
  };
}

function createEvidence(overrides = {}) {
  return {
    fatalLogMatches: [],
    requiredDevice: 'webgpu',
    roots: [{ path: '/workspace/root', rootId: 'workspace-index-e2e-root-1' }],
    samples: [
      createSample({ elapsedMs: 0, embedded: 0 }),
      createSample({ elapsedMs: 10_000, embedded: 100 }),
    ],
    schema: 'brainstrike.full-workspace-index.v2',
    status: 'completed',
    worker: { device: 'webgpu', dtype: 'fp16', fallbackApplied: false },
    ...overrides,
  };
}

test('analyzeWorkspaceIndexEvidence accepts a completed WebGPU run and computes throughput', () => {
  const result = analyzeWorkspaceIndexEvidence(createEvidence(), { requireDevice: 'webgpu' });

  assert.equal(result.finalCounts.embeddedChunkCount, 100);
  assert.equal(result.integratedChunksPerSecond, 10);
  assert.equal(result.maxHeapUsedMb, 128);
  assert.equal(result.maxEmbeddingHostWorkingSetMb, 512);
});

test('analyzeWorkspaceIndexEvidence rejects actual backend mismatch', () => {
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({ worker: { device: 'wasm', dtype: 'q8', fallbackApplied: false } }),
        { requireDevice: 'webgpu' }
      ),
    /actual embedding backend mismatch/
  );
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({
          samples: [
            createSample({ elapsedMs: 0, embedded: 0 }),
            createSample({ device: 'wasm', elapsedMs: 10_000, embedded: 100 }),
          ],
        }),
        { requireDevice: 'webgpu' }
      ),
    /query plan wasm/
  );
});

test('analyzeWorkspaceIndexEvidence rejects fallback-applied runtime metadata', () => {
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({ worker: { device: 'webgpu', dtype: 'fp16', fallbackApplied: true } }),
        { requireDevice: 'webgpu' }
      ),
    /fallbackApplied=true/
  );
});

test('analyzeWorkspaceIndexEvidence rejects a run with no actual worker metadata', () => {
  assert.throws(
    () => analyzeWorkspaceIndexEvidence(createEvidence({ worker: null })),
    /no actual embedding worker metadata/
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
            createSample({ elapsedMs: 0, embedded: 0 }),
            createSample({ elapsedMs: 10_000, embedded: 90 }),
          ],
        }),
        { requireDevice: 'webgpu' }
      ),
    /did not complete/
  );
});

test('analyzeWorkspaceIndexEvidence rejects a root whose scan has no complete receipt', () => {
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({
          samples: [
            createSample({ elapsedMs: 0, embedded: 0 }),
            createSample({ elapsedMs: 10_000, embedded: 100, scanComplete: false }),
          ],
        })
      ),
    /did not complete its 1 roots/
  );
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({
          roots: [
            { path: '/workspace/root', rootId: 'workspace-index-e2e-root-1' },
            { path: '/workspace/other', rootId: 'workspace-index-e2e-root-2' },
          ],
        })
      ),
    /did not complete its 2 roots/
  );
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({ roots: [{ path: '/workspace/other', rootId: 'another-root' }] })
      ),
    /did not complete its 1 roots/
  );
});

test('analyzeWorkspaceIndexEvidence refuses a failed run and evidence of another schema', () => {
  assert.throws(
    () =>
      analyzeWorkspaceIndexEvidence(
        createEvidence({ error: { message: 'made no progress', name: 'Error' }, status: 'failed' })
      ),
    /full run failed: made no progress/
  );
  assert.throws(
    () => analyzeWorkspaceIndexEvidence(readRecordedIntegratedEvidence()),
    /not full Workspace Index run evidence/
  );
});

test('analyzeWorkspaceIndexEvidence accepts the evidence the full-run verifier records', () => {
  const recorded = JSON.parse(readFileSync(RECORDED_FULL_RUN_EVIDENCE, 'utf8'));

  const result = analyzeWorkspaceIndexEvidence(recorded, {
    requireDevice: recorded.requiredDevice,
  });

  assert.equal(result.finalCounts.fileCount, 90);
  assert.equal(result.finalCounts.embeddedChunkCount, result.finalCounts.chunkCount);
  assert.deepEqual(
    result.finalCounts.roots.map((root) => root.rootId),
    recorded.roots.map((root) => root.rootId)
  );
  assert.equal(result.queryPlanDevice, recorded.requiredDevice);
  assert.ok(result.integratedChunksPerSecond > 0);
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

test('parseArgs refuses the retired stage benchmark modes', () => {
  assert.throws(() => parseArgs(['--mode', 'embedding-ceiling']), /Expected: integrated/);
  assert.throws(() => parseArgs(['--stage-ceiling', 'x=1']), /Unknown argument/);
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

/** The recording's device and the other one. */
function recordedDevices(recorded) {
  const device = recorded.config.device;
  assert.equal(recorded.build.actualDevice, device);
  return { device, other: device === 'wasm' ? 'webgpu' : 'wasm' };
}

test('summarizeIntegratedBenchmarkEvidence enforces a required device on both the configured and actual device', () => {
  const recorded = readRecordedIntegratedEvidence();
  const { device, other } = recordedDevices(recorded);

  assert.equal(
    summarizeIntegratedBenchmarkEvidence(recorded, { requireDevice: device }).status,
    'valid'
  );
  assert.throws(
    () => summarizeIntegratedBenchmarkEvidence(recorded, { requireDevice: other }),
    new RegExp(
      `requires device ${other}, but the run was configured for ${device} and embedded on ${device}`
    )
  );
  const actualMismatch = { ...recorded, build: { ...recorded.build, actualDevice: other } };
  assert.throws(
    () => summarizeIntegratedBenchmarkEvidence(actualMismatch, { requireDevice: device }),
    new RegExp(`configured for ${device} and embedded on ${other}`)
  );
});

function runPipelineCli(args) {
  return spawnSync(process.execPath, [PIPELINE_SCRIPT, ...args], { encoding: 'utf8' });
}

test('the CLI exits non-zero when recorded integrated evidence ran on another device', () => {
  const { device, other } = recordedDevices(readRecordedIntegratedEvidence());
  const mismatch = runPipelineCli([
    '--evidence',
    RECORDED_INTEGRATED_EVIDENCE,
    '--require-device',
    other,
  ]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, new RegExp(`requires device ${other}`));

  const match = runPipelineCli([
    '--evidence',
    RECORDED_INTEGRATED_EVIDENCE,
    '--require-device',
    device,
  ]);
  assert.equal(match.status, 0, match.stderr);
  assert.equal(JSON.parse(match.stdout).status, 'valid');
});

test('the CLI analyzes recorded full-run evidence and refuses it for another device', () => {
  const { requiredDevice } = JSON.parse(readFileSync(RECORDED_FULL_RUN_EVIDENCE, 'utf8'));
  const other = requiredDevice === 'wasm' ? 'webgpu' : 'wasm';

  const match = runPipelineCli(['--evidence', RECORDED_FULL_RUN_EVIDENCE]);
  assert.equal(match.status, 0, match.stderr);
  assert.equal(JSON.parse(match.stdout).requiredDevice, requiredDevice);

  const mismatch = runPipelineCli([
    '--evidence',
    RECORDED_FULL_RUN_EVIDENCE,
    '--require-device',
    other,
  ]);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, new RegExp(`expected ${other}`));
});
