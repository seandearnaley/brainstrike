import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostSearchVectorCounts, withAppHost } from './utils/agent-host-log';
import { configureAssistantProvider } from './utils/assistant-mock';
import {
  describeEnvironment,
  formatSummary,
  mainMetrics,
  queryDb,
  readBenchDevice,
  rendererMetrics,
  round3,
  seedPausedWorkspace,
  showAppWindow,
  startProbeThread,
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
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';
import type { ModelProviderShim } from './utils/model-provider-shim';
import { createThreadMessageCorpus, type ThreadMessageCorpus } from './utils/thread-message-corpus';

/**
 * Loaded foreground-latency benchmark for the Threads panel's semantic arm:
 * the instrument behind working rule 4 for conversation-row embedding. One
 * Threads panel search starts the shipped backlog drain (16 rows per pass,
 * renderer embedder), and the same probes as the index-build benchmark measure
 * the foreground idle and while every seeded message is embedded.
 *
 * `BRAINSTRIKE_THREAD_EMBEDDING_BENCHMARK_OWNER` picks whose threads hold the
 * corpus: `history` (the legacy PGlite threads, BEFORE) or `host` (agent-host
 * threads, seeded through the host's own runs, AFTER). The same search and
 * drain embed either backlog; only the store differs.
 *
 * The search embedder is the renderer's local model on the preferred device
 * (`createLocalEmbedder`'s runtime is that preference; it has no fallback), so
 * the configured device is the device that ran, or every row errors and the
 * run is invalid.
 *
 * It REPORTS; it does not gate on the numbers. It fails only when the run
 * cannot produce valid numbers. See docs/performance/foreground-latency-under-index-build.md.
 */

const DEVICE_ENV = 'BRAINSTRIKE_THREAD_EMBEDDING_BENCHMARK_DEVICE';
const EVIDENCE_PATH_ENV = 'BRAINSTRIKE_THREAD_EMBEDDING_BENCHMARK_EVIDENCE_PATH';
const OWNER_ENV = 'BRAINSTRIKE_THREAD_EMBEDDING_BENCHMARK_OWNER';
const API_KEY = 'test-key-thread-embedding-benchmark';
// The shim's one recorded OpenRouter metadata fixture, so no metadata request is refused.
const MODEL = 'anthropic/claude-sonnet-4.6';
/** Host threads seeded at once; each thread's runs are sequential, as a conversation's are. */
const SEED_CONCURRENCY = 16;

test.use({ electronEnv: { BRAINSTRIKE_OPENROUTER_API_KEY: API_KEY } });

type Owner = 'history' | 'host';

function readOwner(): Owner {
  const raw = process.env[OWNER_ENV]?.trim() || 'history';
  if (raw !== 'history' && raw !== 'host') {
    throw new Error(`${OWNER_ENV} must be "history" or "host", got "${raw}".`);
  }
  return raw;
}

const CORPUS_SEED = 1937;
/**
 * 80 x 20 = 1,600 messages. One search drains at most 800 (50 passes of 16
 * rows in use-thread-search-controller) and 800 took 15.5 s on WebGPU, under
 * the 20 s that 100 loaded samples need, so the run searches again at each
 * check until the backlog is empty, as a user who keeps searching does.
 */
const THREADS = 80;
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
/** Each check's search differs, so the debounced controller runs every one. */
const SEARCH_QUERIES = ['vector latency', 'latency vector', 'search tokens', 'tokens search'];
const INDEX_TABLE = 'brainstrike_thread_message_index';

interface EmbeddingCounts {
  readonly embeddable: number;
  readonly embedded: number;
  readonly errored: number;
  readonly indexed: number;
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

/** The text of the request's last user message, as the provider received it. */
function lastUserText(messages: readonly unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!(message && typeof message === 'object' && 'role' in message) || message.role !== 'user') {
      continue;
    }
    const content = 'content' in message ? message.content : '';
    if (typeof content === 'string') {
      return content;
    }
    return Array.isArray(content)
      ? content
          .map((part: unknown) =>
            part && typeof part === 'object' && 'text' in part ? String(part.text) : ''
          )
          .join('')
      : '';
  }
  return '';
}

/**
 * Host threads holding the corpus, committed by the host's own runs: each
 * user message is a run's prompt, and the provider answers with the next
 * message. The first prompt is sent from the composer, so its run carries the
 * configuration the app captures at Send; every other run reuses that
 * configuration through a public host client. Resolves with the conversation
 * rows the runs committed.
 */
