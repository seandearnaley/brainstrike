// Shared fixture helpers for the desktop embedding E2E specs: the hidden
// embedding host's bridge, its logs and the vector device preference.
// biome-ignore-all lint/style/useNamingConvention: shared E2E fixture touches browser globals.
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { Page } from '@playwright/test';
import type { VisibleEmbeddingHostBridge } from '../src/types/desktop-electron-api';
import { test, waitForAppReadyInTest } from './embedding-worker-renderer/electron-app-fixture';
import { expect } from './fixtures/electron-fixture';
import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';

export type {
  ElectronApplication,
  Locator,
  Page,
} from './embedding-worker-renderer/electron-app-fixture';
export {
  closeElectronAppInTest,
  DESKTOP_DEV_RENDERER_PORT,
  DESKTOP_DEV_RENDERER_URL,
  expect,
  getBufferedElectronOutputInTest,
  isDisposedElectronEvaluateError,
  launchElectronDevAppInTest,
  os,
  path,
  reloadRendererInTest,
  showDatabaseDemoPanel,
  test,
  waitForAppReadyInTest,
  waitForTcpPortOpen,
  withTemporaryProcessEnv,
} from './embedding-worker-renderer/electron-app-fixture';
export { ensureMockWorkspaceOpen } from './utils/layout-helpers';
export type { WorkspaceSemanticSearchSnapshot } from './utils/workspace-search-helpers';
// Workspace Search is the surviving semantic-search surface; these replace the
// retired Collection Browser hybrid-search harness.
export {
  getWorkspaceSemanticSearchSnapshot,
  openWorkspaceSearchPanel,
  runWorkspaceSemanticSearch,
  selectWorkspaceSearchCollection,
  waitForWorkspaceSemanticSearchResults,
} from './utils/workspace-search-helpers';

export interface BufferedLogRecord {
  args: readonly unknown[];
  message?: string;
}

export interface EmbeddingHostStatus {
  active: boolean;
  commandId?: string;
  /** Present once an embedding has run; startup loads no model. */
  embeddingRuntime?: unknown;
  lastError: string | null;
  runtimeId: string;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

export interface MainBufferedLogRecord {
  args?: readonly unknown[];
  bindings?: Record<string, unknown>;
  message?: string;
  scope?: string;
}

export const AUTOMATIC_WEBGPU_UNAVAILABLE_ERROR =
  'Workspace Index requires WebGPU for automatic local embedding execution. Device detection recommended WASM, which is a slow/debug backend and will not be selected automatically. WASM fallback (WebGPU not available) No WebGPU adapter found - GPU may not support WebGPU or driver update needed WebGPU adapter is unavailable.';

export const ERROR_LOCATOR = '[data-testid="db-init-error"]';

export async function isDatabaseError(page: Page): Promise<boolean> {
  try {
    return await page.locator(ERROR_LOCATOR).isVisible({ timeout: 200 });
  } catch {
    return false;
  }
}

export async function getEmbeddingHostStatus(page: Page): Promise<EmbeddingHostStatus> {
  return await page.evaluate<EmbeddingHostStatus>(async () => {
    const host = (
      window as Window & {
        embeddingHost?: {
          getStatus?: () => Promise<EmbeddingHostStatus>;
        };
      }
    ).embeddingHost;
    if (!host?.getStatus) {
      throw new Error('Embedding host bridge is not available');
    }
    return await host.getStatus();
  });
}

export async function ensureEmbeddingHostStarted(page: Page): Promise<EmbeddingHostStatus> {
  return await page.evaluate<EmbeddingHostStatus>(async () => {
    const host = (
      window as Window & {
        embeddingHost?: {
          ensureStarted?: () => Promise<EmbeddingHostStatus>;
        };
      }
    ).embeddingHost;
    if (!host?.ensureStarted) {
      throw new Error('Embedding host bridge is not available');
    }
    return await host.ensureStarted();
  });
}

/** A local query with no inference plan, so the host's own device choice applies. */
export async function requestLocalQueryEmbedding(page: Page): Promise<BoundaryResult<number[]>> {
  return await page.evaluate(async () => {
    const host = (window as Window & { readonly embeddingHost?: VisibleEmbeddingHostBridge })
      .embeddingHost;
    if (!(host && 'queryEmbedding' in host)) {
      throw new Error('Hosted query is unavailable.');
    }
    return await host.queryEmbedding(
      {
        dimensions: 384,
        modelId: 'Xenova/all-MiniLM-L6-v2',
        modelKey: 'local::Xenova/all-MiniLM-L6-v2',
        query: 'local query embedding probe',
      },
      { requestId: crypto.randomUUID() }
    );
  });
}

export async function getMainBufferedLogs(page: Page): Promise<MainBufferedLogRecord[]> {
  return await page.evaluate<MainBufferedLogRecord[]>(async () => {
    const loggingApi = (
      window as Window & {
        logging?: {
          getBufferedLogs?: () => Promise<BoundaryResult<MainBufferedLogRecord[]>>;
        };
      }
    ).logging;
    if (!loggingApi?.getBufferedLogs) {
      throw new Error('Logging bridge is not available');
    }
    const response = await loggingApi.getBufferedLogs();
    if (!response.ok) {
      throw new Error(JSON.stringify(response.error));
    }
    return response.value;
  });
}

export async function stopEmbeddingHost(page: Page): Promise<EmbeddingHostStatus> {
  return await page.evaluate<EmbeddingHostStatus>(async () => {
    const host = (
      window as Window & {
        embeddingHost?: {
          stop?: () => Promise<EmbeddingHostStatus>;
        };
      }
    ).embeddingHost;
    if (!host?.stop) {
      throw new Error('Embedding host stop bridge is not available');
    }
    return await host.stop();
  });
}

export async function getEmbeddingHostPage(window: Page): Promise<Page> {
  const context = window.context();
  const startedAt = Date.now();

  while (Date.now() - startedAt < 15_000) {
    const hostPage = context
      .pages()
      .find((page) => page.url().includes('mode=embedding-host') && !page.isClosed());

    if (hostPage) {
      await hostPage.waitForLoadState('domcontentloaded');
      return hostPage;
    }

    await window.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for hidden embedding host page');
}

export async function getRendererLogRecords(page: Page): Promise<BufferedLogRecord[]> {
  return await page.evaluate<BufferedLogRecord[]>(() => {
    const logBuffer = (
      window as Window & {
        __brainstrikeRendererLogBuffer?: {
          getRecords?: () => readonly BufferedLogRecord[];
        };
      }
    ).__brainstrikeRendererLogBuffer;

    if (!logBuffer?.getRecords) {
      throw new Error('Renderer log buffer is not available');
    }

    return [...logBuffer.getRecords()];
  });
}

export async function ensureFileExplorerPanelVisible(page: Page): Promise<void> {
  const explorerPanel = getContextExplorerFileExplorerPanel(page);
  const showExplorerPanelButton = page
    .getByTestId('show-explorer-panel')
    .or(page.getByRole('button', { name: /show explorer/i }));

  if (
    !(await explorerPanel.isVisible().catch(() => false)) &&
    (await showExplorerPanelButton.isVisible().catch(() => false))
  ) {
    await showExplorerPanelButton.click();
  }

  await expect(explorerPanel).toBeVisible({ timeout: 15_000 });
}

export async function getVisibleAlertTexts(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))
      .map((node) => node.textContent?.trim() ?? '')
      .filter((text) => text.length > 0)
  );
}

