import { type ElectronApplication, expect, type Page } from '@playwright/test';
import { setVectorDevicePreference } from '../embedding-worker-renderer.shared';
import { updateIndexConfig } from './index-config';
import { loadElectronHelpers } from './load-electron-helpers';

/** Shared setup for the desktop index E2E tests: the device, a paused workspace, the host reading. */

export type BenchDevice = 'wasm' | 'webgpu';

export function readBenchDevice(env: string): BenchDevice {
  const raw = process.env[env]?.trim() || 'webgpu';
  if (raw !== 'wasm' && raw !== 'webgpu') {
    throw new Error(`${env} must be "wasm" or "webgpu", got "${raw}".`);
  }
  return raw;
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
    },
    { first: firstRoot.path, seeded: roots }
  );
  // Paused, so the idle baseline is taken with the workspace open and nothing indexing.
  await updateIndexConfig(page, { paused: true, policy: 'full-root' });
  await setVectorDevicePreference(page, device);
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reloadReason);
  await expect(page.getByTestId('indexing-status-trigger')).toContainText('Paused', {
    timeout: 60_000,
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
