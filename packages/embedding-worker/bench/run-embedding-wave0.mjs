import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, _electron as electron } from 'playwright';

// Explicit real-model probe. Requires a built worker and downloads model assets.
// Local worker throughput is diagnostic evidence, not the real-app M2 exit.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const surface = process.env['EMBEDDING_PROBE_SURFACE'] ?? 'chromium';
assert.ok(surface === 'chromium' || surface === 'electron');
const device = process.env['EMBEDDING_PROBE_DEVICE'] ?? 'wasm';
assert.ok(device === 'wasm' || device === 'webgpu');
const gpuDtype = process.env['EMBEDDING_PROBE_GPU_DTYPE'] ?? 'fp16';
assert.ok(gpuDtype === 'fp16' || gpuDtype === 'fp32');
const revisions = {
  'onnx-community/all-MiniLM-L6-v2-ONNX': 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
  'Xenova/all-MiniLM-L6-v2': '751bff37182d3f1213fa05d7196b954e230abad9',
};
const inputCount = Number(process.env['EMBEDDING_PROBE_INPUT_COUNT'] ?? 128);
assert.ok(Number.isSafeInteger(inputCount) && inputCount > 0 && inputCount <= 128);
const profiles =
  device === 'webgpu'
    ? [
        ['Xenova/all-MiniLM-L6-v2', gpuDtype],
        ['onnx-community/all-MiniLM-L6-v2-ONNX', gpuDtype],
      ]
    : [
        ['Xenova/all-MiniLM-L6-v2', 'fp32'],
        ['Xenova/all-MiniLM-L6-v2', 'q8'],
        ['onnx-community/all-MiniLM-L6-v2-ONNX', 'fp32'],
      ];
const corpus = await readFile(new URL('../src/embedding.worker.ts', import.meta.url), 'utf8');
const texts = Array.from({ length: inputCount }, (_, index) =>
  corpus.slice(index * 350, index * 350 + 1200)
);
const output = await mkdtemp(join(tmpdir(), 'brainstrike-embedding-wave0-'));
await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: {
    client: 'packages/embedding-worker/src/streaming-worker-client.ts',
    worker: 'packages/embedding-worker/dist/embedding.worker.js',
  },
  external: ['onnxruntime-node', 'sharp'],
  format: 'esm',
  outdir: output,
  platform: 'browser',
});
const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Embedding worker probe</title>');
    return;
  }
  if (request.url !== '/worker.js' && request.url !== '/client.js') {
    response.writeHead(404).end();
    return;
  }
  response.setHeader('Content-Type', 'application/javascript');
  response.end(await readFile(join(output, request.url.slice(1))));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
