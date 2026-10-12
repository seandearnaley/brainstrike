import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { setVectorDevicePreference } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import {
  type BackfillCompletion,
  calibrateRendererFrameProbe,
  installBuildSignals,
  installMainProbes,
  installRendererFrameProbe,
  type LatencySummary,
  type MainPhaseSamples,
  markRendererPhase,
  markRendererPhaseAtCompletion,
  pauseMainLoadedPhase,
  type RendererWindowSamples,
  readRendererWindows,
  resumeMainLoadedPhase,
  runMainIdlePhase,
  startMainLoadedPhase,
  stopMainLoadedPhase,
  summarize,
  waitForBackfillCompletion,
  warmUpMainProbes,
} from './utils/foreground-latency-probes';
import { type IndexBuildCorpus, writeIndexBuildCorpus } from './utils/index-build-corpus';
import { createIndexProgressWatch } from './utils/index-progress-watch';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/**
 * Loaded foreground-latency benchmark (BST-1925): the instrument behind working
 * rule 4. It runs a full Workspace Index build of a seeded corpus and measures,
 * idle (before the build) and loaded (during it):
 *
 * - renderer: rAF frame gaps and `longtask` entries in the visible window;
 * - main: event-loop lag (`monitorEventLoopDelay`);
 * - the chat path's per-step DB write (`recordDesktopAssistantRunEvent`);
 * - an agent tool's read (the tool file reader plus a grep-tool index query);
 * - build throughput in chunks/s.
 *
 * It REPORTS; it does not gate on the numbers. It fails only when the run
 * cannot produce valid numbers. See docs/performance/foreground-latency-under-index-build.md.
 */

const DEVICE_ENV = 'BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_DEVICE';
const FILES_ENV = 'BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_FILES';
const EVIDENCE_PATH_ENV = 'BRAINSTRIKE_WORKSPACE_INDEX_INTEGRATED_BENCHMARK_EVIDENCE_PATH';

const CORPUS_SEED = 1925;
const DEFAULT_FILES = 1000;
const PROBE_PERIOD_MS = 200;
const IDLE_SAMPLES = 150;
const WARMUP_SAMPLES = 10;
const MIN_LOADED_SAMPLES = 100;
const MIN_BUILD_MS = 60_000;
/** A visible window at display rate gaps ~16.7 ms; above this the frame metric is meaningless. */
const MAX_IDLE_FRAME_GAP_P50_MS = 20;
const LONG_FRAME_MS = 50;
/** A deliberate renderer block before the idle phase; the probe must see it. */
const CALIBRATION_BLOCK_MS = 120;
const WORKSPACE_RESOURCE_ID = 'brainstrike:workspace';
const BENCH_ROOT_ID = 'foreground-latency-benchmark-root';
/** Root-relative and never written, so the grep's index work is identical idle and loaded. */
const NEVER_INDEXED_GREP_PATH = 'packages/foreground-latency-probe/never-indexed.ts';
const GREP_PATTERN = 'total +=';
/**
 * No change in any index count for this long ends the run as invalid instead of
 * waiting out the test timeout; it is also how often the loop checks. The
 * slowest gap seen between count changes was 6.1 s (WASM, model load before the
 * first embedding, read at ~1.2 s resolution, so at most 7.3 s). CI's WASM path
 * is up to 2.7x slower (1.68 vs 4.49 chunks/s), about 20 s; x10 margin.
 */
const STALL_WINDOW_MS = 200_000;
const NO_PROGRESS = { chunkCount: 0, chunkedFileCount: 0, embeddedChunkCount: 0, fileCount: 0 };

type Device = 'wasm' | 'webgpu';

interface DbBridgeRow {
  readonly [column: string]: unknown;
}

interface IndexSummary {
  readonly actualDevice: string | null;
  readonly chunkCount: number;
  readonly chunkedFileCount: number;
  readonly dtype: string | null;
  readonly embeddedChunkCount: number;
  readonly fallbackApplied: boolean | null;
  readonly fileCount: number;
  readonly openJobStates: readonly string[];
  readonly syncState: string;
}

