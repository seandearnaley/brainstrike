import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { getMainBufferedLogs, getRendererLogRecords } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import {
  readBenchDevice,
  readEmbeddingHost,
  type SeededRoot,
  seedPausedWorkspace,
} from './utils/foreground-latency-bench';
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
 * Full Workspace Index run: the opt-in acceptance verifier for large real roots
 * (docs/workspace-indexing-full-run-verification.md). It opens the configured
 * folders as the workspace with the full-root policy, chooses BGE Small on the
 * required device, resumes the native Workspace Index and waits until every
 * root's scan is complete and every chunk has its vector.
 *
 * Everything it reads is the native index's own observation (BST-2038): counts,
 * scan receipts and the query plan from the renderer's `indexSearch`
 * capability, and the hidden embedding host's actual worker metadata. The
 * evidence file it writes is what `scripts/benchmark-workspace-index-pipeline.mjs
 * --evidence` analyzes.
 */

const ROOTS_ENV = 'BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_ROOTS';
const SINGLE_ROOT_ENV = 'BRAINSTRIKE_E2E_REAL_ROOT_PATH';
const DEVICE_ENV = 'BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_DEVICE';
const EVIDENCE_PATH_ENV = 'BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_EVIDENCE_PATH';
const MAX_IDLE_MS_ENV = 'BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_MAX_IDLE_MS';
const TIMEOUT_ENV = 'BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_TIMEOUT_MS';
const EVIDENCE_SCHEMA = 'brainstrike.full-workspace-index.v2';
const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
/** How long the paused index may take to activate before Resume. */
const READY_TIMEOUT_MS = 300_000;
const POLL_MS = 5000;
const DEFAULT_NO_PROGRESS_TIMEOUT_MS = 120_000;
const MAX_EVIDENCE_SAMPLES = 24;
const FATAL_LOG_PATTERN =
  /DB host request timed out|Local embedding execution failed|uncaught|unhandled/i;

type WorkerMetadata = NonNullable<
  NonNullable<
    Awaited<ReturnType<VisibleEmbeddingHostBridge['getStatus']>>['embeddingRuntime']
  >['actualWorkerMetadata']
>;

interface FullRunSample {
  readonly capturedAt: string;
  readonly elapsedMs: number;
  readonly index: NativeIndexSummary;
  readonly memory: {
    readonly embeddingHostWorkingSetMb: number | null;
    readonly rendererHeapUsedMb: number | null;
  };
  /** The hidden embedding host's actual worker; null until it has loaded a model. */
  readonly worker: WorkerMetadata | null;
}

function resolveStableEvidencePath(): string {
  const configured = process.env[EVIDENCE_PATH_ENV]?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve('test-results', 'full-workspace-index-evidence.json');
}

function parseConfiguredRoots(): string[] {
  const rawRoots = process.env[ROOTS_ENV]?.trim() || process.env[SINGLE_ROOT_ENV]?.trim() || '';
  if (!rawRoots) {
    return [];
  }
  return rawRoots
    .split(path.delimiter)
    .map((rootPath) => rootPath.trim())
    .filter((rootPath) => rootPath.length > 0)
    .map((rootPath) => path.resolve(rootPath));
}

async function readWorker(page: Page): Promise<WorkerMetadata | null> {
  return await page.evaluate(async () => {
    const host = (window as Window & { embeddingHost?: VisibleEmbeddingHostBridge }).embeddingHost;
    if (!host) {
      throw new Error('The embedding host bridge is unavailable.');
    }
    return (await host.getStatus()).embeddingRuntime?.actualWorkerMetadata ?? null;
  });
}

async function readRendererHeapUsedMb(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return memory ? Math.round(memory.usedJSHeapSize / 1024 / 102.4) / 10 : null;
  });
}

/** Every configured root scanned to completion, and every chunk embedded. */
function isTerminal(index: NativeIndexSummary, rootIds: readonly string[]): boolean {
  return (
    index.status === 'ready' &&
    index.roots.length === rootIds.length &&
    rootIds.every((rootId) =>
      index.roots.some((root) => root.rootId === rootId && root.scanComplete)
    ) &&
    index.fileCount > 0 &&
    index.chunkCount > 0 &&
    index.embeddedChunkCount === index.chunkCount &&
    index.missingVectors === 0 &&
    index.vectorCoverageComplete
  );
}

function assertSampleIsHealthy(
  sample: FullRunSample,
  rootIds: readonly string[],
  requiredDevice: string
): void {
  const { index, worker } = sample;
  const authorized = [...index.authorizedRootIds].sort().join(', ');
  const configured = [...rootIds].sort().join(', ');
  if (index.status === 'ready' && authorized !== configured) {
    throw new Error(
      `The native index authorizes roots [${authorized}], not the configured [${configured}].`
    );
  }
  if (index.actualDevice && index.actualDevice !== requiredDevice) {
    throw new Error(
      `The native query plan runs on ${index.actualDevice}, not the required ${requiredDevice}.`
    );
  }
  if (worker) {
    if (worker.device !== requiredDevice) {
      throw new Error(
        `The embedding host's actual worker runs on ${worker.device}, not the required ${requiredDevice}.`
      );
    }
    if (worker.fallbackApplied) {
      throw new Error("The embedding host's actual worker reported fallbackApplied=true.");
    }
  }
}

function appendBoundedSample(samples: FullRunSample[], sample: FullRunSample): number {
  samples.push(sample);
  if (samples.length <= MAX_EVIDENCE_SAMPLES) {
    return 0;
  }
  // Keep startup context plus the recent window that explains terminal success or failure.
  samples.splice(1, samples.length - MAX_EVIDENCE_SAMPLES);
  return 1;
}

