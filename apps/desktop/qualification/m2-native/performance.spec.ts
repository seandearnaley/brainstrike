import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from '@playwright/test';
import type {
  IndexerEmbeddingProfile,
  IndexSearchCapability,
} from '../../../../packages/indexing-contract/src/indexer-client';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import {
  calibrateRendererFrameProbe,
  installRendererFrameProbe,
  markRendererPhase,
  readRendererWindows,
  summarize,
} from '../../e2e/utils/foreground-latency-probes';
import { writeIndexBuildCorpus } from '../../e2e/utils/index-build-corpus';
import { createBenchmarkProgress } from './benchmark-progress';
import {
  assertTextInferenceInactive,
  createCandidateSession,
  observeNativeSnapshot,
  readNativeSnapshot,
} from './candidate';
import {
  assessNativeBenchmark,
  MATCHED_CORPUS,
  type NativeBenchmarkScope,
  nativeBuildComplete,
} from './native-benchmark';
import {
  configureNativeChoices,
  ensureCatalogCollection,
  readSavedChoices,
} from './native-settings';
import type { PublicBridges } from './public-bridges';
import {
  assertActualVectorWorker,
  configureVectorProfile,
  selectedVectorProfile,
} from './vector-profile';

const ROOT_ID = 'foreground-latency-benchmark-root';
const NEVER_INDEXED_PATH = 'packages/foreground-latency-probe/never-indexed.ts';
const PATTERN = 'total +=';
const RUN_ID = 'foreground-latency-benchmark-run';

interface PhaseSamples {
  chat: number[];
  errors: string[];
  file: number[];
  grep: number[];
  tool: number[];
}

async function startMainLag(context: ElectronAppContext): Promise<void> {
  await context.app.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      m2QualificationHistogram?: import('node:perf_hooks').IntervalHistogram;
    };
    if (target.m2QualificationHistogram) {
      throw new Error('Previous main lag probe is still owned.');
    }
    const perf = process.getBuiltinModule('node:perf_hooks') as typeof import('node:perf_hooks');
    const histogram = perf.monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    target.m2QualificationHistogram = histogram;
  });
}

async function stopMainLag(
  context: ElectronAppContext
): Promise<{ n: number; max: number; p50: number; p95: number }> {
  return await context.app.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      m2QualificationHistogram?: import('node:perf_hooks').IntervalHistogram;
    };
    const histogram = target.m2QualificationHistogram;
    if (!histogram) {
      throw new Error('Main lag probe is missing.');
    }
    histogram.disable();
    target.m2QualificationHistogram = undefined;
    const lag = (ns: number): number => Math.round((ns / 1e6 - 10) * 1000) / 1000;
    return {
      max: lag(histogram.max),
      n: histogram.count,
      p50: lag(histogram.percentile(50)),
      p95: lag(histogram.percentile(95)),
    };
  });
}

async function chatProbe(context: ElectronAppContext, sequence: number): Promise<number> {
  return await context.app.evaluate(async (_electron, index) => {
    const seam = (
      globalThis as typeof globalThis & {
        ['__brainstrike_e2e_foreground_latency_probes__']?: {
          writeRunStepEvent(input: {
            eventId: string;
            runId: string;
            sequence: number;
          }): Promise<void>;
        };
      }
    ).__brainstrike_e2e_foreground_latency_probes__;
    if (!seam) {
      throw new Error('Established main chat probe is missing.');
    }
    const started = performance.now();
    await seam.writeRunStepEvent({
      eventId: `foreground-latency-benchmark-run-step-${index}`,
      runId: 'foreground-latency-benchmark-run',
      sequence: index,
    });
    return performance.now() - started;
  }, sequence);
}