let electronApp;
try {
  let page;
  let clientSource;
  let workerUrl;
  let launchSettings;
  if (surface === 'electron') {
    const requireDesktop = createRequire(join(root, 'apps/desktop/package.json'));
    const profile = join(output, 'profile');
    const { ELECTRON_RUN_AS_NODE: _ignored, ...baseEnv } = process.env;
    electronApp = await electron.launch({
      args: [
        join(root, 'apps/desktop/dist/main.js'),
        '--test-mode',
        '--brainstrike-desktop-launch-mode=test-built',
        `--user-data-dir=${profile}`,
      ],
      env: {
        ...baseEnv,
        ['BRAINSTRIKE_DB_ROOT_PATH']: profile,
        ['BRAINSTRIKE_DISABLE_FILE_LOGS']: '1',
        ['BRAINSTRIKE_E2E_USER_DATA_DIR']: profile,
      },
      executablePath: requireDesktop('electron'),
    });
    launchSettings = await electronApp.evaluate(({ app }) => ({
      disableFeatures: app.commandLine.getSwitchValue('disable-features'),
      gpuDisabled: app.commandLine.hasSwitch('disable-gpu'),
      gpuRasterization: app.commandLine.hasSwitch('enable-gpu-rasterization'),
      unsafeWebgpu: app.commandLine.hasSwitch('enable-unsafe-webgpu'),
      versions: process.versions,
      zeroCopy: app.commandLine.hasSwitch('enable-zero-copy'),
    }));
    assert.equal(launchSettings.gpuDisabled, false);
    assert.equal(launchSettings.gpuRasterization, false);
    assert.equal(launchSettings.zeroCopy, false);
    assert.equal(
      launchSettings.disableFeatures,
      'MacWebContentsOcclusion,SpareRendererForSitePerProcess'
    );
    process.stderr.write(`${JSON.stringify({ launchSettings })}\n`);
    const visiblePage = await electronApp.firstWindow();
    await visiblePage.waitForFunction(() =>
      Boolean(window.electronAPI?.storage && window.embeddingHost)
    );
    const status = await visiblePage.evaluate(async (devicePref) => {
      await window.electronAPI.storage.setItem(
        'vector-preferences.v1',
        JSON.stringify({
          state: {
            devicePref,
            devicePrefConfigured: true,
            reinitEveryN: 200,
            verboseOrtLogs: false,
          },
          version: 3,
        })
      );
      return window.embeddingHost.ensureStarted();
    }, device);
    assert.equal(status.state, 'running');
    assert.equal(status.lastError, null);
    page = electronApp
      .windows()
      .find((candidate) => candidate.url().includes('mode=embedding-host'));
    assert.ok(page, 'The actual hidden embedding host must exist.');
    const assets = await readdir(join(root, 'apps/desktop/dist/renderer/assets'));
    const workerFiles = assets.filter((name) => /^embedding\.worker-.*\.js$/u.test(name));
    assert.equal(workerFiles.length, 1);
    workerUrl = new URL(`./assets/${workerFiles[0]}`, page.url()).href;
    clientSource = await readFile(join(output, 'client.js'), 'utf8');
  } else {
    browser = await chromium.launch({
      args: device === 'webgpu' ? ['--enable-unsafe-webgpu'] : [],
      headless: true,
    });
    page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    workerUrl = new URL('/worker.js', page.url()).href;
  }
  page.on('pageerror', (error) => process.stderr.write(`${error.stack}\n`));
  await page.exposeFunction('reportEmbeddingProfile', (report) =>
    process.stderr.write(`${JSON.stringify({ profile: report })}\n`)
  );
  let adapter;
  if (device === 'webgpu') {
    adapter = await page.evaluate(async () => {
      const gpuAdapter = await navigator.gpu.requestAdapter();
      return gpuAdapter
        ? {
            features: [...gpuAdapter.features],
            info: {
              architecture: gpuAdapter.info.architecture,
              description: gpuAdapter.info.description,
              device: gpuAdapter.info.device,
              isFallbackAdapter: gpuAdapter.info.isFallbackAdapter,
              vendor: gpuAdapter.info.vendor,
            },
          }
        : null;
    });
    process.stderr.write(`${JSON.stringify({ adapter })}\n`);
  }
  const results = await page.evaluate(
    async ({ inputs, profiles, device, revisions, clientSource, workerUrl }) => {
      const clientModuleUrl =
        clientSource === undefined
          ? '/client.js'
          : URL.createObjectURL(new Blob([clientSource], { type: 'application/javascript' }));
      const { StreamingEmbeddingWorkerClient } = await import(clientModuleUrl);
      let client;
      const reports = [];
      let lastFrame = performance.now();
      let maxFrameGapMs = 0;
      let measuring = false;
      let frameHandle;
      function frame(now) {
        if (measuring) {
          maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame);
        }
        lastFrame = now;
        frameHandle = requestAnimationFrame(frame);
      }
      frameHandle = requestAnimationFrame(frame);
      async function run(model, dtype, texts, maxBatchSize = 64) {
        const revision = revisions[model];
        if (!revision) {
          throw new Error(`Missing pinned model revision for ${model}.`);
        }
        const vectors = [];
        const batches = [];
        const metadata = await client.stream(
          {
            deviceHint: device,
            dtype,
            id: crypto.randomUUID(),
            maxBatchSize,
            model,
            revision,
            texts,
            type: 'embed',
          },
          {
            onBatch(batch) {
              batches.push(batch.endIndex - batch.startIndex);
              for (const vector of batch.vectors) {
                if (vector.length !== 384 || !Array.from(vector).every(Number.isFinite)) {
                  throw new Error('Real worker returned invalid MiniLM vectors.');
                }
                vectors.push(Array.from(vector));
              }
            },
            signal: AbortSignal.timeout(180_000),
          }
        );
        if (
          vectors.length !== texts.length ||
          metadata.device !== device ||
          metadata.dtype !== dtype ||
          metadata.revision !== revision ||
          metadata.fallbackApplied
        ) {
          throw new Error('Real worker model/device/vector coverage differs from the request.');
        }
        return { batches, metadata, vectors };
      }
      try {
        for (const [model, dtype] of profiles) {
          client?.terminate();
          client = new StreamingEmbeddingWorkerClient({ workerUrl });
          await run(model, dtype, ['hello world'], 1);
          maxFrameGapMs = 0;
          measuring = true;
          const started = performance.now();
          const result = await run(model, dtype, inputs);
          const elapsedMs = performance.now() - started;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          measuring = false;
          reports.push({
            batchSizes: result.batches,
            chunksPerSecond: (inputs.length * 1000) / elapsedMs,
            count: inputs.length,
            dtype,
            elapsedMs,
            maxFrameGapMs,
            metadata: result.metadata,
            model,
          });
          await window.reportEmbeddingProfile(reports.at(-1));
        }
        const prefix = 'hello '.repeat(300);
        const capped = await run(
          'onnx-community/all-MiniLM-L6-v2-ONNX',
          profiles.at(-1)[1],
          [`${prefix}apple`, `${prefix}orange`],
          2
        );
        const maxTailDifference = Math.max(
          ...capped.vectors[0].map((value, index) => Math.abs(value - capped.vectors[1][index]))
        );
        if (maxTailDifference > 1e-6) {
          throw new Error(
            'Changing text beyond the MiniLM input cap changed the real worker vector.'
          );
        }
        return { maxTailDifference, reports, userAgent: navigator.userAgent };
      } finally {
        cancelAnimationFrame(frameHandle);
        client?.terminate();
        if (clientSource !== undefined) {
          URL.revokeObjectURL(clientModuleUrl);
        }
      }
    },
    { clientSource, device, inputs: texts, profiles, revisions, workerUrl }
  );
  assert.equal(results.reports.length, profiles.length);
  process.stdout.write(
    `${JSON.stringify({ ...results, adapter, launchSettings, surface }, null, 2)}\n`
  );
} finally {
  await browser?.close();
  await electronApp?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await rm(output, { recursive: true });
}