test.describe('Full Workspace Index run', () => {
  test.skip(
    parseConfiguredRoots().length === 0,
    `Set ${ROOTS_ENV} or ${SINGLE_ROOT_ENV} to run the real full-root Workspace Index verifier.`
  );

  test('@desktop-full-workspace-index completes all configured roots', async ({
    electronApp,
    window: page,
  }, testInfo) => {
    test.setTimeout(Number(process.env[TIMEOUT_ENV]) || DEFAULT_TIMEOUT_MS);
    const startedAt = Date.now();
    const roots = parseConfiguredRoots();
    expect(roots.length).toBeGreaterThan(0);
    const requiredDevice = readBenchDevice(DEVICE_ENV);
    const noProgressTimeoutMs =
      Number(process.env[MAX_IDLE_MS_ENV]) || DEFAULT_NO_PROGRESS_TIMEOUT_MS;
    const seededRoots: SeededRoot[] = roots.map((rootPath, index) => ({
      path: rootPath,
      rootId: `workspace-index-e2e-root-${index + 1}`,
    }));
    const rootIds = seededRoots.map((root) => root.rootId);

    const samples: FullRunSample[] = [];
    let droppedSampleCount = 0;
    const fatalLogMatches = new Set<string>();
    let buildStartedAt: number | null = null;
    /** The last actual worker seen: the host may retire once the build is idle. */
    let observedWorker: WorkerMetadata | null = null;

    const writeEvidence = async (
      outcome:
        | { readonly status: 'completed' }
        | {
            readonly error: { message: string; name: string; stack?: string };
            readonly status: 'failed';
          }
    ): Promise<void> => {
      const evidenceJson = JSON.stringify(
        {
          ...outcome,
          buildStartedAtMs: buildStartedAt === null ? null : buildStartedAt - startedAt,
          completedAt: new Date().toISOString(),
          droppedSampleCount,
          durationMs: Date.now() - startedAt,
          fatalLogMatches: [...fatalLogMatches],
          final: samples.at(-1) ?? null,
          requiredDevice,
          roots: seededRoots,
          samples,
          schema: EVIDENCE_SCHEMA,
          worker: observedWorker,
        },
        null,
        2
      );
      await writeFile(
        testInfo.outputPath('full-workspace-index-evidence.json'),
        evidenceJson,
        'utf8'
      );
      const stableEvidencePath = resolveStableEvidencePath();
      await mkdir(path.dirname(stableEvidencePath), { recursive: true });
      await writeFile(stableEvidencePath, evidenceJson, 'utf8');
    };

    const collectFatalLogs = async (): Promise<void> => {
      const logs = [...(await getRendererLogRecords(page)), ...(await getMainBufferedLogs(page))]
        .map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
        .filter((entry) => FATAL_LOG_PATTERN.test(entry));
      for (const entry of logs) {
        fatalLogMatches.add(entry);
      }
    };

    const readSample = async (): Promise<FullRunSample> => {
      const index = await readNativeIndexSummary(page);
      const host = await readEmbeddingHost(electronApp.app);
      return {
        capturedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        index,
        memory: {
          embeddingHostWorkingSetMb: host?.workingSetMb ?? null,
          rendererHeapUsedMb: await readRendererHeapUsedMb(page),
        },
        worker: await readWorker(page),
      };
    };

    try {
      await seedPausedWorkspace(
        page,
        seededRoots,
        requiredDevice,
        'full-workspace-index-roots-seeded'
      );
      await configureNativeIndex(page, requiredDevice);
      await waitForReadyIndex(page, READY_TIMEOUT_MS);
      const resume = await openResumeControl(page);
      buildStartedAt = Date.now();
      await resume.click();
      await closeIndexingPopover(page);

      const progress = createIndexProgressWatch({
        initial: { chunkCount: 0, chunkedFileCount: 0, embeddedChunkCount: 0, fileCount: 0 },
        stallWindowMs: noProgressTimeoutMs,
        startedAtMs: buildStartedAt,
      });
      let stableTerminalPolls = 0;
      while (Date.now() - startedAt < testInfo.timeout - POLL_MS) {
        const sample = await readSample();
        droppedSampleCount += appendBoundedSample(samples, sample);
        assertSampleIsHealthy(sample, rootIds, requiredDevice);
        observedWorker = sample.worker ?? observedWorker;

        await collectFatalLogs();
        if (fatalLogMatches.size > 0) {
          throw new Error('Workspace Index fatal log pattern detected during full run');
        }

        if (isTerminal(sample.index, rootIds)) {
          stableTerminalPolls += 1;
          if (stableTerminalPolls >= 2) {
            break;
          }
        } else {
          stableTerminalPolls = 0;
          if (progress.observe(sample.index, Date.now()) === 'stalled') {
            throw new Error(`Workspace Index made no progress for ${noProgressTimeoutMs}ms`);
          }
        }

        await page.waitForTimeout(POLL_MS);
      }

      const final = samples.at(-1);
      if (!(final && isTerminal(final.index, rootIds))) {
        throw new Error('Workspace Index did not reach terminal full-run completion');
      }
      if (final.index.actualDevice !== requiredDevice) {
        throw new Error(
          `Workspace Index completed with query plan device ${final.index.actualDevice}, not ${requiredDevice}`
        );
      }
      if (!observedWorker) {
        throw new Error('Workspace Index completed without actual embedding worker metadata');
      }

      await writeEvidence({ status: 'completed' });
    } catch (error) {
      try {
        await collectFatalLogs();
      } catch {
        // Ignore log collection failures so the original assertion remains the thrown error.
      }
      await writeEvidence({
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Error',
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
        status: 'failed',
      });
      throw error;
    }
  });
});