async function seedHostCorpus(
  page: Page,
  userDataDir: string,
  corpus: ThreadMessageCorpus,
  modelProvider: ModelProviderShim
): Promise<number> {
  const answers = new Map<string, string>();
  for (const thread of corpus.threads) {
    for (let index = 0; index + 1 < thread.messages.length; index += 2) {
      answers.set(thread.messages[index]?.text ?? '', thread.messages[index + 1]?.text ?? '');
    }
  }
  modelProvider.setScript(({ messages, requestBody }) => {
    // A thread's title request is the one non-streaming request.
    if ((requestBody as { stream?: unknown }).stream !== true) {
      return { finalText: 'Benchmark thread' };
    }
    const prompt = lastUserText(messages);
    const answer = [...answers.entries()].find(([question]) => prompt.includes(question))?.[1];
    if (!answer) {
      throw new Error(`The benchmark corpus has no answer for: ${prompt.slice(0, 120)}`);
    }
    return { finalText: answer };
  });
  const [first, ...rest] = corpus.threads;
  const firstPrompt = first?.messages[0]?.text;
  if (!(first && firstPrompt)) {
    throw new Error('The benchmark corpus has no first prompt');
  }
  await ensureAssistantShellVisible(page);
  const region = page.getByRole('region', { exact: true, name: 'Assistant' });
  const input = region.getByRole('textbox', { name: 'Message input' });
  await expect(async () => {
    await input.fill(firstPrompt);
    await expect(input).toHaveValue(firstPrompt, { timeout: 1000 });
  }).toPass({ timeout: 60_000 });
  await region.getByRole('button', { exact: true, name: 'Send' }).click();
  const tabId =
    (await page
      .getByRole('tablist', { name: 'Open assistant threads' })
      .getByRole('tab', { selected: true })
      .getAttribute('id')) ?? '';
  const firstThreadId = tabId.replace('assistant-thread-tab-', '');
  return await withAppHost(userDataDir, async (client) => {
    // Each thread is read from its last row on, so a poll never re-reads a whole log.
    const cursors = new Map<string, number>();
    const finished = async (threadId: string, runId: string): Promise<void> => {
      await expect
        .poll(
          async () => {
            const { rows } = await client.request('thread/read', {
              fromSeq: cursors.get(threadId) ?? 0,
              threadId,
            });
            const last = rows.at(-1);
            if (last) {
              cursors.set(threadId, last.seq);
            }
            return rows.find(({ event }) => event.type === 'run.finished' && event.runId === runId)
              ?.event;
          },
          { intervals: [100], timeout: 60_000 }
        )
        .toMatchObject({ outcome: 'completed' });
    };
    // The composer's run: its accepted command holds the captured configuration.
    let configuration: Record<string, unknown> | undefined;
    await expect
      .poll(
        async () => {
          const { rows } = await client.request('thread/read', {
            fromSeq: 0,
            threadId: firstThreadId,
          });
          const accepted = rows.find(
            ({ event }) => event.type === 'command.accepted' && event.method === 'run/start'
          )?.event;
          const payload =
            accepted?.type === 'command.accepted'
              ? (accepted.payload as Record<string, unknown>)
              : {};
          configuration = payload['configuration'] as Record<string, unknown> | undefined;
          return rows.some(
            ({ event }) => event.type === 'run.finished' && event.outcome === 'completed'
          );
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    if (!configuration) {
      throw new Error('The composer run committed no captured configuration');
    }
    const captured = configuration;
    const runs = async (
      threadId: string,
      messages: ThreadMessageCorpus['threads'][number]['messages'],
      from: number
    ): Promise<number> => {
      let committed = 0;
      for (let index = from; index + 1 < messages.length; index += 2) {
        const { runId } = await client.request('run/start', {
          commandId: randomUUID(),
          configuration: captured as never,
          modelId: `openrouter::${MODEL}`,
          prompt: messages[index]?.text ?? '',
          threadId,
        });
        await finished(threadId, runId);
        committed += 2;
      }
      return committed;
    };
    let rows = 2 + (await runs(firstThreadId, first.messages, 2));
    const queue = [...rest];
    const seedNext = async (): Promise<void> => {
      for (let thread = queue.shift(); thread; thread = queue.shift()) {
        const { threadId } = await client.request('thread/start', { commandId: randomUUID() });
        rows += await runs(threadId, thread.messages, 0);
      }
    };
    await Promise.all(Array.from({ length: SEED_CONCURRENCY }, seedNext));
    return rows;
  });
}

/** The host runs' provider and model, enabled before the seeding reload reads them. */
async function enableBenchmarkModel(page: Page): Promise<void> {
  await configureAssistantProvider(page, {
    apiKey: API_KEY,
    compositeModelKey: `openrouter::${MODEL}`,
    provider: 'openrouter',
  });
  await queryDb(page, 'UPDATE models SET is_enabled = true WHERE id = $1 AND provider_id = $2', [
    MODEL,
    'openrouter',
  ]);
}

/** The host's rows and stored search vectors; the host keeps no per-row embedding error. */
async function readHostEmbeddingCounts(userDataDir: string): Promise<EmbeddingCounts> {
  const { rows, vectors } = await readHostSearchVectorCounts(userDataDir);
  return { embeddable: rows, embedded: vectors, errored: 0, indexed: rows };
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
    async ({ electron, electronApp, modelProvider, window: page }, testInfo) => {
      const owner = readOwner();
      // Seeding 800 host runs takes most of an hour; the history corpus is rows in a table.
      test.setTimeout((owner === 'host' ? 90 : 30) * 60 * 1000);
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
        if (owner === 'host') {
          await enableBenchmarkModel(page);
        }
        await seedPausedWorkspace(
          page,
          probeRoot.rootPath,
          BENCH_ROOT_ID,
          device,
          'thread-embedding-benchmark-seeded'
        );
        const chatThreadId = await startProbeThread(electronApp.app);
        const seededMessages =
          owner === 'history'
            ? await seedHistoryCorpus(page, corpus)
            : await seedHostCorpus(page, electron.getUserDataDir(), corpus, modelProvider);
        // A fresh app measures the host owner, as the history owner is measured
        // with no runs behind it: the seeding runs' process state is not the load.
        let app = electronApp.app;
        let view = page;
        if (owner === 'host') {
          const restarted = await electron.restart();
          app = restarted.app;
          view = restarted.window;
          await (await loadElectronHelpers()).waitForAppReady(view);
          await showAppWindow(app, view);
          await expect(view.getByTestId('indexing-status-trigger')).toContainText('Paused', {
            timeout: 60_000,
          });
        }
        const counted = (): Promise<EmbeddingCounts> =>
          owner === 'history'
            ? readEmbeddingCounts(view)
            : readHostEmbeddingCounts(electron.getUserDataDir());
        await openThreadsPanel(view);

        await installRendererFrameProbe(view);
        await installMainProbes(app, {
          chatThreadId,
          grepFilePath: NEVER_INDEXED_GREP_PATH,
          grepPattern: GREP_PATTERN,
          periodMs: PROBE_PERIOD_MS,
          readTargetPath: probeRoot.readTargetPath,
          rootPath: probeRoot.rootPath,
        });
        const rendererCalibration = await calibrateRendererFrameProbe(view, CALIBRATION_BLOCK_MS);

        // ---- idle: Threads panel open, nothing searched or embedding ----
        const warmUpErrors = await warmUpMainProbes(app, WARMUP_SAMPLES);
        await markRendererPhase(view, 'idle-start');
        const idleMain = await runMainIdlePhase(app, IDLE_SAMPLES);
        await markRendererPhase(view, 'idle-end');
        const idleRenderer = await readRendererWindows(view, [['idle-start', 'idle-end']]);

        // ---- loaded: from the search until every seeded message is embedded ----
        // The count checks run between windows, so they are not measured.
        const search = view.getByRole('combobox', { name: 'Search threads' });
        await startMainLoadedPhase(app);
        await markRendererPhase(view, 'loaded-start-0');
        const drainStartedAt = Date.now();
        await search.fill(SEARCH_QUERIES[0] ?? 'vector latency');
        const loadedWindows: Array<readonly [string, string]> = [];
        let counts: EmbeddingCounts = { embeddable: 0, embedded: 0, errored: 0, indexed: 0 };
        let lastProgressAt = drainStartedAt;
        let drainElapsedMs: number;
        for (let segment = 0; ; segment += 1) {
          await view.waitForTimeout(CHECK_EVERY_MS);
          const checkedAt = Date.now();
          await pauseMainLoadedPhase(app);
          await markRendererPhase(view, `loaded-end-${segment}`);
          loadedWindows.push([`loaded-start-${segment}`, `loaded-end-${segment}`]);
          const next = await counted();
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
          await resumeMainLoadedPhase(app);
          await markRendererPhase(view, `loaded-start-${segment + 1}`);
          // A finished drain stops; the next search queues the next one.
          await search.fill(
            SEARCH_QUERIES[(segment + 1) % SEARCH_QUERIES.length] ?? 'vector latency'
          );
        }
        const loadedMain = await stopMainLoadedPhase(app);
        const loadedRenderer = await readRendererWindows(view, loadedWindows);

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
            owner,
            probePeriodMs: PROBE_PERIOD_MS,
            rendererCalibration: { blockMs: CALIBRATION_BLOCK_MS, observed: rendererCalibration },
            rowsPerPass: 16,
            searchQueries: SEARCH_QUERIES,
            stallWindowMs: STALL_WINDOW_MS,
            warmupSamplesPerProbe: WARMUP_SAMPLES,
          },
          drain: {
            counts,
            elapsedMs: drainElapsedMs,
            rowsPerSecond: round3(counts.embedded / (drainElapsedMs / 1000)),
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
            `drain: ${counts.embedded}/${counts.embeddable} messages in ${drainElapsedMs} ms = ${evidence.drain.rowsPerSecond} rows/s on ${device}`,
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
