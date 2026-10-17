import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from './fixtures/electron-fixture';
import {
  describeEnvironment,
  type EmbeddingHostReading,
  embeddingHostMetrics,
  formatSummary,
  mainMetrics,
  readBenchDevice,
  readEmbeddingHost,
  rendererMetrics,
  round3,
  seedPausedWorkspace,
  showAppWindow,
  startProbeThread,
} from './utils/foreground-latency-bench';
import {
  calibrateRendererFrameProbe,
  installMainProbes,
  installRendererFrameProbe,
  markRendererPhase,
  pauseMainLoadedPhase,
  readRendererWindows,
  resumeMainLoadedPhase,
  runMainIdlePhase,
  startMainLoadedPhase,
  stopMainLoadedPhase,
  summarize,
  warmUpMainProbes,
} from './utils/foreground-latency-probes';
import { type IndexBuildCorpus, writeIndexBuildCorpus } from './utils/index-build-corpus';
import { createIndexProgressWatch } from './utils/index-progress-watch';
import {
  closeIndexingPopover,
  configureNativeIndex,
  type NativeIndexSummary,
  openResumeControl,
  readNativeIndexSummary,
  waitForReadyIndex,
} from './utils/native-index-build';

/**
 * Loaded foreground-latency benchmark (BST-1925, BST-2012): the instrument
 * behind working rule 4. It runs a full Workspace Index build of a seeded
 * corpus and measures, idle (before the build) and loaded (during it):
 *
 * - renderer: rAF frame gaps and `longtask` entries in the visible window;
 * - main: event-loop lag (`monitorEventLoopDelay`);
 * - the chat path's per-step write: one committed agent-host command;
 * - an agent tool's read (the tool file reader plus the grep tool's native index query);
 * - build throughput in chunks/s, and when each stage's receipts completed.
 *
 * The build is the native Workspace Index's (`NativeWorkspaceIndexProvider`):
 * the seeded root opens paused, BGE Small is chosen through Search & Indexing
 * with the configured execution device, and Resume starts the build. Counts
 * and the device come from the renderer's `indexSearch` capability, read
 * between windows every `CHECK_EVERY_MS`, so a loaded window ends at the first
 * check that finds the index terminal.
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
/** A deliberate renderer block before the idle phase; the probe must see it. */
const CALIBRATION_BLOCK_MS = 120;
const BENCH_ROOT_ID = 'foreground-latency-benchmark-root';
/** Root-relative and never written, so the grep's index work is identical idle and loaded. */
const NEVER_INDEXED_GREP_PATH = 'packages/foreground-latency-probe/never-indexed.ts';
const GREP_PATTERN = 'total +=';
/** How long the paused index may take to activate before the idle phase. */
const READY_TIMEOUT_MS = 300_000;
/** How often the loaded window pauses to read the index counts (unmeasured). */
const CHECK_EVERY_MS = 2000;
/**
 * No change in any index count for this long ends the run as invalid instead of
 * waiting out the test timeout; it is also how often the loop checks. The
 * slowest gap seen between count changes was 6.1 s (WASM, model load before the
 * first embedding, read at ~1.2 s resolution, so at most 7.3 s). CI's WASM path
 * is up to 2.7x slower (1.68 vs 4.49 chunks/s), about 20 s; x10 margin.
 */
const STALL_WINDOW_MS = 200_000;
const NO_PROGRESS = { chunkCount: 0, chunkedFileCount: 0, embeddedChunkCount: 0, fileCount: 0 };

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

type StageMilestone = 'allFilesChunked' | 'allVectors' | 'firstChunk' | 'firstVector';

/**
 * When each stage's committed receipts were first seen, in ms after Resume, at
 * the check's resolution: chunks (scan and chunking) and vectors (embedding)
 * complete separately, so a change can say which stage it moved.
 */
function createStageMilestones() {
  const milestones: Partial<Record<StageMilestone, number>> = {};
  return {
    milestones,
    observe(summary: NativeIndexSummary, files: number, elapsedMs: number): void {
      const reached: Record<StageMilestone, boolean> = {
        allFilesChunked: summary.scanComplete && summary.fileCount === files,
        allVectors: isTerminal(summary, files),
        firstChunk: summary.chunkCount > 0,
        firstVector: summary.embeddedChunkCount > 0,
      };
      for (const [stage, done] of Object.entries(reached) as [StageMilestone, boolean][]) {
        if (done && milestones[stage] === undefined) {
          milestones[stage] = elapsedMs;
        }
      }
    },
  };
}

