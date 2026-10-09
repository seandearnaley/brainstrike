import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import {
  describeEnvironment,
  formatSummary,
  mainMetrics,
  queryDb,
  readBenchDevice,
  readWorkspaceIndexSetId,
  rendererMetrics,
  round3,
  seedPausedWorkspace,
  seedRunningChatRun,
  showAppWindow,
  WORKSPACE_RESOURCE_ID,
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
  warmUpMainProbes,
} from './utils/foreground-latency-probes';
import { writeIndexBuildCorpus } from './utils/index-build-corpus';
import { createThreadMessageCorpus, type ThreadMessageCorpus } from './utils/thread-message-corpus';

/**
 * Loaded foreground-latency benchmark for the Threads panel's semantic arm:
 * the instrument behind working rule 4 for conversation-row embedding. One
 * Threads panel search starts the shipped backlog drain (16 rows per pass,
 * renderer embedder), and the same probes as the index-build benchmark measure
 * the foreground idle and while every seeded message is embedded.
 *
 * It REPORTS; it does not gate on the numbers. It fails only when the run
 * cannot produce valid numbers. See docs/performance/foreground-latency-under-index-build.md.
 */

const DEVICE_ENV = 'BRAINSTRIKE_THREAD_EMBEDDING_BENCHMARK_DEVICE';
const EVIDENCE_PATH_ENV = 'BRAINSTRIKE_THREAD_EMBEDDING_BENCHMARK_EVIDENCE_PATH';

const CORPUS_SEED = 1937;
/**
 * 40 x 20 = 800 messages: the most one search drains (50 passes of 16 rows in
 * use-thread-search-controller), so one search embeds the whole corpus.
 */
const THREADS = 40;
const MESSAGES_PER_THREAD = 20;
/** The probes' workspace root; its index stays paused, so it adds no load. */
const PROBE_ROOT_FILES = 20;
const PROBE_PERIOD_MS = 200;
const IDLE_SAMPLES = 150;
const WARMUP_SAMPLES = 10;
const MIN_LOADED_SAMPLES = 100;
const MAX_IDLE_FRAME_GAP_P50_MS = 20;
const CALIBRATION_BLOCK_MS = 120;
/** How often the loaded window pauses to read the embedding counts (unmeasured). */
const CHECK_EVERY_MS = 5000;
/** No embedding progress for this long ends the run as invalid. */
const STALL_WINDOW_MS = 120_000;
const BENCH_ROOT_ID = 'thread-embedding-benchmark-root';
const NEVER_INDEXED_GREP_PATH = 'packages/foreground-latency-probe/never-indexed.ts';
const GREP_PATTERN = 'total +=';
const SEARCH_QUERY = 'vector latency';
const INDEX_TABLE = 'brainstrike_thread_message_index';

interface EmbeddingCounts {
  readonly embeddable: number;
  readonly embedded: number;
  readonly errored: number;
  readonly indexed: number;
}

interface EmbeddingWorker {
  readonly device: string | null;
  readonly dtype: string | null;
  readonly fallbackApplied: boolean | null;
}

/** History threads and their messages, in the shape Mastra persists, under the workspace resource. */
async function seedHistoryCorpus(page: Page, corpus: ThreadMessageCorpus): Promise<number> {
  const base = Date.now() - 3_600_000;
  let messages = 0;
  for (const [threadIndex, thread] of corpus.threads.entries()) {
    const threadId = `thread-embedding-benchmark-${threadIndex}`;
    const at = new Date(base + threadIndex * 60_000).toISOString();
    await queryDb(
      page,
      `INSERT INTO mastra_threads (id, "resourceId", title, metadata, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, '{}'::jsonb, $4, $4)`,
      [threadId, WORKSPACE_RESOURCE_ID, thread.title, at]
    );
    for (const [index, message] of thread.messages.entries()) {
      await queryDb(
        page,
        `INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt", "resourceId")
         VALUES ($1, $2, $3::jsonb, $4, 'v2', $5, $6)`,
        [
          `${threadId}-message-${index}`,
          threadId,
          JSON.stringify({
            content: message.text,
            format: 2,
            parts: [{ text: message.text, type: 'text' }],
          }),
          message.role,
          new Date(base + threadIndex * 60_000 + index * 1000).toISOString(),
          WORKSPACE_RESOURCE_ID,
        ]
      );
      messages += 1;
    }
  }
  return messages;
}

async function readEmbeddingCounts(page: Page): Promise<EmbeddingCounts> {
  const [row] = await queryDb(
    page,
    `SELECT COUNT(*)::int AS indexed,
            COUNT(*) FILTER (WHERE content_text <> '')::int AS embeddable,
            COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
            COUNT(*) FILTER (WHERE embedding_error IS NOT NULL)::int AS errored
     FROM ${INDEX_TABLE} WHERE resource_id = $1`,
    [WORKSPACE_RESOURCE_ID]
  );
  return {
    embeddable: Number(row?.['embeddable'] ?? 0),
    embedded: Number(row?.['embedded'] ?? 0),
    errored: Number(row?.['errored'] ?? 0),
    indexed: Number(row?.['indexed'] ?? 0),
  };
}