function readDevice(): Device {
  const raw = process.env[DEVICE_ENV]?.trim() || 'webgpu';
  if (raw !== 'wasm' && raw !== 'webgpu') {
    throw new Error(`${DEVICE_ENV} must be "wasm" or "webgpu", got "${raw}".`);
  }
  return raw;
}

function readFiles(): number {
  const raw = process.env[FILES_ENV]?.trim();
  if (!raw) {
    return DEFAULT_FILES;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${FILES_ENV} must be a positive integer, got "${raw}".`);
  }
  return value;
}

async function queryDb(page: Page, sql: string, params: readonly unknown[] = []) {
  return await page.evaluate(
    async ({ statement, values }) => {
      const query = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: readonly unknown[]
              ) => Promise<{ rows?: readonly DbBridgeRow[] }>;
            };
          };
        }
      ).electronAPI?.db?.query;
      if (typeof query !== 'function') {
        throw new Error('electronAPI.db.query is unavailable.');
      }
      return (await query(statement, values)).rows ?? [];
    },
    { statement: sql, values: params }
  );
}

/**
 * Desktop E2E never shows the app window. A never-shown window on Linux runs
 * rAF at about 1 Hz, so frame gaps would describe the harness, not the app; a
 * user's window is visible. Shown inactive, so it takes no focus.
 */
async function showAppWindow(app: ElectronApplication, page: Page): Promise<void> {
  const browserWindow = await app.browserWindow(page);
  const visible = await browserWindow.evaluate((win) => {
    win.showInactive();
    return win.isVisible();
  });
  if (!visible) {
    throw new Error('The app window did not become visible.');
  }
}

async function seedPausedWorkspace(page: Page, rootPath: string, device: Device): Promise<void> {
  await page.evaluate(
    async ({ root, rootId }) => {
      const storage = (
        window as Window & {
          electronAPI?: { storage?: { setItem?: (key: string, value: string) => Promise<void> } };
        }
      ).electronAPI?.storage;
      if (!storage?.setItem) {
        throw new Error('electronAPI.storage.setItem is unavailable.');
      }
      await storage.setItem('lastFolderPath', root);
      await storage.setItem(
        'rootsList',
        JSON.stringify([{ addedAt: 1_800_000_000_000, path: root, rootId }])
      );
      // Paused, so the idle baseline is taken with the workspace open and nothing indexing.
      await storage.setItem(
        'background-indexing-preferences.v1',
        JSON.stringify({
          state: {
            enabled: true,
            indexingPolicyPreset: 'full-root',
            managedCollectionId: null,
            mode: 'root-folder-cache',
            paused: true,
            worktreeRootIndexingByAdapterRootId: {},
            worktreeRootIndexingOptInById: {},
          },
          version: 5,
        })
      );
    },
    { root: rootPath, rootId: BENCH_ROOT_ID }
  );
  await setVectorDevicePreference(page, device);
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, 'foreground-latency-benchmark-seeded');
  await page.waitForFunction(
    () =>
      typeof (window as Window & { __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: unknown })
        .__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ === 'object',
    undefined,
    { timeout: 60_000 }
  );
  await expect(page.getByTestId('indexing-status-trigger')).toContainText('Paused', {
    timeout: 60_000,
  });
}

async function readWorkspaceIndexSetId(page: Page): Promise<string> {
  let setId: string | null = null;
  await expect
    .poll(
      async () => {
        const rows = await queryDb(
          page,
          `SELECT id FROM embedding_sets WHERE system_role = 'workspace-index'`
        );
        setId = rows.length === 1 && typeof rows[0]?.['id'] === 'string' ? rows[0]['id'] : null;
        return setId;
      },
      { message: 'Expected exactly one Workspace Index embedding set.', timeout: 60_000 }
    )
    .not.toBeNull();
  if (setId === null) {
    throw new Error('Workspace Index embedding set id is unresolved.');
  }
  return setId;
}

/** A thread with a `running` run row: the chat-path write needs a parent run, as during a real turn. */
async function seedRunningChatRun(page: Page): Promise<string> {
  const threadId = 'foreground-latency-benchmark-thread';
  const runId = 'foreground-latency-benchmark-run';
  await queryDb(
    page,
    `INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")
     VALUES ($1, $2, 'Foreground latency benchmark', '{}'::jsonb, now(), now())`,
    [threadId, WORKSPACE_RESOURCE_ID]
  );
  await queryDb(
    page,
    `INSERT INTO brainstrike_assistant_thread_runs
       (id, resource_id, thread_id, provider, model, runtime_kind, status, started_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'openrouter', 'benchmark/model', 'hosted', 'running', now(), now(), now())`,
    [runId, WORKSPACE_RESOURCE_ID, threadId]
  );
  return runId;
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === 'number' ? value : Number(value ?? 0);
}

async function readIndexSummary(page: Page): Promise<IndexSummary> {
  const summary = await page.evaluate(async () => {
    const api = (
      window as Window & {
        __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: { summary: () => Promise<Record<string, unknown>> };
      }
    ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;
    if (!api) {
      throw new Error('Workspace Index debug API is unavailable.');
    }
    return await api.summary();
  });
  if (Array.isArray(summary['accessIssues']) && summary['accessIssues'].length > 0) {
    throw new Error(
      `Workspace Index summary access issues: ${JSON.stringify(summary['accessIssues'])}`
    );
  }
  const files = summary['fileRecordsByRoot'] as Record<string, unknown>[];
  const chunks = summary['chunkStatsByRootAndSet'] as Record<string, unknown>[];
  const jobs = summary['jobQueue'] as Record<string, unknown>[];
  const host = summary['embeddingHostStatus'] as {
    status?: {
      embeddingRuntime?: {
        actualWorkerMetadata?: {
          device?: string;
          dtype?: string;
          fallbackApplied?: boolean;
        } | null;
      };
    };
  };
  const worker = host?.status?.embeddingRuntime?.actualWorkerMetadata ?? null;
  const sum = (rows: Record<string, unknown>[], key: string): number =>
    rows.reduce((total, row) => total + readNumber(row, key), 0);
  return {
    actualDevice: worker?.device ?? null,
    chunkCount: sum(chunks, 'chunk_count'),
    chunkedFileCount: sum(files, 'chunked_file_count'),
    dtype: worker?.dtype ?? null,
    embeddedChunkCount: sum(chunks, 'embedded_chunk_count'),
    fallbackApplied: worker?.fallbackApplied ?? null,
    fileCount: sum(files, 'file_count'),
    openJobStates: jobs
      .map((row) => String(row['state']))
      .filter((state) => state === 'queued' || state === 'running' || state === 'failed'),
    syncState: String((summary['syncStatus'] as { state?: unknown } | undefined)?.state),
  };
}

function isTerminal(summary: IndexSummary, files: number): boolean {
  return (
    summary.fileCount === files &&
    summary.chunkedFileCount === files &&
    summary.chunkCount > 0 &&
    summary.embeddedChunkCount === summary.chunkCount &&
    summary.openJobStates.length === 0
  );
}

/** Opens the indexing popover and returns its Resume button, ready to click. */
async function openResumeControl(page: Page): Promise<Locator> {
  await page.getByTestId('indexing-status-trigger').click();
  const resume = page
    .getByTestId('indexing-status-popover')
    .getByRole('button', { name: 'Resume workspace index' });
  await expect(resume).toBeVisible();
  return resume;
}

async function closeIndexingPopover(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('indexing-status-popover')).toBeHidden();
}

function rendererMetrics(samples: RendererWindowSamples) {
  return {
    frameGapMs: summarize(samples.frameGapsMs),
    framesOver50Ms: samples.frameGapsMs.filter((gap) => gap > LONG_FRAME_MS).length,
    longTasks: {
      count: samples.longTaskDurationsMs.length,
      maxMs:
        samples.longTaskDurationsMs.length === 0 ? 0 : summarize(samples.longTaskDurationsMs).max,
      totalMs: Math.round(samples.longTaskDurationsMs.reduce((total, ms) => total + ms, 0)),
    },
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function mainMetrics(samples: MainPhaseSamples) {
  return {
    chatPathOpMs: summarize(samples.chatPathOpMs),
    eventLoopLagMs: samples.eventLoopLagMs,
    toolFileReadMs: summarize(samples.toolFileReadMs),
    toolIndexQueryMs: summarize(samples.toolIndexQueryMs),
    toolReadMs: summarize(samples.toolReadMs),
  };
}

function describeEnvironment(electronVersion: string, loadAverage: readonly number[]) {
  const cpus = os.cpus();
  return {
    arch: process.arch,
    ci: process.env['CI'] === 'true',
    cpuCount: cpus.length,
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    electronVersion,
    loadAverageAtStart: loadAverage.map((value) => Math.round(value * 100) / 100),
    osRelease: os.release(),
    platform: process.platform,
    runner: process.env['RUNNER_NAME'] ?? null,
    totalMemoryGb: Math.round(os.totalmem() / 1024 ** 3),
  };
}

function formatSummary(label: string, summary: LatencySummary): string {
  return `${label}: n=${summary.n} p50=${summary.p50} p95=${summary.p95} max=${summary.max}`;
}

test.describe('Foreground latency under a full index build', () => {
  test(
    'measures foreground latency while a full Workspace Index build runs',
    { tag: '@perf' },
    async ({ electronApp, window: page }, testInfo) => {
      test.setTimeout(55 * 60 * 1000);
      const device = readDevice();
      const files = readFiles();
      const evidencePath =
        process.env[EVIDENCE_PATH_ENV]?.trim() ||
        testInfo.outputPath('foreground-latency-under-index-build.json');
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const electronVersion = await electronApp.app.evaluate(() => process.versions.electron);
      const environment = describeEnvironment(electronVersion, os.loadavg());
      const corpus: IndexBuildCorpus = writeIndexBuildCorpus({ files, seed: CORPUS_SEED });
      const invalidReasons: string[] = [];

      try {
        await showAppWindow(electronApp.app, page);
        await seedPausedWorkspace(page, corpus.rootPath, device);
        const embeddingSetId = await readWorkspaceIndexSetId(page);
        const chatRunId = await seedRunningChatRun(page);

        await installRendererFrameProbe(page);
        await installMainProbes(electronApp.app, {
          chatRunId,
          embeddingSetId,
          grepFilePath: NEVER_INDEXED_GREP_PATH,
          grepPattern: GREP_PATTERN,
          periodMs: PROBE_PERIOD_MS,
          readTargetPath: corpus.readTargetPath,
          rootPath: corpus.rootPath,
        });

        const rendererCalibration = await calibrateRendererFrameProbe(page, CALIBRATION_BLOCK_MS);

        // ---- idle: workspace open, indexing paused; warm-up runs before both windows ----
        const warmUpErrors = await warmUpMainProbes(electronApp.app, WARMUP_SAMPLES);
        await markRendererPhase(page, 'idle-start');
        const idleMain = await runMainIdlePhase(electronApp.app, IDLE_SAMPLES);
        await markRendererPhase(page, 'idle-end');
        const idleRenderer = await readRendererWindows(page, [['idle-start', 'idle-end']]);

        // ---- loaded: from the Resume click until the backfill completes on a terminal index ----
        // Main and renderer start just before the click and stop at the completion.
        // Every index check runs between windows, so it is not measured.
        await installBuildSignals(page, embeddingSetId);
        const resume = await openResumeControl(page);
        await startMainLoadedPhase(electronApp.app);
        await markRendererPhase(page, 'loaded-start-0');
        const buildStartedAt = Date.now();
        await resume.click();
        await closeIndexingPopover(page);

        const progress = createIndexProgressWatch({
          initial: NO_PROGRESS,
          stallWindowMs: STALL_WINDOW_MS,
          startedAtMs: buildStartedAt,
        });
        const loadedWindows: Array<readonly [string, string]> = [];
        let completion: BackfillCompletion | null = null;
        let completionIndex = 0;
        let finalSummary: IndexSummary;
        let buildElapsedMs: number;
        for (let segment = 0; ; segment += 1) {
          const arrived = await waitForBackfillCompletion(page, completionIndex, STALL_WINDOW_MS);
          const wokeAt = Date.now();
          await pauseMainLoadedPhase(electronApp.app);
          if (arrived) {
            await markRendererPhaseAtCompletion(page, `loaded-end-${segment}`, completionIndex);
          } else {
            await markRendererPhase(page, `loaded-end-${segment}`);
          }
          loadedWindows.push([`loaded-start-${segment}`, `loaded-end-${segment}`]);
          const summary = await readIndexSummary(page);
          if (arrived && isTerminal(summary, files)) {
            completion = arrived;
            finalSummary = summary;
            buildElapsedMs = wokeAt - buildStartedAt;
            break;
          }
          if (progress.observe(summary, Date.now()) === 'stalled') {
            invalidReasons.push(
              `the Workspace Index made no progress for ${STALL_WINDOW_MS} ms (stall window); last index summary: ${JSON.stringify(summary)}`
            );
            finalSummary = summary;
            buildElapsedMs = wokeAt - buildStartedAt;
            break;
          }
          if (arrived) {
            completionIndex += 1;
          }
          await resumeMainLoadedPhase(electronApp.app);
          await markRendererPhase(page, `loaded-start-${segment + 1}`);
        }
        const loadedMain = await stopMainLoadedPhase(electronApp.app);
        const loadedRenderer = await readRendererWindows(page, loadedWindows);

        // ---- validity: refuse to report numbers that cannot mean anything ----
        const idleRendererMetrics = rendererMetrics(idleRenderer);
        const loadedRendererMetrics = rendererMetrics(loadedRenderer);
        for (const [phase, errors] of [
          ['warm-up', warmUpErrors],
          ['idle', idleMain.errors],
          ['loaded', loadedMain.errors],
        ] as const) {
          if (errors.length > 0) {
            invalidReasons.push(`${phase} probe operations failed: ${errors.join('; ')}`);
          }
        }
        if (!(idleRendererMetrics.frameGapMs.p50 <= MAX_IDLE_FRAME_GAP_P50_MS)) {
          invalidReasons.push(
            `idle rAF frame gap p50 is ${idleRendererMetrics.frameGapMs.p50} ms (> ${MAX_IDLE_FRAME_GAP_P50_MS} ms): the window is not producing frames at display rate`
          );
        }
        if (buildElapsedMs < MIN_BUILD_MS) {
          invalidReasons.push(
            `the build finished in ${buildElapsedMs} ms, under the ${MIN_BUILD_MS} ms floor: raise ${FILES_ENV}`
          );
        }
        for (const [name, values] of [
          ['chat-path op', loadedMain.chatPathOpMs],
          ['tool read', loadedMain.toolReadMs],
        ] as const) {
          if (values.length < MIN_LOADED_SAMPLES) {
            invalidReasons.push(
              `only ${values.length} loaded ${name} samples (< ${MIN_LOADED_SAMPLES})`
            );
          }
        }
        if (finalSummary.actualDevice !== device || finalSummary.fallbackApplied !== false) {
          invalidReasons.push(
            `embedding ran on ${finalSummary.actualDevice} (fallbackApplied=${finalSummary.fallbackApplied}), not the configured ${device}`
          );
        }

        const idle = mainMetrics(idleMain);
        const loaded = mainMetrics(loadedMain);
        const evidence = {
          build: {
            actualDevice: finalSummary.actualDevice,
            backfillCompletion: completion,
            chunkCount: finalSummary.chunkCount,
            chunksPerSecond: round3(finalSummary.embeddedChunkCount / (buildElapsedMs / 1000)),
            completedChunkCount: finalSummary.embeddedChunkCount,
            dtype: finalSummary.dtype,
            elapsedMs: buildElapsedMs,
            fileCount: finalSummary.fileCount,
          },
          capturedAt: new Date().toISOString(),
          commit,
          config: {
            corpus: {
              bytes: corpus.bytes,
              files: corpus.files,
              seed: corpus.seed,
              sha256: corpus.sha256,
            },
            device,
            idleSamplesPerProbe: IDLE_SAMPLES,
            loadedWindowSegments: loadedWindows.length,
            minBuildMs: MIN_BUILD_MS,
            minLoadedSamplesPerProbe: MIN_LOADED_SAMPLES,
            probePeriodMs: PROBE_PERIOD_MS,
            rendererCalibration: { blockMs: CALIBRATION_BLOCK_MS, observed: rendererCalibration },
            stallWindowMs: STALL_WINDOW_MS,
            warmupSamplesPerProbe: WARMUP_SAMPLES,
          },
          environment: { ...environment, loadAverageAtEnd: os.loadavg().map(round3) },
          invalidReasons,
          metrics: {
            chatPathOp: {
              idleMs: idle.chatPathOpMs,
              loadedMs: loaded.chatPathOpMs,
              operation:
                'recordDesktopAssistantRunEvent(run.step.finished), foreground scheduler lane',
              p95DeltaMs: round3(loaded.chatPathOpMs.p95 - idle.chatPathOpMs.p95),
            },
            mainEventLoopLag: { idleMs: idle.eventLoopLagMs, loadedMs: loaded.eventLoopLagMs },
            renderer: { idle: idleRendererMetrics, loaded: loadedRendererMetrics },
            toolRead: {
              components: {
                fileReadMs: { idle: idle.toolFileReadMs, loaded: loaded.toolFileReadMs },
                indexQueryMs: { idle: idle.toolIndexQueryMs, loaded: loaded.toolIndexQueryMs },
              },
              idleMs: idle.toolReadMs,
              loadedMs: loaded.toolReadMs,
              p95LoadedOverIdle: round3(loaded.toolReadMs.p95 / idle.toolReadMs.p95),
            },
          },
          rawSamplesMs: {
            idle: {
              chatPathOp: idleMain.chatPathOpMs.map(round3),
              toolRead: idleMain.toolReadMs.map(round3),
            },
            loaded: {
              chatPathOp: loadedMain.chatPathOpMs.map(round3),
              toolRead: loadedMain.toolReadMs.map(round3),
            },
          },
          schema: 'brainstrike.foreground-latency-under-index-build.v1',
          status: invalidReasons.length === 0 ? 'valid' : 'invalid',
        };
        mkdirSync(path.dirname(evidencePath), { recursive: true });
        writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

        console.log(
          [
            `[foreground-latency] ${evidence.status} — evidence: ${evidencePath}`,
            `build: ${evidence.build.completedChunkCount} chunks in ${buildElapsedMs} ms = ${evidence.build.chunksPerSecond} chunks/s on ${finalSummary.actualDevice}`,
            `renderer idle: frame gap p95=${idleRendererMetrics.frameGapMs.p95} max=${idleRendererMetrics.frameGapMs.max}, long tasks=${idleRendererMetrics.longTasks.count}`,
            `renderer loaded: frame gap p95=${loadedRendererMetrics.frameGapMs.p95} max=${loadedRendererMetrics.frameGapMs.max}, long tasks=${loadedRendererMetrics.longTasks.count} (${loadedRendererMetrics.longTasks.totalMs} ms)`,
            `main event-loop lag idle p95=${idle.eventLoopLagMs.p95} max=${idle.eventLoopLagMs.max}; loaded p95=${loaded.eventLoopLagMs.p95} max=${loaded.eventLoopLagMs.max}`,
            formatSummary('chat-path op idle', idle.chatPathOpMs),
            formatSummary('chat-path op loaded', loaded.chatPathOpMs),
            formatSummary('tool read idle', idle.toolReadMs),
            formatSummary('tool read loaded', loaded.toolReadMs),
            `tool read p95 loaded/idle = ${evidence.metrics.toolRead.p95LoadedOverIdle}`,
            ...invalidReasons.map((reason) => `INVALID: ${reason}`),
          ].join('\n')
        );
        if (invalidReasons.length > 0) {
          throw new Error(
            `Foreground latency benchmark is invalid:\n- ${invalidReasons.join('\n- ')}`
          );
        }
      } finally {
        rmSync(corpus.rootPath, { force: true, recursive: true });
      }
    }
  );
});
