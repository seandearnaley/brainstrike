import os from 'node:os';
import { type ElectronApplication, expect, type Page } from '@playwright/test';
import { setVectorDevicePreference } from '../embedding-worker-renderer.shared';
import {
  type LatencySummary,
  type MainPhaseSamples,
  type RendererWindowSamples,
  summarize,
} from './foreground-latency-probes';
import { loadElectronHelpers } from './load-electron-helpers';

/**
 * The loaded foreground-latency benchmarks' shared setup and reporting
 * (docs/performance/foreground-latency-under-index-build.md). Each benchmark
 * owns its load; these steps and metrics are the same for all of them.
 */

export type BenchDevice = 'wasm' | 'webgpu';

export const WORKSPACE_RESOURCE_ID = 'brainstrike:workspace';
const LONG_FRAME_MS = 50;

interface DbBridgeRow {
  readonly [column: string]: unknown;
}

export function readBenchDevice(env: string): BenchDevice {
  const raw = process.env[env]?.trim() || 'webgpu';
  if (raw !== 'wasm' && raw !== 'webgpu') {
    throw new Error(`${env} must be "wasm" or "webgpu", got "${raw}".`);
  }
  return raw;
}

export async function queryDb(
  page: Page,
  sql: string,
  params: readonly unknown[] = []
): Promise<readonly DbBridgeRow[]> {
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
export async function showAppWindow(app: ElectronApplication, page: Page): Promise<void> {
  const browserWindow = await app.browserWindow(page);
  const visible = await browserWindow.evaluate((win) => {
    win.showInactive();
    return win.isVisible();
  });
  if (!visible) {
    throw new Error('The app window did not become visible.');
  }
}

export async function seedPausedWorkspace(
  page: Page,
  rootPath: string,
  rootId: string,
  device: BenchDevice,
  reloadReason: string
): Promise<void> {
  await page.evaluate(
    async ({ root, id }) => {
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
        JSON.stringify([{ addedAt: 1_800_000_000_000, path: root, rootId: id }])
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
    { id: rootId, root: rootPath }
  );
  await setVectorDevicePreference(page, device);
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reloadReason);
  await page.waitForFunction(
    () =>
      // biome-ignore lint/style/useNamingConvention: Renderer test hook global intentionally uses the app-owned key.
      typeof (window as Window & { __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: unknown })
        .__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ === 'object',
    undefined,
    { timeout: 60_000 }
  );
  await expect(page.getByTestId('indexing-status-trigger')).toContainText('Paused', {
    timeout: 60_000,
  });
}

export async function readWorkspaceIndexSetId(page: Page): Promise<string> {
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
export async function seedRunningChatRun(page: Page): Promise<string> {
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

export function rendererMetrics(samples: RendererWindowSamples) {
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

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function mainMetrics(samples: MainPhaseSamples) {
  return {
    chatPathOpMs: summarize(samples.chatPathOpMs),
    eventLoopLagMs: samples.eventLoopLagMs,
    toolFileReadMs: summarize(samples.toolFileReadMs),
    toolIndexQueryMs: summarize(samples.toolIndexQueryMs),
    toolReadMs: summarize(samples.toolReadMs),
  };
}

export function describeEnvironment(electronVersion: string, loadAverage: readonly number[]) {
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

export function formatSummary(label: string, summary: LatencySummary): string {
  return `${label}: n=${summary.n} p50=${summary.p50} p95=${summary.p95} max=${summary.max}`;
}
