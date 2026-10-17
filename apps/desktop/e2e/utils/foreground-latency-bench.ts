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

export interface SeededRoot {
  readonly path: string;
  readonly rootId: string;
}

/** Opens the roots as the workspace (the first is the open folder), indexing paused. */
export async function seedPausedWorkspace(
  page: Page,
  roots: readonly SeededRoot[],
  device: BenchDevice,
  reloadReason: string
): Promise<void> {
  const firstRoot = roots[0];
  if (!firstRoot) {
    throw new Error('seedPausedWorkspace needs at least one root.');
  }
  await page.evaluate(
    async ({ first, seeded }) => {
      const storage = (
        window as Window & {
          electronAPI?: { storage?: { setItem?: (key: string, value: string) => Promise<void> } };
        }
      ).electronAPI?.storage;
      if (!storage?.setItem) {
        throw new Error('electronAPI.storage.setItem is unavailable.');
      }
      await storage.setItem('lastFolderPath', first);
      await storage.setItem(
        'rootsList',
        JSON.stringify(
          seeded.map((root, index) => ({ addedAt: 1_800_000_000_000 + index, ...root }))
        )
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
    { first: firstRoot.path, seeded: roots }
  );
  await setVectorDevicePreference(page, device);
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reloadReason);
  await expect(page.getByTestId('indexing-status-trigger')).toContainText('Paused', {
    timeout: 60_000,
  });
}

/**
 * The host thread the chat-path probe commits to, started through main's host
 * client (`src/e2e-foreground-latency-probes.ts`), as the composer's first
 * Send starts one.
 */
export async function startProbeThread(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async () => {
    const seam = (globalThis as Record<string, unknown>)[
      '__brainstrike_e2e_foreground_latency_probes__'
    ] as { readonly startProbeThread?: () => Promise<string> } | undefined;
    if (!seam?.startProbeThread) {
      throw new Error(
        'The main process exposes no foreground latency probes; is it running in E2E test mode?'
      );
    }
    return await seam.startProbeThread();
  });
}

/** One reading of the hidden embedding host's renderer process, as main sees it. */
export interface EmbeddingHostReading {
  /**
   * Percent of all cores since the previous reading, as Electron normalizes it:
   * 100 / cores is one busy core, so several busy threads read as a multiple of it.
   */
  readonly cpuPercent: number;
  readonly crossOriginIsolated: boolean;
  readonly hardwareConcurrency: number;
  readonly peakWorkingSetMb: number;
  readonly workingSetMb: number;
}

/**
 * Reads the hidden embedding host: its isolation (BST-1999) and its process's
 * CPU and memory from `app.getAppMetrics()`. Its workers, ONNX Runtime's WASM
 * threads among them, run in that process. Null while no host runs.
 */
export async function readEmbeddingHost(
  app: ElectronApplication
): Promise<EmbeddingHostReading | null> {
  return await app.evaluate(async ({ app: electronApp, BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find((window) => {
      if (window.isDestroyed()) {
        return false;
      }
      try {
        return new URL(window.webContents.getURL()).searchParams.get('mode') === 'embedding-host';
      } catch {
        return false;
      }
    });
    if (!host) {
      return null;
    }
    const pid = host.webContents.getOSProcessId();
    const metric = electronApp.getAppMetrics().find((candidate) => candidate.pid === pid);
    if (!metric) {
      return null;
    }
    const realm = (await host.webContents.executeJavaScript(
      '({ coi: globalThis.crossOriginIsolated === true, cores: navigator.hardwareConcurrency })'
    )) as { readonly coi: boolean; readonly cores: number };
    const mb = (kilobytes: number): number => Math.round(kilobytes / 102.4) / 10;
    return {
      cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
      crossOriginIsolated: realm.coi,
      hardwareConcurrency: realm.cores,
      peakWorkingSetMb: mb(metric.memory.peakWorkingSetSize),
      workingSetMb: mb(metric.memory.workingSetSize),
    };
  });
}

/** The embedding host readings of a loaded window, summarized for the evidence. */
export function embeddingHostMetrics(readings: readonly EmbeddingHostReading[]) {
  const last = readings.at(-1);
  return {
    cpuPercent: summarize(readings.map((reading) => reading.cpuPercent)),
    crossOriginIsolated: last?.crossOriginIsolated ?? null,
    hardwareConcurrency: last?.hardwareConcurrency ?? null,
    peakWorkingSetMb:
      readings.length === 0
        ? null
        : Math.max(...readings.map((reading) => reading.peakWorkingSetMb)),
  };
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