async function toolProbe(
  context: ElectronAppContext,
  rootPath: string,
  readTargetPath: string
): Promise<{ file: number; grep: number }> {
  const file = await context.app.evaluate(
    async (_electron, input) => {
      const seam = (
        globalThis as typeof globalThis & {
          ['__brainstrike_e2e_foreground_latency_probes__']?: {
            readToolFile(input: { rootPath: string; requestedPath: string }): Promise<number>;
          };
        }
      ).__brainstrike_e2e_foreground_latency_probes__;
      if (!seam) {
        throw new Error('Established main tool file reader is missing.');
      }
      const started = performance.now();
      await seam.readToolFile(input);
      return performance.now() - started;
    },
    { requestedPath: readTargetPath, rootPath }
  );
  const grep = await context.window.evaluate(
    async ({ rootId, neverIndexedPath, pattern }) => {
      const api = (window as typeof window & { indexSearch?: IndexSearchCapability }).indexSearch;
      if (!api) {
        throw new Error('Native preload grep capability is missing.');
      }
      const started = performance.now();
      const result = await api.grep({
        caseSensitive: true,
        isRegex: false,
        limit: 100,
        pattern,
        rootIds: [rootId],
      });
      // The native public API has no per-path filter. Match the historical empty query
      // work using a pattern containing the never-indexed path, identical in both phases.
      if (result.hits.length !== 0) {
        throw new Error(`Native contention probe unexpectedly matched ${neverIndexedPath}.`);
      }
      return performance.now() - started;
    },
    {
      neverIndexedPath: NEVER_INDEXED_PATH,
      pattern: `${NEVER_INDEXED_PATH}:${PATTERN}`,
      rootId: ROOT_ID,
    }
  );
  return { file, grep };
}

async function phase(
  context: ElectronAppContext,
  rootPath: string,
  readTargetPath: string,
  nextSequence: () => number,
  keepRunning: (completed: number) => boolean
): Promise<PhaseSamples> {
  const samples: PhaseSamples = { chat: [], errors: [], file: [], grep: [], tool: [] };
  const loop = async (operation: 'chat' | 'tool'): Promise<void> => {
    if (operation === 'tool') {
      await delay(100);
    }
    while (keepRunning(operation === 'chat' ? samples.chat.length : samples.tool.length)) {
      const started = performance.now();
      try {
        if (operation === 'chat') {
          samples.chat.push(await chatProbe(context, nextSequence()));
        } else {
          const result = await toolProbe(context, rootPath, readTargetPath);
          samples.file.push(result.file);
          samples.grep.push(result.grep);
          samples.tool.push(result.file + result.grep);
        }
      } catch (error) {
        samples.errors.push(String(error));
        return;
      }
      await delay(Math.max(0, 200 - (performance.now() - started)));
    }
  };
  await Promise.all([loop('chat'), loop('tool')]);
  return samples;
}

async function seedPaused(
  context: ElectronAppContext,
  rootPath: string,
  modelId: string
): Promise<void> {
  const collectionId = await ensureCatalogCollection(context, modelId);
  await context.window.evaluate(
    async ({ collectionId, rootPath: root, rootId }) => {
      const api = (
        window as typeof window & {
          electronAPI: {
            storage: { setItem(key: string, value: string): Promise<void> };
          };
        }
      ).electronAPI;
      await api.storage.setItem('lastFolderPath', root);
      await api.storage.setItem(
        'rootsList',
        JSON.stringify([{ addedAt: 1_800_000_000_000, path: root, rootId }])
      );
      await api.storage.setItem(
        'background-indexing-preferences.v1',
        JSON.stringify({
          state: {
            enabled: true,
            indexingPolicyPreset: 'full-root',
            managedCollectionId: collectionId,
            mode: 'root-folder-cache',
            nativeIndexMode: 'TEXT',
            nativeLocalSelection: null,
            paused: true,
            worktreeRootIndexingByAdapterRootId: {},
            worktreeRootIndexingOptInById: {},
          },
          version: 5,
        })
      );
    },
    { collectionId, rootId: ROOT_ID, rootPath }
  );
  await context.window.reload();
  await expect(context.window.getByTestId('indexing-status-trigger')).toContainText('Paused', {
    timeout: 60_000,
  });
}

async function seedRunningChatRun(context: ElectronAppContext): Promise<void> {
  const run = await context.window.evaluate(async (runId) => {
    const query = (window as unknown as PublicBridges).electronAPI?.db.query;
    if (!query) {
      throw new Error('Canonical chat database bridge is unavailable.');
    }
    await query(
      `INSERT INTO mastra_threads (id,"resourceId",title,metadata,"createdAt","updatedAt") VALUES ($1,$2,$3,'{}'::jsonb,now(),now())`,
      [
        'foreground-latency-benchmark-thread',
        'brainstrike:workspace',
        'Foreground latency benchmark',
      ]
    );
    await query(
      "INSERT INTO brainstrike_assistant_thread_runs (id,resource_id,thread_id,provider,model,runtime_kind,status,started_at,created_at,updated_at) VALUES ($1,$2,$3,'openrouter','benchmark/model','hosted','running',now(),now(),now())",
      [runId, 'brainstrike:workspace', 'foreground-latency-benchmark-thread']
    );
    return await query<{ status: string }>(
      'SELECT status FROM brainstrike_assistant_thread_runs WHERE id=$1',
      [runId]
    );
  }, RUN_ID);
  expect(run.rows).toEqual([{ status: 'running' }]);
}

