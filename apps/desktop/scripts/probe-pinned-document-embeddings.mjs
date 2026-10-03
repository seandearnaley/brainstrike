import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

// Opt-in local proof: actual built app IPC → hidden renderer service → production worker.
// Model assets may download. No benchmark or packaged/cross-platform acceptance claim.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
const profile = await mkdtemp(join(tmpdir(), 'brainstrike-pinned-document-'));
const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;
const requestedDevice = process.env['PINNED_DOCUMENT_PROBE_DEVICE'] ?? 'wasm';
assert.ok(requestedDevice === 'wasm' || requestedDevice === 'webgpu');
const plans =
  requestedDevice === 'webgpu'
    ? [
        {
          device: 'webgpu',
          dimensions: 384,
          dtype: 'fp16',
          modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
          revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
        },
      ]
    : [
        {
          device: 'wasm',
          dimensions: 384,
          dtype: 'q8',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          revision: '751bff37182d3f1213fa05d7196b954e230abad9',
        },
        {
          device: 'wasm',
          dimensions: 384,
          dtype: 'fp32',
          modelId: 'Xenova/all-MiniLM-L6-v2',
          revision: '751bff37182d3f1213fa05d7196b954e230abad9',
        },
        {
          device: 'wasm',
          dimensions: 384,
          dtype: 'fp32',
          modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
          revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
        },
      ];
let app;
try {
  app = await electron.launch({
    args: [
      join(root, 'apps/desktop/dist/main.js'),
      '--test-mode',
      '--brainstrike-desktop-launch-mode=test-built',
      `--user-data-dir=${profile}`,
    ],
    env: {
      ...baseEnv,
      BRAINSTRIKE_DB_ROOT_PATH: profile,
      BRAINSTRIKE_DISABLE_FILE_LOGS: '1',
      BRAINSTRIKE_E2E_USER_DATA_DIR: profile,
    },
    executablePath: requireDesktop('electron'),
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.electronAPI?.storage && window.embeddingHost));
  await page.evaluate(async () => {
    await window.electronAPI.storage.setItem(
      'vector-preferences.v1',
      JSON.stringify({
        state: {
          devicePref: 'webgpu',
          devicePrefConfigured: true,
          reinitEveryN: 200,
          verboseOrtLogs: false,
        },
        version: 3,
      })
    );
    const status = await window.embeddingHost.ensureStarted();
    if (status.state !== 'running') {
      throw new Error(status.lastError ?? 'Hidden host did not start');
    }
  });
  const reports = await page.evaluate(async (explicitPlans) => {
    const results = [];
    for (const inferencePlan of explicitPlans) {
      const payload = {
        dimensions: inferencePlan.dimensions,
        inferencePlan,
        modelId: inferencePlan.modelId,
        modelKey: 'native:pinned-query-proof',
        texts: [
          'SQLite readers are isolated from the writer.',
          'token '.repeat(700),
          'SQLite readers are isolated from the writer.',
        ],
      };
      const first = await window.embeddingHost.documentEmbeddings(payload, {
        requestId: crypto.randomUUID(),
      });
      const second = await window.embeddingHost.documentEmbeddings(payload, {
        requestId: crypto.randomUUID(),
      });
      for (const batch of [first, second]) {
        if (
          !(
            batch.length === payload.texts.length &&
            batch.every(
              (vector) =>
                vector.length === 384 &&
                vector.every(Number.isFinite) &&
                vector.some((value) => value !== 0)
            )
          )
        ) {
          throw new Error('Invalid document vector batch');
        }
      }
      const difference = Math.max(
        ...first.flatMap((vector, vectorIndex) =>
          vector.map((value, index) => Math.abs(value - second[vectorIndex][index]))
        )
      );
      const duplicateDifference = Math.max(
        ...first[0].map((value, index) => Math.abs(value - first[2][index]))
      );
      const distinctDifference = Math.max(
        ...first[0].map((value, index) => Math.abs(value - first[1][index]))
      );
      if (difference > 1e-6 || duplicateDifference > 1e-6 || distinctDifference < 1e-6) {
        throw new Error('Document input order or deterministic vectors did not match');
      }
      const status = await window.embeddingHost.getStatus();
      const actual = status.embeddingRuntime?.actualWorkerMetadata;
      if (
        !(
          actual &&
          actual.device === inferencePlan.device &&
          actual.dtype === inferencePlan.dtype &&
          actual.fallbackApplied === false
        )
      ) {
        throw new Error(
          `Pinned document returned incorrect actual runtime metadata: ${JSON.stringify({ actual, status })}`
        );
      }
      results.push({
        actual,
        count: first.length,
        difference,
        dimensions: first[0].length,
        distinctDifference,
        duplicateDifference,
        inferencePlan,
      });
    }
    for (const invalidPlan of [
      { ...explicitPlans[0], revision: 'main' },
      { ...explicitPlans[0], revision: undefined },
    ]) {
      let rejected = false;
      try {
        await window.embeddingHost.documentEmbeddings(
          {
            dimensions: 384,
            inferencePlan: invalidPlan,
            modelId: invalidPlan.modelId,
            modelKey: 'native:pinned-query-proof',
            texts: ['reject invalid plan'],
          },
          { requestId: crypto.randomUUID() }
        );
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('revision'))) {
          throw error;
        }
        rejected = true;
      }
      if (!rejected) {
        throw new Error('Invalid pinned plan was accepted');
      }
    }
    return { invalidPlansRejected: 2, results };
  }, plans);
  assert.equal(reports.results.length, plans.length);
  process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
} finally {
  if (app) {
    await app.close();
  }
  await rm(profile, { force: true, recursive: true });
}