export function extractUnexpectedLifecycleLogs(
  records: readonly MainBufferedLogRecord[]
): MainBufferedLogRecord[] {
  return records.filter((record) => {
    const message = record.message ?? '';
    const reloadReason = record.bindings?.['reloadReason'];
    return (
      message.includes('Renderer process gone') ||
      message.includes('Renderer crashed; deferring recovery') ||
      message.includes('did-fail-load') ||
      message.includes('Render frame was disposed before WebFrameMain could be accessed') ||
      reloadReason === 'renderer-crash-recovery'
    );
  });
}

export function recordContainsText(record: BufferedLogRecord, text: string): boolean {
  if (typeof record.message === 'string' && record.message.includes(text)) {
    return true;
  }

  return record.args.some((arg) => typeof arg === 'string' && arg.includes(text));
}

export async function getRendererTimeOrigin(page: Page): Promise<number> {
  return await page.evaluate(() => window.performance.timeOrigin);
}

export async function setVectorDevicePreference(
  page: Page,
  devicePref: 'wasm' | 'webgpu'
): Promise<void> {
  await page.evaluate((nextDevicePref) => {
    const storageBridge = (
      window as Window & {
        electronAPI?: {
          storage?: {
            setItem?: (key: string, value: string) => Promise<void>;
          };
        };
      }
    ).electronAPI?.storage;

    if (!storageBridge?.setItem) {
      throw new Error('Electron storage bridge is not available');
    }

    return storageBridge.setItem(
      'vector-preferences.v1',
      JSON.stringify({
        state: {
          devicePref: nextDevicePref,
          devicePrefConfigured: true,
          reinitEveryN: 200,
          verboseOrtLogs: false,
        },
        version: 3,
      })
    );
  }, devicePref);
}

test.beforeAll(async ({ electron }) => {
  test.setTimeout(300_000);
  const { window: appWindow } = await electron.ensureContext();
  await waitForAppReadyInTest(appWindow);
});

test.beforeEach(async ({ electron }) => {
  await electron.ensureWindow();
});