test('native full-pipeline historical throughput and calibrated foreground latency', async () => {
  test.setTimeout(3_300_000);
  const rawMode = process.env['BST_M2_BENCHMARK_MODE'];
  if (rawMode !== 'text' && rawMode !== 'vector') {
    throw new Error('Set BST_M2_BENCHMARK_MODE=text|vector explicitly.');
  }
  const mode = rawMode;
  const files = Number(process.env['BST_M2_BENCHMARK_FILES'] ?? MATCHED_CORPUS.files);
  if (!Number.isSafeInteger(files) || files < 1000) {
    throw new Error('Benchmark requires at least the matched 1000 files.');
  }
  const session = await createCandidateSession(`performance-${mode}-${files}`, { trace: false });
  const corpus = writeIndexBuildCorpus({ files, seed: MATCHED_CORPUS.seed });
  if (files === 1000) {
    expect(corpus.sha256).toBe(MATCHED_CORPUS.sha256);
    expect(corpus.bytes).toBe(MATCHED_CORPUS.bytes);
  }
  await session.record('corpus', { corpus, loadAverage: os.loadavg() });
  try {
    const context = await session.launch({ ['BRAINSTRIKE_E2E_REAL_ROOT_PATH']: corpus.rootPath });
    const modelId = mode === 'vector' ? selectedVectorProfile().modelId : 'Xenova/all-MiniLM-L6-v2';
    await seedPaused(context, corpus.rootPath, modelId);
    const win = await context.app.browserWindow(context.window);
    await win.evaluate((window) => window.showInactive());
    if (mode === 'text') {
      await configureNativeChoices(context, { mode: 'TEXT', modelId, paused: true });
    }
    const before =
      mode === 'vector'
        ? await configureVectorProfile(context, { paused: true })
        : await readNativeSnapshot(context);
    const choices = await readSavedChoices(context);
    expect(choices.paused).toBe(true);
    if (!choices.managedCollectionId.trim()) {
      throw new Error('Full-pipeline benchmark requires its explicit managed collection.');
    }
    if (before.status.kind !== 'ready') {
      throw new Error('Native index is unavailable before Resume.');
    }
    let profile: IndexerEmbeddingProfile | undefined;
    if (mode === 'vector') {
      if (before.status.embedding.indexMode !== 'vector-configured') {
        throw new Error(
          'Explicit native vector profile must be enabled through committed composition UI before this benchmark.'
        );
      }
      profile = before.status.embedding.profile;
    }
    const scope: NativeBenchmarkScope & { readonly collectionId: string } = {
      collectionId: choices.managedCollectionId,
      files,
      mode,
      rootId: ROOT_ID,
      storeId: before.status.storeId,
      ...(profile ? { profile } : {}),
    };
    if (before.coverage?.totals.chunks || before.collectionCoverage?.totals.chunks) {
      throw new Error('Cold benchmark profile already contains indexed chunks.');
    }
    await seedRunningChatRun(context);
    await session.record('cold-paused-input', { choices, snapshot: before });
    await installRendererFrameProbe(context.window);
    const calibration = await calibrateRendererFrameProbe(context.window, 120);
    let sequence = 0;
    const nextSequence = (): number => ++sequence;
    const warmup = await phase(
      context,
      corpus.rootPath,
      corpus.readTargetPath,
      nextSequence,
      (completed) => completed < 10
    );
    await markRendererPhase(context.window, 'idle-start');
    await startMainLag(context);
    const idle = await phase(
      context,
      corpus.rootPath,
      corpus.readTargetPath,
      nextSequence,
      (completed) => completed < 150
    );
    await markRendererPhase(context.window, 'idle-end');
    const idleMainLag = await stopMainLag(context);
    await context.window.getByTestId('indexing-status-trigger').click();
    const resume = context.window.getByRole('button', { name: /Resume indexing|Resume/i }).first();
    await expect(resume).toBeVisible();
    let running = true;
    await markRendererPhase(context.window, 'loaded-start');
    await startMainLag(context);
    const startedAt = performance.now();
    const progress = createBenchmarkProgress({
      baseline: before.status,
      now: () => performance.now(),
      readCoverage: () => observeNativeSnapshot(context),
      readStatus: () =>
        context.window.evaluate(async () => {
          const api = (window as typeof window & { indexSearch?: IndexSearchCapability })
            .indexSearch;
          if (!api) {
            throw new Error('Native status capability is missing.');
          }
          return await api.status();
        }),
      record: session.record,
      startedAt,
    });
    const loadedPromise = phase(
      context,
      corpus.rootPath,
      corpus.readTargetPath,
      nextSequence,
      () => running
    );
    let final = before;
    let loadedMainLag: Awaited<ReturnType<typeof stopMainLag>> | undefined;
    let elapsedMs = 0;
    try {
      await resume.click();
      await context.window.keyboard.press('Escape');
      while (true) {
        const observation = await progress.observe();
        if (observation !== null) {
          final = observation;
          if (mode === 'text') {
            assertTextInferenceInactive(final);
          }
          if (nativeBuildComplete(final.status, final.coverage, scope, final.collectionCoverage)) {
            break;
          }
        }
        progress.assertLive();
        await delay(500);
      }
    } finally {
      elapsedMs = performance.now() - startedAt;
      running = false;
      await markRendererPhase(context.window, 'loaded-end');
      loadedMainLag = await stopMainLag(context);
      await loadedPromise;
    }
    const loaded = await loadedPromise;
    if (mode === 'vector') {
      assertActualVectorWorker(final);
    }
    const idleFrames = await readRendererWindows(context.window, [['idle-start', 'idle-end']]);
    const loadedFrames = await readRendererWindows(context.window, [
      ['loaded-start', 'loaded-end'],
    ]);
    const assessment = assessNativeBenchmark({
      completedChunks: final.coverage?.totals.chunks ?? 0,
      elapsedMs,
      errors: [...warmup.errors, ...idle.errors, ...loaded.errors],
      idleChat: idle.chat,
      idleFrames: idleFrames.frameGapsMs,
      idleTool: idle.tool,
      loadedChat: loaded.chat,
      loadedFrames: loadedFrames.frameGapsMs,
      loadedLongTasks: loadedFrames.longTaskDurationsMs,
      loadedTool: loaded.tool,
    });
    const evidence = {
      acceptanceCriteria: {
        chat: {
          ceilingMs: 54.93,
          provenance:
            'Preserved historical1000 loaded chat p95 49.93ms + 5ms allowance; apps/desktop/qualification/m2-native/README.md, Preserved performance comparison. Same-corpus idle is a current controlled reference, not historical loaded BEFORE5000.',
        },
        frames: { maximumExclusiveMs: 50, maximumLongTasks: 0 },
      },
      assessment,
      before,
      calibration,
      completion:
        'observed current workspace and collection canonical readiness with full native coverage; includes up to 500ms observation delay',
      controlledIdleBaseline: {
        chat: summarize(idle.chat),
        corpus: {
          bytes: corpus.bytes,
          files: corpus.files,
          seed: corpus.seed,
          sha256: corpus.sha256,
        },
        phase:
          'cold paused, after warmup, before Resume; same session/corpus/store/profile and probe operations',
        samplePeriodMs: 200,
        scope,
        window: idleFrames.windows,
      },
      corpus,
      elapsedMs,
      final,
      historicalBaseline: {
        chunks: 6962,
        chunksPerSecond: 42.5,
        files: 1000,
        loadedChatP95Ms: 49.93,
      },
      idle,
      idleFrames,
      idleMainLag,
      instrument:
        'main readWorkspaceTextFile duration plus public native renderer/IPC grep duration; excludes CDP transport between components; not historical main PG grep',
      loadAverageAtEnd: os.loadavg(),
      loaded,
      loadedFrames,
      loadedMainLag,
      metrics: {
        chatIdle: summarize(idle.chat),
        chatLoaded: summarize(loaded.chat),
        toolIdle: summarize(idle.tool),
        toolLoaded: summarize(loaded.tool),
      },
      runnerTimeOriginMs: performance.timeOrigin,
      schema: 'brainstrike.m2-native-foreground.v1',
      scope,
    };
    await writeFile(path.join(session.runDir, 'benchmark.json'), JSON.stringify(evidence, null, 2));
    await session.record('benchmark', evidence);
    // A fast historical run can provide throughput evidence while latency stays
    // invalid. This failure triggers a separately paired larger-corpus run.
    expect(assessment.validityErrors).toEqual([]);
    expect(assessment.gates.frames).toBe(true);
    expect(assessment.gates.chat).toBe(true);
    // Preserve nativeTool/throughput reference comparisons in recorded evidence.
    // Owner-approved M2 scope: tool ratio is diagnostic; throughput is a stretch goal.
  } finally {
    await session.close();
  }
});