function isTerminal(summary: NativeIndexSummary, files: number): boolean {
  return (
    summary.scanComplete &&
    summary.fileCount === files &&
    summary.chunkCount > 0 &&
    summary.embeddedChunkCount === summary.chunkCount &&
    summary.missingVectors === 0
  );
}

test.describe('Foreground latency under a full index build', () => {
  test(
    'measures foreground latency while a full Workspace Index build runs',
    { tag: '@perf' },
    async ({ electronApp, window: page }, testInfo) => {
      test.setTimeout(55 * 60 * 1000);
      const device = readBenchDevice(DEVICE_ENV);
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
        await seedPausedWorkspace(
          page,
          [{ path: corpus.rootPath, rootId: BENCH_ROOT_ID }],
          device,
          'foreground-latency-benchmark-seeded'
        );
        await configureNativeIndex(page, device);
        await waitForReadyIndex(page, READY_TIMEOUT_MS);
        const chatThreadId = await startProbeThread(electronApp.app);

        await installRendererFrameProbe(page);
        await installMainProbes(electronApp.app, {
          chatThreadId,
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

        // ---- loaded: from the Resume click until a check finds a terminal index ----
        // Main and renderer start just before the click and stop at that check.
        // Every index check runs between windows, so it is not measured.
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
        const stages = createStageMilestones();
        const hostReadings: EmbeddingHostReading[] = [];
        /** Each unmeasured check's native coverage read: whether index reads wait on the build. */
        const checkReadMs: number[] = [];
        let finalSummary: NativeIndexSummary;
        let buildElapsedMs: number;
        for (let segment = 0; ; segment += 1) {
          await page.waitForTimeout(CHECK_EVERY_MS);
          const wokeAt = Date.now();
          await pauseMainLoadedPhase(electronApp.app);
          await markRendererPhase(page, `loaded-end-${segment}`);
          loadedWindows.push([`loaded-start-${segment}`, `loaded-end-${segment}`]);
          const readStartedAt = performance.now();
          const summary = await readNativeIndexSummary(page);
          checkReadMs.push(performance.now() - readStartedAt);
          stages.observe(summary, files, wokeAt - buildStartedAt);
          const hostReading = await readEmbeddingHost(electronApp.app);
          if (hostReading) {
            hostReadings.push(hostReading);
          }
          if (isTerminal(summary, files)) {
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
        if (finalSummary.actualDevice !== device) {
          invalidReasons.push(
            `the native query plan runs on ${finalSummary.actualDevice}, not the configured ${device}`
          );
        }

        const idle = mainMetrics(idleMain);
        const loaded = mainMetrics(loadedMain);
        const evidence = {
          build: {
            actualDevice: finalSummary.actualDevice,
            checkReadMs: summarize(checkReadMs.map(round3)),
            chunkCount: finalSummary.chunkCount,
            chunksPerSecond: round3(finalSummary.embeddedChunkCount / (buildElapsedMs / 1000)),
            completedChunkCount: finalSummary.embeddedChunkCount,
            dtype: finalSummary.dtype,
            elapsedMs: buildElapsedMs,
            fileCount: finalSummary.fileCount,
            stageMilestonesMs: stages.milestones,
          },
          capturedAt: new Date().toISOString(),
          commit,
          config: {
            checkEveryMs: CHECK_EVERY_MS,
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
          embeddingHost: embeddingHostMetrics(hostReadings),
          environment: { ...environment, loadAverageAtEnd: os.loadavg().map(round3) },
          invalidReasons,
          metrics: {
            chatPathOp: {
              idleMs: idle.chatPathOpMs,
              loadedMs: loaded.chatPathOpMs,
              operation: 'agent-host thread/update command (one committed StateStore append)',
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
          schema: 'brainstrike.foreground-latency-under-index-build.v3',
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
            `embedding host: crossOriginIsolated=${evidence.embeddingHost.crossOriginIsolated}, cores=${evidence.embeddingHost.hardwareConcurrency}, cpu p50=${evidence.embeddingHost.cpuPercent.p50}% max=${evidence.embeddingHost.cpuPercent.max}%, peak working set=${evidence.embeddingHost.peakWorkingSetMb} MB`,
            `stages (ms after Resume): ${JSON.stringify(stages.milestones)}`,
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