/** The embedding host's worker as it actually ran (device, dtype, fallback). */
async function readEmbeddingWorker(page: Page): Promise<EmbeddingWorker> {
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
  return {
    device: worker?.device ?? null,
    dtype: worker?.dtype ?? null,
    fallbackApplied: worker?.fallbackApplied ?? null,
  };
}

async function openThreadsPanel(page: Page): Promise<void> {
  const showSidebar = page.getByTestId('show-threads-panel');
  if (await showSidebar.isVisible().catch(() => false)) {
    await showSidebar.click();
  }
  await page.getByTestId('threads-tab-trigger').click();
  await expect(page.getByTestId('threads-panel')).toBeVisible({ timeout: 30_000 });
}

test.describe('Foreground latency under thread message embedding', () => {
  test(
    'measures foreground latency while the Threads panel embeds its message backlog',
    { tag: '@perf' },
    async ({ electronApp, window: page }, testInfo) => {
      test.setTimeout(30 * 60 * 1000);
      const device = readBenchDevice(DEVICE_ENV);
      const evidencePath =
        process.env[EVIDENCE_PATH_ENV]?.trim() ||
        testInfo.outputPath('foreground-latency-under-thread-embedding.json');
      const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const electronVersion = await electronApp.app.evaluate(() => process.versions.electron);
      const environment = describeEnvironment(electronVersion, os.loadavg());
      const probeRoot = writeIndexBuildCorpus({ files: PROBE_ROOT_FILES, seed: CORPUS_SEED });
      const corpus = createThreadMessageCorpus({
        messagesPerThread: MESSAGES_PER_THREAD,
        seed: CORPUS_SEED,
        threads: THREADS,
      });
      const invalidReasons: string[] = [];

      try {
        await showAppWindow(electronApp.app, page);
        await seedPausedWorkspace(
          page,
          probeRoot.rootPath,
          BENCH_ROOT_ID,
          device,
          'thread-embedding-benchmark-seeded'
        );
        const embeddingSetId = await readWorkspaceIndexSetId(page);
        const chatRunId = await seedRunningChatRun(page);
        const seededMessages = await seedHistoryCorpus(page, corpus);
        await openThreadsPanel(page);

        await installRendererFrameProbe(page);
        await installMainProbes(electronApp.app, {
          chatRunId,
          embeddingSetId,
          grepFilePath: NEVER_INDEXED_GREP_PATH,
          grepPattern: GREP_PATTERN,
          periodMs: PROBE_PERIOD_MS,
          readTargetPath: probeRoot.readTargetPath,
          rootPath: probeRoot.rootPath,
        });
        const rendererCalibration = await calibrateRendererFrameProbe(page, CALIBRATION_BLOCK_MS);

        // ---- idle: Threads panel open, nothing searched or embedding ----
        const warmUpErrors = await warmUpMainProbes(electronApp.app, WARMUP_SAMPLES);
        await markRendererPhase(page, 'idle-start');
        const idleMain = await runMainIdlePhase(electronApp.app, IDLE_SAMPLES);
        await markRendererPhase(page, 'idle-end');
        const idleRenderer = await readRendererWindows(page, [['idle-start', 'idle-end']]);

        // ---- loaded: from the search until every seeded message is embedded ----
        // The count checks run between windows, so they are not measured.
        const search = page.getByRole('combobox', { name: 'Search threads' });
        await startMainLoadedPhase(electronApp.app);
        await markRendererPhase(page, 'loaded-start-0');
        const drainStartedAt = Date.now();
        await search.fill(SEARCH_QUERY);
        const loadedWindows: Array<readonly [string, string]> = [];
        let counts: EmbeddingCounts = { embeddable: 0, embedded: 0, errored: 0, indexed: 0 };
        let lastProgressAt = drainStartedAt;
        let drainElapsedMs: number;
        for (let segment = 0; ; segment += 1) {
          await page.waitForTimeout(CHECK_EVERY_MS);
          const checkedAt = Date.now();
          await pauseMainLoadedPhase(electronApp.app);
          await markRendererPhase(page, `loaded-end-${segment}`);
          loadedWindows.push([`loaded-start-${segment}`, `loaded-end-${segment}`]);
          const next = await readEmbeddingCounts(page);
          if (next.embedded !== counts.embedded || next.errored !== counts.errored) {
            lastProgressAt = checkedAt;
          }
          counts = next;
          if (
            counts.indexed === seededMessages &&
            counts.embeddable > 0 &&
            counts.embedded + counts.errored === counts.embeddable
          ) {
            drainElapsedMs = checkedAt - drainStartedAt;
            break;
          }
          if (checkedAt - lastProgressAt > STALL_WINDOW_MS) {
            invalidReasons.push(
              `no message was embedded for ${STALL_WINDOW_MS} ms; last counts: ${JSON.stringify(counts)}`
            );
            drainElapsedMs = checkedAt - drainStartedAt;
            break;
          }
          await resumeMainLoadedPhase(electronApp.app);
          await markRendererPhase(page, `loaded-start-${segment + 1}`);
        }
        const loadedMain = await stopMainLoadedPhase(electronApp.app);
        const loadedRenderer = await readRendererWindows(page, loadedWindows);
        const worker = await readEmbeddingWorker(page);

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
        for (const [name, values] of [
          ['chat-path op', loadedMain.chatPathOpMs],
          ['tool read', loadedMain.toolReadMs],
        ] as const) {
          if (values.length < MIN_LOADED_SAMPLES) {
            invalidReasons.push(
              `only ${values.length} loaded ${name} samples (< ${MIN_LOADED_SAMPLES}): the drain was too short to measure`
            );
          }
        }
        if (counts.errored > 0) {
          invalidReasons.push(`${counts.errored} messages failed to embed`);
        }
        if (worker.device !== device || worker.fallbackApplied !== false) {
          invalidReasons.push(
            `embedding ran on ${worker.device} (fallbackApplied=${worker.fallbackApplied}), not the configured ${device}`
          );
        }

        const idle = mainMetrics(idleMain);
        const loaded = mainMetrics(loadedMain);
        const evidence = {
          capturedAt: new Date().toISOString(),
          commit,
          config: {
            corpus: {
              bytes: corpus.bytes,
              messages: seededMessages,
              messagesPerThread: corpus.messagesPerThread,
              seed: corpus.seed,
              sha256: corpus.sha256,
              threads: corpus.threads.length,
            },
            device,
            idleSamplesPerProbe: IDLE_SAMPLES,
            loadedWindowSegments: loadedWindows.length,
            minLoadedSamplesPerProbe: MIN_LOADED_SAMPLES,
            owner: 'history',
            probePeriodMs: PROBE_PERIOD_MS,
            rendererCalibration: { blockMs: CALIBRATION_BLOCK_MS, observed: rendererCalibration },
            rowsPerPass: 16,
            searchQuery: SEARCH_QUERY,
            stallWindowMs: STALL_WINDOW_MS,
            warmupSamplesPerProbe: WARMUP_SAMPLES,
          },
          drain: {
            counts,
            elapsedMs: drainElapsedMs,
            rowsPerSecond: round3(counts.embedded / (drainElapsedMs / 1000)),
            worker,
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
              idleMs: idle.toolReadMs,
              loadedMs: loaded.toolReadMs,
              p95LoadedOverIdle: round3(loaded.toolReadMs.p95 / idle.toolReadMs.p95),
            },
          },
          schema: 'brainstrike.foreground-latency-under-thread-embedding.v1',
          status: invalidReasons.length === 0 ? 'valid' : 'invalid',
        };
        mkdirSync(path.dirname(evidencePath), { recursive: true });
        writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

        console.log(
          [
            `[thread-embedding-latency] ${evidence.status} — evidence: ${evidencePath}`,
            `drain: ${counts.embedded}/${counts.embeddable} messages in ${drainElapsedMs} ms = ${evidence.drain.rowsPerSecond} rows/s on ${worker.device}`,
            `renderer idle: frame gap p95=${idleRendererMetrics.frameGapMs.p95} max=${idleRendererMetrics.frameGapMs.max}, long tasks=${idleRendererMetrics.longTasks.count}`,
            `renderer loaded: frame gap p95=${loadedRendererMetrics.frameGapMs.p95} max=${loadedRendererMetrics.frameGapMs.max}, long tasks=${loadedRendererMetrics.longTasks.count} (${loadedRendererMetrics.longTasks.totalMs} ms)`,
            `main event-loop lag idle p95=${idle.eventLoopLagMs.p95} max=${idle.eventLoopLagMs.max}; loaded p95=${loaded.eventLoopLagMs.p95} max=${loaded.eventLoopLagMs.max}`,
            formatSummary('chat-path op idle', idle.chatPathOpMs),
            formatSummary('chat-path op loaded', loaded.chatPathOpMs),
            formatSummary('tool read idle', idle.toolReadMs),
            formatSummary('tool read loaded', loaded.toolReadMs),
            ...invalidReasons.map((reason) => `INVALID: ${reason}`),
          ].join('\n')
        );
        if (invalidReasons.length > 0) {
          throw new Error(
            `Thread embedding latency benchmark is invalid:\n- ${invalidReasons.join('\n- ')}`
          );
        }
      } finally {
        rmSync(probeRoot.rootPath, { force: true, recursive: true });
      }
    }
  );
});
