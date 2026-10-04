import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';
import type { IndexSearchCapability } from '../../../../packages/indexing-contract/src/indexer-client';
import type { ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';
import type { EmbeddingHostStatus } from '../../src/embedding-host-shared';
import { nativeBuildComplete } from './native-benchmark';

export interface NativeSnapshot {
  readonly collectionCoverage: Awaited<ReturnType<IndexSearchCapability['coverage']>> | null;
  readonly coverage: Awaited<ReturnType<IndexSearchCapability['coverage']>> | null;
  readonly inference: EmbeddingHostStatus;
  readonly status: Awaited<ReturnType<IndexSearchCapability['status']>>;
}

export function observeInferenceStatus(): void {
  const target = window as typeof window & {
    embeddingHost?: {
      getStatus(): Promise<EmbeddingHostStatus>;
      onStatus(callback: (status: EmbeddingHostStatus) => void): () => void;
    };
    __m2InferenceStatuses?: EmbeddingHostStatus[];
  };
  if (!target.embeddingHost) {
    throw new Error('Embedding status capability is required.');
  }
  const statuses: EmbeddingHostStatus[] = [];
  target.__m2InferenceStatuses = statuses;
  target.embeddingHost.onStatus((status) => statuses.push(status));
  void target.embeddingHost.getStatus().then((status) => statuses.push(status));
}

export async function readNativeSnapshot(context: ElectronAppContext): Promise<NativeSnapshot> {
  return await context.window.evaluate(async () => {
    const api = window as typeof window & {
      indexSearch?: IndexSearchCapability;
      embeddingHost?: { getStatus(): Promise<EmbeddingHostStatus> };
    };
    if (!(api.indexSearch && api.embeddingHost)) {
      throw new Error('Native index and embedding status capabilities are required.');
    }
    const indexSearch = api.indexSearch;
    const requestsFor = (
      initialStatus: Extract<NativeSnapshot['status'], { kind: 'ready' }>
    ): Parameters<IndexSearchCapability['coverageBatch']>[0] => {
      const requests: Parameters<IndexSearchCapability['coverageBatch']>[0][number][] = [];
      if (initialStatus.authorizedCollectionIds?.length === 1) {
        const collectionId = initialStatus.authorizedCollectionIds[0];
        if (!collectionId) {
          throw new Error('Canonical collection identity is missing.');
        }
        requests.push({ collectionId, rootIds: [] });
      }
      if (initialStatus.authorizedRootIds.length > 0) {
        requests.push({ rootIds: initialStatus.authorizedRootIds });
      }
      return requests;
    };
    const readCoverage = async (
      initialStatus: Extract<NativeSnapshot['status'], { kind: 'ready' }>
    ): Promise<Pick<NativeSnapshot, 'status' | 'coverage' | 'collectionCoverage'>> => {
      const requests = requestsFor(initialStatus);
      if (requests.length === 0) {
        return { collectionCoverage: null, coverage: null, status: initialStatus };
      }
      const batch = await indexSearch.coverageBatch(requests);
      let collectionCoverage: NativeSnapshot['collectionCoverage'] = null;
      let coverage: NativeSnapshot['coverage'] = null;
      for (const [index, request] of requests.entries()) {
        const result = batch.coverage[index];
        if (!result) {
          throw new Error('Canonical coverage batch is incomplete.');
        }
        if (request.collectionId === undefined) {
          coverage = result;
        } else {
          collectionCoverage = result;
        }
      }
      return { collectionCoverage, coverage, status: batch.status };
    };
    const status = await indexSearch.status();
    const observation =
      status.kind === 'ready'
        ? await readCoverage(status)
        : { collectionCoverage: null, coverage: null, status };
    return { ...observation, inference: await api.embeddingHost.getStatus() };
  });
}

export function assertTextInferenceInactive(snapshot: NativeSnapshot): void {
  expect(snapshot.inference.active).toBe(false);
  expect(snapshot.inference.state).toBe('stopped');
  const runtime = snapshot.inference.embeddingRuntime;
  if (runtime) {
    expect(runtime.actualWorkerMetadata).toBeNull();
    expect(runtime.telemetry.batchTransfer.batchCount).toBe(0);
    expect(runtime.telemetry.cache.residentCount).toBe(0);
    expect(runtime.telemetry.peakVectorsInFlight).toBe(0);
  }
}

export async function waitForTextIndex(
  context: ElectronAppContext,
  files: number
): Promise<NativeSnapshot> {
  await expect
    .poll(
      async () => {
        const value = await readNativeSnapshot(context);
        if (value.status.kind !== 'ready') {
          return false;
        }
        const rootId = value.status.authorizedRootIds[0];
        if (!rootId) {
          return false;
        }
        return nativeBuildComplete(value.status, value.coverage, {
          files,
          mode: 'text',
          rootId,
          storeId: value.status.storeId,
        });
      },
      { message: 'Canonical complete-scan receipt and native rows must agree', timeout: 90_000 }
    )
    .toBe(true);
  const snapshot = await readNativeSnapshot(context);
  expect(snapshot.status.kind).toBe('ready');
  if (snapshot.status.kind !== 'ready' || !snapshot.coverage) {
    throw new Error('Ready scope vanished.');
  }
  expect(snapshot.status.embedding).toEqual({ indexMode: 'text-only' });
  expect(snapshot.coverage.embedding).toEqual({ indexMode: 'text-only' });
  expect(snapshot.coverage.totals.vectors).toBe(0);
  assertTextInferenceInactive(snapshot);
  return snapshot;
}

export interface CandidateSession {
  readonly candidateRoot: string;
  readonly close: () => Promise<void>;
  readonly launch: (env?: Readonly<Record<string, string>>) => Promise<ElectronAppContext>;
  readonly record: (phase: string, value: unknown) => Promise<void>;
  readonly runDir: string;
  readonly userDataDir: string;
}

export async function createCandidateSession(
  label: string,
  options: { readonly trace?: boolean } = {}
): Promise<CandidateSession> {
  const root = process.env['BST_M2_CANDIDATE_ROOT'];
  const evidenceRoot = process.env['BST_M2_ACCEPTANCE_RUN_DIR'];
  if (!(root && path.isAbsolute(root) && evidenceRoot && path.isAbsolute(evidenceRoot))) {
    throw new Error('Set absolute BST_M2_CANDIDATE_ROOT and a new BST_M2_ACCEPTANCE_RUN_DIR.');
  }
  const candidateRoot = await realpath(root);
  const runDir = path.join(evidenceRoot, label);
  await mkdir(runDir, { recursive: false });
  const userDataDir = path.join(runDir, 'user-data');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: candidateRoot,
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: candidateRoot,
    encoding: 'utf8',
  });
  if (dirty) {
    throw new Error('Acceptance requires a committed clean candidate, including harness changes.');
  }
  const artifacts = ['dist/main.js', 'dist/preload.js', 'dist/renderer/index.html'];
  const fingerprints = await Promise.all(
    artifacts.map(async (artifact) => {
      const file = path.join(candidateRoot, 'apps/desktop', artifact);
      const bytes = await readFile(file);
      return {
        artifact,
        bytes: (await stat(file)).size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    })
  );
  const helpers: typeof import('../../e2e/utils/electron-helpers.mts') = await import(
    pathToFileURL(path.join(candidateRoot, 'apps/desktop/e2e/utils/electron-helpers.mts')).href
  );
  const evidence: unknown[] = [];
  const record = async (phase: string, value: unknown): Promise<void> => {
    evidence.push({ phase, time: new Date().toISOString(), value });
    await writeFile(path.join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  };
  await record('candidate', { candidateRoot, commit: sha, fingerprints });
  let context: ElectronAppContext | undefined;
  let launches = 0;
  return {
    candidateRoot,
    close: async () => {
      if (!context) {
        return;
      }
      const current = context;
      await record(
        'inference-status-events-after-launch',
        current.window.isClosed()
          ? { visibleWindowClosed: true }
          : await current.window.evaluate(
              () =>
                (window as typeof window & { __m2InferenceStatuses?: EmbeddingHostStatus[] })
                  .__m2InferenceStatuses
            )
      );
      const metrics = await current.app.evaluate(({ app }) => app.getAppMetrics());
      await record('processes-before-close', metrics);
      await record('electron-output', await helpers.getBufferedElectronOutput(current.app));
      if (options.trace !== false) {
        await current.window
          .context()
          .tracing.stop({ path: path.join(runDir, `trace-${launches}.zip`) });
      }
      const child = current.app.process();
      await helpers.closeElectronApp(current);
      await record('main-exit', { code: child.exitCode, signal: child.signalCode });
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
      await expect
        .poll(
          () =>
            metrics
              .filter((metric) => {
                try {
                  process.kill(metric.pid, 0);
                  return true;
                } catch (error) {
                  if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
                    return false;
                  }
                  throw error;
                }
              })
              .map((metric) => ({ pid: metric.pid, type: metric.type })),
          { message: 'Owned Electron processes must exit after close', timeout: 30_000 }
        )
        .toEqual([]);
      await record('owned-processes-joined', { pids: metrics.map((metric) => metric.pid) });
      context = undefined;
    },
    launch: async (env = {}) => {
      if (context) {
        throw new Error('Previous candidate is still owned.');
      }
      context = await helpers.launchElectronAppWithOptions({
        disableExternalLocalRuntimeProbes: true,
        env,
        launchMode: 'built',
        userDataDir,
      });
      launches += 1;
      await context.window.addInitScript(observeInferenceStatus);
      await context.window.evaluate(observeInferenceStatus);
      if (options.trace !== false) {
        await context.window
          .context()
          .tracing.start({ screenshots: true, snapshots: true, sources: true });
      }
      await record(
        'processes-at-launch',
        await context.app.evaluate(({ app }) => app.getAppMetrics())
      );
      return context;
    },
    record,
    runDir,
    userDataDir,
  };
}
