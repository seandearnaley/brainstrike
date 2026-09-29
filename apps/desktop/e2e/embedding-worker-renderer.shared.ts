// Shared fixture helpers for the split desktop embedding E2E specs.
// This file is intentionally larger than normal source files because it keeps
// the former monolithic spec's setup code in one documented fixture surface.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: shared E2E fixture preserves historical setup helpers.
// biome-ignore-all lint/style/useNamingConvention: shared E2E fixture touches browser globals and DB-shaped fields.
import type { Locator, Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import {
  getBufferedElectronOutputInTest,
  isDisposedElectronEvaluateError,
  reloadRendererInTest,
  test,
  waitForAppReadyInTest,
} from './embedding-worker-renderer/electron-app-fixture';
import { expect } from './fixtures/electron-fixture';

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
export type { WorkspaceSemanticSearchSnapshot } from './utils/workspace-search-helpers';
// Workspace Search is the surviving semantic-search surface; these replace the
// retired Collection Browser hybrid-search harness.
export {
  attachCollectionFilesToWorkspaceRoot,
  getWorkspaceSemanticSearchSnapshot,
  openWorkspaceSearchPanel,
  runWorkspaceSemanticSearch,
  selectWorkspaceSearchCollection,
  waitForWorkspaceSemanticSearchResults,
} from './utils/workspace-search-helpers';

import { getContextExplorerFileExplorerPanel } from './utils/context-explorer-locators';
import type { ElectronAppContext } from './utils/electron-helpers.mts';
import { importSelectedFilesFromExplorer } from './utils/explorer-import';
import { showDatabaseDemoPanel } from './utils/layout-helpers';
import { attachCollectionFilesToWorkspaceRoot } from './utils/workspace-search-helpers';

export { ensureMockWorkspaceOpen } from './utils/layout-helpers';

export interface BufferedLogRecord {
  args: readonly unknown[];
  message?: string;
}

export interface EmbeddingHostStatus {
  active: boolean;
  commandId?: string;
  lastError: string | null;
  runtimeId: string;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

export interface ChunkingHostStatus {
  active: boolean;
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

export interface MainProcessHealthRuntimeMetric {
  osProcessId: number | null;
  runtimeKind: 'chunking-host' | 'embedding-host' | 'visible-ui';
  workingSetKB: number | null;
}

export interface MainProcessHealthSample {
  backgroundRuntimeMetrics: readonly MainProcessHealthRuntimeMetric[];
  cpuPercent: number | null;
  heapUsedKB: number | null;
  loopLagMaxMs: number | null;
  loopLagP99Ms: number | null;
  rssKB: number | null;
  visibleUiWorkingSetKB: number | null;
}

export interface ElectronE2eFileSystemFixture {
  directoriesByPath: Record<string, unknown[]>;
  fileContentsByPath: Record<string, string>;
  readDirectoryCalls: string[];
  readFileByPathCalls: string[];
  readFileCalls: string[];
  requestDirectoryAccessCount: number;
  rootHandle: {
    id: string;
    kind: 'directory';
    name: string;
    path: string;
    platform: 'electron';
    type: 'directory';
  };
}

export interface ElectronE2eFileSystemFixtureSummary {
  directoryPaths: string[];
  fileCount: number;
  readDirectoryCalls: string[];
  readFileByPathCallCount: number;
  readFileCallCount: number;
  requestDirectoryAccessCount: number;
  rootHandlePath: string;
}

export interface QueueStatsRow {
  failed: number;
  queued: number;
  running: number;
  succeeded: number;
}

export interface EmbeddingSetCounts {
  embeddedChunks: number;
  fileCount: number;
  totalChunks: number;
}

export interface EmbeddingSetCountsRow {
  embeddedChunks: number | string | null;
  fileCount: number | string | null;
  totalChunks: number | string | null;
}

export interface EmbeddingBackfillInfo {
  embeddingSetId: string;
  progress: { current: number; total: number } | null;
  requestId: string;
  source: 'background-indexing' | 'manual';
}

export interface ImportedPathCounts {
  fileCount: number;
  totalChunks: number;
}

export interface FileExplorerTestSnapshot {
  currentFolderId: string | null;
  materializedPathCount: number;
  materializedPathSamples: string[];
  rootDirectoryPath: string | null;
  selectedFilePathCount: number;
  selectedFilePathSamples: string[];
  selectionMode: 'explicit' | 'query';
  treeRootCount: number;
  treeSamples: Array<{
    childCount: number;
    path: string;
    rootFolderId: string | null;
    type: string;
  }>;
}

export interface DatabaseDemoImportTestSnapshot {
  activeCollectionId: string | null;
  isImporting: boolean;
  progress: {
    completed: number;
    current: string;
    errors: Array<{ error: string; file: string }>;
    phase: string;
    total: number;
  } | null;
  recordCount: number;
  recordPagination: {
    currentPage: number;
    pageSize: number;
    totalRecords: number;
  };
  selectedFileCount: number;
}

export interface HeapSnapshot {
  label: string;
  limitMB: number;
  totalMB: number;
  usedMB: number;
}

export interface RuntimeProcessSnapshot {
  osProcessId: number | null;
  privateMB: number | null;
  runtimeKind: 'chunking-host' | 'embedding-host' | 'llm-host' | 'visible-ui';
  sharedMB: number | null;
  workingSetMB: number | null;
}

export interface DesktopProcessSnapshot {
  mainProcess: {
    heapUsedMB: number;
    rssMB: number;
  };
  runtimes: RuntimeProcessSnapshot[];
}

export interface CombinedMemorySnapshot {
  hostHeap: HeapSnapshot;
  label: string;
  process: DesktopProcessSnapshot;
  visibleHeap: HeapSnapshot;
}

export interface BackfillCorpusFixture {
  embeddingSetId: string;
  fileCount: number;
  totalChunks: number;
}

export interface RealWorldMixedStateScenario {
  activeWindow: Page;
  backgroundFixture: BackfillCorpusFixture;
  importCollectionName: string;
  importEmbeddingSetId: string;
  importImportedPathCounts: ImportedPathCounts;
  initialTimeOrigin: number;
  sawChunkingHostActive: boolean;
  searchableCollectionName: string;
  searchableEmbeddingSetId: string;
  /** DB root id the searchable fixture files were attributed to. */
  searchableWorkspaceRootId: string;
}

export interface LargeCollectionListFixture {
  embeddingSetId: string;
  fileCount: number;
}

export interface MemorySample {
  elapsedMs: number;
  queueStats: QueueStatsRow;
  snapshot: CombinedMemorySnapshot;
}

export interface AppMetricSample {
  memoryKB: number;
  name: string;
  pid: number;
  type: string;
}

export interface GpuWorkingSetScore {
  maxGpuKB: number;
  maxTotalKB: number;
  medianGpuKB: number;
  medianTotalKB: number;
  minGpuKB: number;
  minSample: AppMetricSample[];
  minTotalKB: number;
}

export interface NumericSampleScore {
  max: number;
  median: number;
  min: number;
}

export interface PostTargetMemorySample {
  appMetrics: AppMetricSample[];
  hostWorkingSetMB: number;
}

export const LARGE_BACKFILL_FILE_COUNT = 1000;
export const LARGE_BACKFILL_CHUNKS_PER_FILE = 20;
export const LARGE_COLLECTION_LIST_FILE_COUNT = 50_000;
export const LARGE_COLLECTION_RENDER_FILE_COUNT = 5000;
export const LARGE_COLLECTION_RENDER_CHUNKS_PER_FILE = 10;
// Repeated-cycle coverage is about retained-memory drift on a single live host.
// The local-only large chunk pressure test above covers peak-load behavior.
export const LARGE_BACKFILL_CYCLE_FILE_COUNT = 32;
export const LARGE_BACKFILL_CYCLE_CHUNKS_PER_FILE = 8;
export const LARGE_BACKFILL_SAMPLE_COUNT = 6;
export const LARGE_BACKFILL_SAMPLE_INTERVAL_MS = 2500;
export const LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB = 120;
export const LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB = 80;
export const LARGE_BACKFILL_MAIN_RSS_GROWTH_LIMIT_MB = 180;
export const LARGE_BACKFILL_MAIN_HEAP_GROWTH_LIMIT_MB = 80;
export const LARGE_BACKFILL_IDLE_HOST_HEAP_DRIFT_LIMIT_MB = 40;
export const LARGE_BACKFILL_IDLE_MAIN_RSS_DRIFT_LIMIT_MB = 90;
// Calibrated from three sequential local runs with --enable-precise-memory-info
// documented in docs/agents/ci-quality.md (the earlier Ubuntu workflow samples
// predate that flag, when heap reads were quantized/cached and every delta was
// a dead 0.0). Both paths measured shrinking heap (-8.1..-8.4 MB) and
// working set; these positive floors retain noise headroom while still
// rejecting a material full-collection hydration regression.
export const LARGE_COLLECTION_VISIBLE_HEAP_GROWTH_LIMIT_MB = 16;
export const LARGE_COLLECTION_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB = 32;
export const LARGE_COLLECTION_LIST_VISIBLE_HEAP_GROWTH_LIMIT_MB = 16;
export const LARGE_COLLECTION_LIST_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB = 32;
export const ACTUAL_IMPORT_STRESS_FILE_COUNT = 1000;
export const ACTUAL_IMPORT_SENTENCES_PER_FILE = 24;
export const ACTUAL_IMPORT_VISIBLE_WORKING_SET_LIMIT_MB = 1400;
export const DEFAULT_12K_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB = 1000;
export const DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT = 4;
// Mirrors the desktop hidden-host idle claim batch. Running queue rows are
// claimed jobs, not concurrent model executions.
export const DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT = 16;
export const REAL_WORLD_MIXED_STATE_FILE_COUNT = 1002;
export const REAL_WORLD_BACKGROUND_FILE_COUNT = 96;
export const REAL_WORLD_BACKGROUND_CHUNKS_PER_FILE = 8;
export const EMBEDDING_BACKFILL_CANCELED_MESSAGE = 'Embedding backfill was canceled.';
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

export async function assertToolsPanelResponsive(page: Page): Promise<void> {
  const assistantShell = page.getByTestId('assistant-chat-card');
  const workspaceToggle = page
    .getByTestId('show-workspace-panel')
    .or(page.getByTestId('hide-workspace-panel'));

  await expect(assistantShell).toBeVisible({ timeout: 10_000 });
  await expect(workspaceToggle.first()).toBeVisible({ timeout: 10_000 });
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

export async function getChunkingHostStatus(page: Page): Promise<ChunkingHostStatus> {
  return await page.evaluate<ChunkingHostStatus>(async () => {
    const host = (
      window as Window & {
        chunkingHost?: {
          getStatus?: () => Promise<ChunkingHostStatus>;
        };
      }
    ).chunkingHost;
    if (!host?.getStatus) {
      throw new Error('Chunking host bridge is not available');
    }
    return await host.getStatus();
  });
}

export async function getMainBufferedLogs(page: Page): Promise<MainBufferedLogRecord[]> {
  return await page.evaluate<MainBufferedLogRecord[]>(async () => {
    const loggingApi = (
      window as Window & {
        logging?: {
          getBufferedLogs?: () => Promise<MainBufferedLogRecord[]>;
        };
      }
    ).logging;
    if (!loggingApi?.getBufferedLogs) {
      throw new Error('Logging bridge is not available');
    }
    return await loggingApi.getBufferedLogs();
  });
}

export async function resetEmbeddingHost(page: Page): Promise<EmbeddingHostStatus> {
  return await page.evaluate<EmbeddingHostStatus>(async () => {
    const host = (
      window as Window & {
        embeddingHost?: {
          reset?: () => Promise<EmbeddingHostStatus>;
        };
      }
    ).embeddingHost;
    if (!host?.reset) {
      throw new Error('Embedding host reset bridge is not available');
    }
    return await host.reset();
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

export async function destroyEmbeddingHostWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const hostWindow = BrowserWindow.getAllWindows().find((browserWindow) =>
      browserWindow.webContents.getURL().includes('mode=embedding-host')
    );
    if (!hostWindow) {
      throw new Error('Embedding host window not found.');
    }
    hostWindow.destroy();
  });
}

export async function stopChunkingHost(page: Page): Promise<ChunkingHostStatus> {
  return await page.evaluate<ChunkingHostStatus>(async () => {
    const host = (
      window as Window & {
        chunkingHost?: {
          stop?: () => Promise<ChunkingHostStatus>;
        };
      }
    ).chunkingHost;
    if (!host?.stop) {
      throw new Error('Chunking host stop bridge is not available');
    }
    return await host.stop();
  });
}

export async function waitForEmbeddingHostState(
  page: Page,
  predicate: (status: EmbeddingHostStatus) => boolean,
  timeoutMs = 15_000
): Promise<EmbeddingHostStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getEmbeddingHostStatus(page);
    if (predicate(status)) {
      return status;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for embedding host state');
}

export async function waitForActiveProcessingOrFatalError(
  page: Page,
  timeoutMs = 60_000
): Promise<'error' | 'running'> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [status, queueStats] = await Promise.all([
      getEmbeddingHostStatus(page),
      getEmbeddingQueueStats(page),
    ]);

    if (status.state === 'error') {
      return 'error';
    }

    if (
      status.active &&
      queueStats.running > 0 &&
      queueStats.running <= DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT
    ) {
      return 'running';
    }

    await page.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for active embedding processing or fatal host error');
}

export async function waitForBackfillButtonEnabled(
  page: Page,
  backfillButton: ReturnType<Page['locator']>,
  timeoutMs = 15_000
): Promise<void> {
  await waitForBackfillReadiness(
    page,
    backfillButton,
    async () => await getEmbeddingQueueStats(page),
    'global embedding queue',
    timeoutMs
  );
}

export async function waitForEmbeddingSetBackfillButtonEnabled(
  page: Page,
  backfillButton: ReturnType<Page['locator']>,
  embeddingSetId: string,
  timeoutMs = 15_000
): Promise<void> {
  await waitForBackfillReadiness(
    page,
    backfillButton,
    async () => await getEmbeddingSetQueueStats(page, embeddingSetId),
    `embedding set ${embeddingSetId}`,
    timeoutMs
  );
}

async function waitForBackfillReadiness(
  page: Page,
  backfillButton: ReturnType<Page['locator']>,
  getQueueStats: () => Promise<QueueStatsRow>,
  queueScope: string,
  timeoutMs: number
): Promise<void> {
  const startedAt = Date.now();
  let lastButtonEnabled = false;
  let lastQueueStats: QueueStatsRow | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const [enabled, queueStats] = await Promise.all([backfillButton.isEnabled(), getQueueStats()]);
    lastButtonEnabled = enabled;
    lastQueueStats = queueStats;

    if (enabled && queueStats.queued === 0 && queueStats.running === 0) {
      return;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for the backfill button to become enabled for ${queueScope}: ` +
      `buttonEnabled=${lastButtonEnabled}, queueStats=${JSON.stringify(lastQueueStats)}`
  );
}

export async function waitForBoundedBackfillEnqueueOrFatalError(
  page: Page,
  timeoutMs = 15_000
): Promise<'error' | 'queued'> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [status, queueStats] = await Promise.all([
      getEmbeddingHostStatus(page),
      getEmbeddingQueueStats(page),
    ]);

    if (status.state === 'error') {
      return 'error';
    }

    const totalObserved =
      queueStats.queued + queueStats.running + queueStats.failed + queueStats.succeeded;
    if (totalObserved > 0 && queueStats.queued + queueStats.running <= 64) {
      return 'queued';
    }

    await page.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for bounded backfill enqueue or fatal host error');
}

export async function waitForBackfillProgressText(
  backfillButton: ReturnType<Page['locator']>,
  timeoutMs = 15_000
): Promise<string> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const label = (await backfillButton.textContent())?.trim() ?? '';
    if (/^\d+\/\d+$/u.test(label)) {
      return label;
    }
    await backfillButton.page().waitForTimeout(100);
  }

  throw new Error('Timed out waiting for visible backfill progress text');
}

export function parseBackfillProgressLabel(label: string): { done: number; total: number } {
  const match = /^(\d+)\/(\d+)$/u.exec(label.trim());
  if (!match) {
    throw new Error(`Invalid backfill progress label: ${label}`);
  }
  const done = Number(match[1]);
  const total = Number(match[2]);
  if (!(Number.isFinite(done) && Number.isFinite(total) && total >= 0 && done >= 0)) {
    throw new Error(`Invalid numeric backfill progress label: ${label}`);
  }
  return { done, total };
}

export async function waitForPositiveBackfillProgress(
  target: Locator,
  timeoutMs = 30_000
): Promise<{ done: number; total: number }> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const progress = parseBackfillProgressLabel(await waitForBackfillProgressText(target, 5000));
    if (progress.done > 0) {
      return progress;
    }
    await target.page().waitForTimeout(250);
  }

  throw new Error('Timed out waiting for positive backfill progress');
}

export async function waitForEmbeddingHostIdleAndQueueDrain(
  page: Page,
  timeoutMs = 120_000
): Promise<{
  queueStats: QueueStatsRow;
  status: EmbeddingHostStatus;
}> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [status, queueStats] = await Promise.all([
      getEmbeddingHostStatus(page),
      getEmbeddingQueueStats(page),
    ]);

    if (status.state === 'error') {
      throw new Error(
        status.lastError ?? 'Embedding host entered an error state while waiting for idle.'
      );
    }

    if (
      status.state === 'running' &&
      !status.active &&
      queueStats.queued === 0 &&
      queueStats.running === 0
    ) {
      return { queueStats, status };
    }

    await page.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for embedding host idle state and queue drain');
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

export async function installLargeImportFileSystemMock(
  electronApp: ElectronApplication,
  options: { fileCount: number; rootPath: string; sentencesPerFile: number }
): Promise<void> {
  const fixture: ElectronE2eFileSystemFixture = {
    directoriesByPath: {},
    fileContentsByPath: {},
    readDirectoryCalls: [],
    readFileByPathCalls: [],
    readFileCalls: [],
    requestDirectoryAccessCount: 0,
    rootHandle: {
      id: 'mock-directory-handle',
      kind: 'directory',
      name: 'mock-stress-directory',
      path: options.rootPath,
      platform: 'electron',
      type: 'directory',
    },
  };

  fixture.directoriesByPath[options.rootPath] = Array.from(
    { length: options.fileCount },
    (_, index) => {
      const fileName = `stress-file-${String(index).padStart(4, '0')}.ts`;
      const path = `${options.rootPath}/${fileName}`;
      const sentences = Array.from(
        { length: options.sentencesPerFile },
        (_, sentenceIndex) =>
          `export const sentence_${sentenceIndex} = "stress-file-${index}-sentence-${sentenceIndex}.";`
      );
      fixture.fileContentsByPath[path] = sentences.join('\n');

      return {
        depth: 1,
        handle: {
          id: `mock-stress-file-${index}`,
          kind: 'file' as const,
          name: fileName,
          path,
          platform: 'electron' as const,
        },
        name: fileName,
        path,
        rootFolderId: fixture.rootHandle.path,
        selectionState: 'unchecked' as const,
        size: fixture.fileContentsByPath[path].length,
        type: 'file' as const,
      };
    }
  );

  await electronApp.evaluate((_electron, nextFixture) => {
    (
      globalThis as typeof globalThis & {
        __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
      }
    ).__brainstrike_e2e_file_system_fixture__ = nextFixture;
  }, fixture);
}

export async function clearLargeImportFileSystemMock(
  electronApp: ElectronApplication
): Promise<void> {
  try {
    await electronApp.evaluate(() => {
      (
        globalThis as typeof globalThis & {
          __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture | undefined;
        }
      ).__brainstrike_e2e_file_system_fixture__ = undefined;
    });
  } catch (error) {
    if (isDisposedElectronEvaluateError(error)) {
      return;
    }
    throw error;
  }
}

export async function getVisibleAlertTexts(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))
      .map((node) => node.textContent?.trim() ?? '')
      .filter((text) => text.length > 0)
  );
}

export async function getFileExplorerTestSnapshot(
  page: Page
): Promise<FileExplorerTestSnapshot | null> {
  return await page.evaluate<FileExplorerTestSnapshot | null>(() => {
    const hooks = (
      window as Window & {
        __brainstrikeFileExplorerTestHooks__?: {
          getSnapshot?: () => FileExplorerTestSnapshot;
        };
      }
    ).__brainstrikeFileExplorerTestHooks__;
    if (!hooks?.getSnapshot) {
      return null;
    }
    return hooks.getSnapshot();
  });
}

export async function getDatabaseDemoImportSnapshot(
  page: Page
): Promise<DatabaseDemoImportTestSnapshot | null> {
  return await page.evaluate<DatabaseDemoImportTestSnapshot | null>(() => {
    const hooks = (
      window as Window & {
        __brainstrikeDatabaseDemoTestHooks__?: {
          getImportSnapshot?: () => DatabaseDemoImportTestSnapshot;
        };
      }
    ).__brainstrikeDatabaseDemoTestHooks__;
    if (!hooks?.getImportSnapshot) {
      return null;
    }
    return hooks.getImportSnapshot();
  });
}

export async function getMainProcessFileSystemFixtureSummary(
  electronApp: ElectronApplication
): Promise<ElectronE2eFileSystemFixtureSummary | null> {
  return await electronApp.evaluate(() => {
    const fixture = globalThis as typeof globalThis & {
      __brainstrike_e2e_file_system_fixture__?: ElectronE2eFileSystemFixture;
    };
    const currentFixture = fixture.__brainstrike_e2e_file_system_fixture__;
    if (!currentFixture) {
      return null;
    }

    return {
      directoryPaths: Object.keys(currentFixture.directoriesByPath),
      fileCount: Object.keys(currentFixture.fileContentsByPath).length,
      readDirectoryCalls: [...currentFixture.readDirectoryCalls],
      readFileByPathCallCount: currentFixture.readFileByPathCalls.length,
      readFileCallCount: currentFixture.readFileCalls.length,
      requestDirectoryAccessCount: currentFixture.requestDirectoryAccessCount,
      rootHandlePath: currentFixture.rootHandle.path,
    };
  });
}

export async function setImportSettingsForStressTest(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem(
      'import-settings.v1',
      JSON.stringify({
        state: {
          chunkingPreset: 'custom',
          chunkingStrategy: 'sentence',
          chunkingStrategyExplicit: true,
          chunkOverlap: 0,
          chunkSize: 512,
          chunkTokenLimit: 4096,
          enableChunking: true,
          tokenTrueSizing: true,
        },
        version: 7,
      })
    );
  });
}

export async function setFileExplorerMaxSelectionCount(
  page: Page,
  maxSelectionCount: number
): Promise<void> {
  await dismissBlockingToastNotifications(page);

  const selectionSettingsButton = page.getByRole('button', { name: 'Selection settings' });
  await expect(selectionSettingsButton).toBeVisible({ timeout: 15_000 });
  await selectionSettingsButton.click({ timeout: 5000 });

  const selectionCountInput = page.getByLabel('Maximum selection count input');
  await expect(selectionCountInput).toBeVisible({ timeout: 15_000 });
  await selectionCountInput.fill(String(maxSelectionCount));
  await page.getByRole('button', { name: 'Apply selection count' }).click({ timeout: 5000 });
  await expect(page.getByTestId('selection-max')).toHaveText(String(maxSelectionCount), {
    timeout: 15_000,
  });
}

async function dismissBlockingToastNotifications(page: Page): Promise<void> {
  const notificationItems = page.locator(
    '[role="region"][aria-label^="Notifications"] [data-radix-collection-item]'
  );
  const closeButtons = page.locator('[role="region"][aria-label^="Notifications"] [toast-close]');

  for (let attempt = 0; attempt < 5; attempt++) {
    const notificationCount = await notificationItems.count();
    if (notificationCount === 0) {
      return;
    }

    const closeButtonCount = await closeButtons.count();
    if (closeButtonCount === 0) {
      break;
    }

    await closeButtons.first().click({ timeout: 2000 });
    await page.waitForTimeout(150);
  }

  await expect(notificationItems).toHaveCount(0, { timeout: 5000 });
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

export function parseNumericLogField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function getMainProcessHealthPayload(
  record: MainBufferedLogRecord
): Record<string, unknown> | null {
  if (record.scope !== 'DesktopMain' || record.message !== 'main-process-health') {
    return null;
  }

  const payload = record.args?.find((arg): arg is Record<string, unknown> => {
    if (!(arg && typeof arg === 'object') || Array.isArray(arg)) {
      return false;
    }

    return Array.isArray((arg as Record<string, unknown>)['backgroundRuntimeMetrics']);
  });

  return payload ?? null;
}

export function parseMainProcessHealthSamples(
  records: readonly MainBufferedLogRecord[]
): MainProcessHealthSample[] {
  return records.flatMap((record) => {
    const payload = getMainProcessHealthPayload(record);
    if (!payload) {
      return [];
    }

    const runtimeMetrics = Array.isArray(payload['backgroundRuntimeMetrics'])
      ? payload['backgroundRuntimeMetrics']
          .filter(
            (metric): metric is Record<string, unknown> =>
              !!metric && typeof metric === 'object' && !Array.isArray(metric)
          )
          .map((metric) => {
            const runtimeKind = metric['runtimeKind'];
            if (
              runtimeKind !== 'visible-ui' &&
              runtimeKind !== 'embedding-host' &&
              runtimeKind !== 'chunking-host'
            ) {
              throw new Error(
                `Unexpected runtime kind in main-process-health payload: ${String(runtimeKind)}`
              );
            }

            return {
              osProcessId: parseNumericLogField(metric['osProcessId']),
              runtimeKind,
              workingSetKB: parseNumericLogField(metric['workingSetKb']),
            } satisfies MainProcessHealthRuntimeMetric;
          })
      : [];

    return [
      {
        backgroundRuntimeMetrics: runtimeMetrics,
        cpuPercent: parseNumericLogField(payload['cpuPercent']),
        heapUsedKB: parseNumericLogField(payload['heapUsedKb']),
        loopLagMaxMs: parseNumericLogField(payload['loopLagMaxMs']),
        loopLagP99Ms: parseNumericLogField(payload['loopLagP99Ms']),
        rssKB: parseNumericLogField(payload['rssKb']),
        visibleUiWorkingSetKB:
          runtimeMetrics.find((metric) => metric.runtimeKind === 'visible-ui')?.workingSetKB ??
          null,
      } satisfies MainProcessHealthSample,
    ];
  });
}

export function recordContainsText(record: BufferedLogRecord, text: string): boolean {
  if (typeof record.message === 'string' && record.message.includes(text)) {
    return true;
  }

  return record.args.some((arg) => typeof arg === 'string' && arg.includes(text));
}

export function countRecordsContainingText(
  records: readonly BufferedLogRecord[],
  text: string
): number {
  return records.filter((record) => recordContainsText(record, text)).length;
}

export function extractStructuredLogString(
  record: BufferedLogRecord,
  key: 'error' | 'stack'
): string | null {
  for (const arg of record.args) {
    if (!(arg && typeof arg === 'object')) {
      continue;
    }

    const candidate = (arg as Record<string, unknown>)[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return null;
}

export async function forceRendererGarbageCollection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globalWindow = window as Window & { gc?: () => void };
    if (typeof globalWindow.gc !== 'function') {
      throw new Error('Renderer garbage collection is unavailable in the desktop E2E runtime.');
    }
    globalWindow.gc();
  });
  await page.waitForTimeout(500);
}

export async function readRendererHeapSnapshot(page: Page, label: string): Promise<HeapSnapshot> {
  return await page.evaluate<HeapSnapshot, string>((snapshotLabel) => {
    const memory = (
      performance as Performance & {
        memory?: {
          usedJSHeapSize: number;
          totalJSHeapSize: number;
          jsHeapSizeLimit: number;
        };
      }
    ).memory;
    if (!memory) {
      throw new Error('performance.memory is unavailable in this renderer');
    }

    return {
      label: snapshotLabel,
      limitMB: Math.round((memory.jsHeapSizeLimit / 1024 / 1024) * 10) / 10,
      totalMB: Math.round((memory.totalJSHeapSize / 1024 / 1024) * 10) / 10,
      usedMB: Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10,
    };
  }, label);
}

export async function readDesktopProcessSnapshot(
  electronApp: ElectronApplication
): Promise<DesktopProcessSnapshot> {
  return await electronApp.evaluate<DesktopProcessSnapshot>(async ({ BrowserWindow }) => {
    const toMBFromKilobytes = (value: number | undefined): number | null =>
      typeof value === 'number' && Number.isFinite(value)
        ? Math.round((value / 1024) * 10) / 10
        : null;

    const runtimes = await Promise.all(
      BrowserWindow.getAllWindows().map(async (browserWindow) => {
        const webContents = browserWindow.webContents as typeof browserWindow.webContents & {
          getProcessMemoryInfo?: () => Promise<{
            private: number;
            residentSet: number;
            shared: number;
          }>;
        };
        const url = browserWindow.webContents.getURL();
        let mode: string | null = null;
        try {
          mode = new URL(url).searchParams.get('mode');
        } catch {
          mode = null;
        }
        // Hidden hosts declare their DesktopWindowRole via the `mode` URL
        // param (renderer-host-lifecycle.ts); the visible window has none.
        // An unknown mode must throw rather than be silently measured as the
        // visible UI (e.g. a lazily started llm-host skewing UI ceilings).
        if (
          !(
            mode === null ||
            mode === 'embedding-host' ||
            mode === 'chunking-host' ||
            mode === 'llm-host'
          )
        ) {
          throw new Error(
            `Unknown desktop window mode "${mode}" (url: ${url}); update the E2E runtime classifier in embedding-worker-renderer.shared.ts.`
          );
        }
        const runtimeKind: RuntimeProcessSnapshot['runtimeKind'] = mode ?? 'visible-ui';
        const osProcessId = browserWindow.webContents.getOSProcessId();
        if (typeof webContents.getProcessMemoryInfo !== 'function') {
          return {
            osProcessId,
            privateMB: null,
            runtimeKind,
            sharedMB: null,
            workingSetMB: null,
          };
        }

        const memory = await webContents.getProcessMemoryInfo();

        return {
          osProcessId,
          privateMB: toMBFromKilobytes(memory.private),
          runtimeKind,
          sharedMB: toMBFromKilobytes(memory.shared),
          workingSetMB: toMBFromKilobytes(memory.residentSet),
        };
      })
    );

    const mainMemory = process.memoryUsage();
    return {
      mainProcess: {
        heapUsedMB: Math.round((mainMemory.heapUsed / 1024 / 1024) * 10) / 10,
        rssMB: Math.round((mainMemory.rss / 1024 / 1024) * 10) / 10,
      },
      runtimes: runtimes.sort((left, right) => left.runtimeKind.localeCompare(right.runtimeKind)),
    };
  });
}

export function getRuntimeSnapshot(
  snapshot: DesktopProcessSnapshot,
  runtimeKind: RuntimeProcessSnapshot['runtimeKind']
): RuntimeProcessSnapshot {
  const runtime = snapshot.runtimes.find((entry) => entry.runtimeKind === runtimeKind);
  if (!runtime) {
    throw new Error(`Missing runtime process snapshot for ${runtimeKind}`);
  }
  return runtime;
}

export function requireRuntimeWorkingSetMB(
  snapshot: DesktopProcessSnapshot,
  runtimeKind: RuntimeProcessSnapshot['runtimeKind']
): number {
  const workingSetMB = getRuntimeSnapshot(snapshot, runtimeKind).workingSetMB;
  if (typeof workingSetMB !== 'number') {
    throw new Error(`Missing ${runtimeKind} working-set measurement.`);
  }
  return workingSetMB;
}

export function growth(after: number, before: number): number {
  return Math.round((after - before) * 10) / 10;
}

export function scoreNumericSamples(samples: readonly number[]): NumericSampleScore {
  if (samples.length === 0) {
    throw new Error('Numeric sample scoring requires at least one sample.');
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const medianIndex = Math.floor(sorted.length / 2);
  return {
    max: sorted.at(-1) ?? 0,
    median: sorted[medianIndex] ?? 0,
    min: sorted[0] ?? 0,
  };
}

export async function readTrackedRuntimeWorkingSetMB(
  app: ElectronApplication,
  page: Page,
  runtimeKind: RuntimeProcessSnapshot['runtimeKind'],
  timeoutMs = 15_000
): Promise<number | null> {
  const startedAt = Date.now();
  let lastDisposedError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await app.evaluate<number | null, RuntimeProcessSnapshot['runtimeKind']>(
        ({ app: electronApp, BrowserWindow }, expectedRuntimeKind) => {
          // Classify EVERY window before selecting, mirroring
          // readDesktopProcessSnapshot: a `find` predicate would short-circuit
          // at the first match (the mode-less visible window is created
          // first), so an unknown-mode guard inside it could never fire for a
          // 'visible-ui' lookup. An unknown window mode must throw, never be
          // silently classified as the visible UI.
          const classifiedWindows = BrowserWindow.getAllWindows().map((browserWindow) => {
            const url = browserWindow.webContents.getURL();
            let mode: string | null = null;
            try {
              mode = new URL(url).searchParams.get('mode');
            } catch {
              mode = null;
            }
            if (
              !(
                mode === null ||
                mode === 'embedding-host' ||
                mode === 'chunking-host' ||
                mode === 'llm-host'
              )
            ) {
              throw new Error(
                `Unknown desktop window mode "${mode}" (url: ${url}); update the E2E runtime classifier in embedding-worker-renderer.shared.ts.`
              );
            }
            return { browserWindow, runtimeKind: mode ?? 'visible-ui' };
          });
          const hostWindow = classifiedWindows.find(
            (entry) => entry.runtimeKind === expectedRuntimeKind
          )?.browserWindow;
          if (!hostWindow) {
            return null;
          }
          const osProcessId = hostWindow.webContents.getOSProcessId();
          if (!Number.isInteger(osProcessId) || osProcessId <= 0) {
            return null;
          }
          const metric = electronApp.getAppMetrics().find((entry) => entry.pid === osProcessId);
          const workingSetSize = metric?.memory?.workingSetSize;
          if (!(typeof workingSetSize === 'number' && Number.isFinite(workingSetSize))) {
            return null;
          }
          return Math.round((workingSetSize / 1024) * 10) / 10;
        },
        runtimeKind
      );
    } catch (error) {
      if (!isDisposedElectronEvaluateError(error)) {
        throw error;
      }
      lastDisposedError = error;
      await page.waitForTimeout(250);
    }
  }

  throw new Error(
    `Timed out waiting for ${runtimeKind} working-set measurement after navigation churn: ${
      lastDisposedError?.message ?? 'unknown disposed execution context error'
    }`
  );
}

export async function waitForTrackedRuntimeWorkingSetMB(
  app: ElectronApplication,
  page: Page,
  runtimeKind: RuntimeProcessSnapshot['runtimeKind'],
  timeoutMs = 30_000
): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const workingSetMB = await readTrackedRuntimeWorkingSetMB(app, page, runtimeKind);
    if (typeof workingSetMB === 'number') {
      return workingSetMB;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${runtimeKind} working-set measurement`);
}

export async function readElectronAppMetricsWithRetry(
  app: ElectronApplication,
  page: Page,
  timeoutMs = 15_000
): Promise<AppMetricSample[]> {
  const startedAt = Date.now();
  let lastDisposedError: Error | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await app.evaluate(({ app: electronApp }) =>
        electronApp.getAppMetrics().map((metric) => ({
          memoryKB: metric.memory?.workingSetSize ?? 0,
          name: metric.name ?? '',
          pid: metric.pid,
          type: metric.type,
        }))
      );
    } catch (error) {
      if (!isDisposedElectronEvaluateError(error)) {
        throw error;
      }
      lastDisposedError = error;
      await page.waitForTimeout(250);
    }
  }

  throw new Error(
    `Timed out waiting for Electron app metrics after navigation churn: ${
      lastDisposedError?.message ?? 'unknown disposed execution context error'
    }`
  );
}

export async function readAppMetricSample(
  app: ElectronApplication,
  page: Page
): Promise<AppMetricSample[]> {
  return await readElectronAppMetricsWithRetry(app, page);
}

export function getGpuWorkingSetKB(metrics: readonly AppMetricSample[]): number {
  return metrics.find((metric) => metric.type === 'GPU')?.memoryKB ?? 0;
}

export function getTotalWorkingSetKB(metrics: readonly AppMetricSample[]): number {
  return metrics.reduce((sum, metric) => sum + metric.memoryKB, 0);
}

export function scoreGpuWorkingSetSamples(
  samples: readonly AppMetricSample[][]
): GpuWorkingSetScore {
  if (samples.length === 0) {
    throw new Error('GPU working-set scoring requires at least one sample.');
  }

  const withTotals = samples.map((sample) => ({
    gpuKB: getGpuWorkingSetKB(sample),
    sample,
    totalKB: getTotalWorkingSetKB(sample),
  }));
  const gpuValues = withTotals.map((entry) => entry.gpuKB).sort((left, right) => left - right);
  const totalValues = withTotals.map((entry) => entry.totalKB).sort((left, right) => left - right);
  const minEntry = withTotals.reduce((best, candidate) =>
    candidate.gpuKB < best.gpuKB ? candidate : best
  );
  const medianIndex = Math.floor(withTotals.length / 2);

  return {
    maxGpuKB: gpuValues.at(-1) ?? 0,
    maxTotalKB: totalValues.at(-1) ?? 0,
    medianGpuKB: gpuValues[medianIndex] ?? 0,
    medianTotalKB: totalValues[medianIndex] ?? 0,
    minGpuKB: gpuValues[0] ?? 0,
    minSample: minEntry.sample,
    minTotalKB: totalValues[0] ?? 0,
  };
}

export async function collectPostTargetMemorySamples(
  app: ElectronApplication,
  page: Page,
  sampleCount: number,
  delayMs: number
): Promise<PostTargetMemorySample[]> {
  const samples: PostTargetMemorySample[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    await page.waitForTimeout(delayMs);
    const [appMetrics, hostWorkingSetMB] = await Promise.all([
      readElectronAppMetricsWithRetry(app, page),
      readTrackedRuntimeWorkingSetMB(app, page, 'embedding-host'),
    ]);
    if (typeof hostWorkingSetMB !== 'number') {
      throw new Error('Missing embedding-host working-set measurement during sampling');
    }
    samples.push({
      appMetrics,
      hostWorkingSetMB,
    });
  }
  return samples;
}

export async function readCombinedMemorySnapshot(
  electronApp: ElectronApplication,
  activeWindow: Page,
  hostPage: Page,
  label: string
): Promise<CombinedMemorySnapshot> {
  const [visibleHeap, hostHeap, process, visibleWorkingSetMB, hostWorkingSetMB] = await Promise.all(
    [
      readRendererHeapSnapshot(activeWindow, `${label}-visible`),
      readRendererHeapSnapshot(hostPage, `${label}-host`),
      readDesktopProcessSnapshot(electronApp),
      waitForTrackedRuntimeWorkingSetMB(electronApp, activeWindow, 'visible-ui'),
      waitForTrackedRuntimeWorkingSetMB(electronApp, activeWindow, 'embedding-host'),
    ]
  );

  return {
    hostHeap,
    label,
    process: {
      ...process,
      runtimes: process.runtimes.map((runtime) => {
        if (runtime.runtimeKind === 'visible-ui') {
          return { ...runtime, workingSetMB: visibleWorkingSetMB };
        }
        if (runtime.runtimeKind === 'embedding-host') {
          return { ...runtime, workingSetMB: hostWorkingSetMB };
        }
        return runtime;
      }),
    },
    visibleHeap,
  };
}

export async function sampleMemoryWhileBackfillActive(
  electronApp: ElectronApplication,
  activeWindow: Page,
  sampleCount = LARGE_BACKFILL_SAMPLE_COUNT,
  intervalMs = LARGE_BACKFILL_SAMPLE_INTERVAL_MS
): Promise<MemorySample[]> {
  const startedAt = Date.now();
  const samples: MemorySample[] = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const hostPage = await getEmbeddingHostPage(activeWindow);
    const [snapshot, queueStats] = await Promise.all([
      readCombinedMemorySnapshot(electronApp, activeWindow, hostPage, `active-sample-${index + 1}`),
      getEmbeddingQueueStats(activeWindow),
    ]);

    samples.push({
      elapsedMs: Date.now() - startedAt,
      queueStats,
      snapshot,
    });

    if (index < sampleCount - 1) {
      await activeWindow.waitForTimeout(intervalMs);
    }
  }

  return samples;
}

export async function createTestBackfillJob(page: Page): Promise<{
  chunkId: string;
  embeddingSetId: string;
  jobId: string;
}> {
  return await page.evaluate<{ chunkId: string; embeddingSetId: string; jobId: string }>(
    async () => {
      const desktopWindow = window as Window & {
        embeddingHost?: {
          ensureStarted?: () => Promise<EmbeddingHostStatus>;
        };
        electronAPI?: {
          db?: {
            query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
          };
        };
      };

      if (!desktopWindow.embeddingHost?.ensureStarted) {
        throw new Error('Embedding host bridge is not available');
      }

      await desktopWindow.embeddingHost.ensureStarted();

      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }

      const now = new Date().toISOString();
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const fileRecordId = `test-file-${randomSuffix}`;
      const chunkId = `test-chunk-${randomSuffix}`;
      const embeddingSetId = `test-set-${randomSuffix}`;
      const jobId = `test-job-${randomSuffix}`;
      const modelId = 'Xenova/all-MiniLM-L6-v2';
      const modelKey = `local::${modelId}`;
      const expectedDimension = 384;
      const contentHash = `chunk-hash-${randomSuffix}`;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${contentHash}:${modelKey}`)
      );
      const embeddingInputHash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');

      await api.db.query(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [embeddingSetId, modelKey, modelId, expectedDimension, 'cosine', now]
      );

      await api.db.query(
        `INSERT INTO file_records (id, path, name, size, content, content_hash, token_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          fileRecordId,
          `/test/${fileRecordId}.txt`,
          `${fileRecordId}.txt`,
          100,
          'Test content for embedding host validation',
          `hash-${randomSuffix}`,
          16,
          now,
        ]
      );

      await api.db.query(
        `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, $8, $8)`,
        [
          chunkId,
          fileRecordId,
          0,
          'Test content for embedding host validation',
          contentHash,
          16,
          16,
          now,
        ]
      );

      await api.db.query(
        `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 3, 0, $3, $3)`,
        [
          jobId,
          JSON.stringify({
            chunkId,
            embeddingInputHash,
            embeddingSetId,
            expectedDimension,
            modelKey,
            sourceContentHash: contentHash,
          }),
          now,
        ]
      );

      return { chunkId, embeddingSetId, jobId };
    }
  );
}

export async function createInvalidJob(page: Page): Promise<string> {
  return await page.evaluate<string>(async () => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Database API not available');
    }

    const now = new Date().toISOString();
    const jobId = `invalid-job-${Math.random().toString(36).slice(2, 10)}`;
    await api.db.query(
      `INSERT INTO job_queue (id, queue, job_type, payload, state, run_at, attempts, max_attempts, backoff_ms, created_at, updated_at)
       VALUES ($1, 'embeddings', 'embed_chunk', $2, 'queued', $3, 0, 1, 0, $3, $3)`,
      [jobId, JSON.stringify({ chunkId: 'missing-canonical-fields' }), now]
    );
    return jobId;
  });
}

export async function clearEmbeddingQueue(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Database API not available');
    }

    await api.db.query(`DELETE FROM job_queue WHERE queue = 'embeddings'`);
  });
}

export async function createLargeBackfillFixture(
  page: Page,
  chunkCount: number,
  options?: { persistActiveSet?: boolean }
): Promise<{ embeddingSetId: string }> {
  return await page.evaluate<
    { embeddingSetId: string },
    { chunkCount: number; persistActiveSet: boolean }
  >(
    async ({ chunkCount: count, persistActiveSet }) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
            };
            storage?: {
              setItem?: (key: string, value: string) => Promise<void>;
            };
          };
        }
      ).electronAPI;

      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }
      if (!api?.storage?.setItem) {
        throw new Error('Storage API not available');
      }

      const now = new Date().toISOString();
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const embeddingSetId = `large-set-${randomSuffix}`;
      const fileRecordId = `large-file-${randomSuffix}`;
      const modelId = 'Xenova/all-MiniLM-L6-v2';
      const modelKey = `local::${modelId}`;

      await api.db.query(
        `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [embeddingSetId, modelKey, modelId, 384, 'cosine', 'Large Backfill', now]
      );

      await api.db.query(
        `INSERT INTO file_records (
         id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          fileRecordId,
          `/test/${fileRecordId}.txt`,
          `${fileRecordId}.txt`,
          count * 32,
          'Large backfill file',
          `file-hash-${randomSuffix}`,
          count * 8,
          embeddingSetId,
          now,
        ]
      );

      for (let index = 0; index < count; index += 1) {
        await api.db.query(
          `INSERT INTO file_chunks (
           id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, $8, $8)`,
          [
            `${fileRecordId}-chunk-${index}`,
            fileRecordId,
            index,
            `Chunk ${index} content for backfill responsiveness`,
            `chunk-hash-${randomSuffix}-${index}`,
            8,
            8,
            now,
          ]
        );
      }

      if (persistActiveSet) {
        await api.storage.setItem(
          'vector-status-ui.v1',
          JSON.stringify({
            state: { activeEmbeddingSetId: embeddingSetId },
            version: 1,
          })
        );
      }

      return { embeddingSetId };
    },
    { chunkCount, persistActiveSet: options?.persistActiveSet ?? true }
  );
}

export async function createLargeBackfillCorpusFixture(
  page: Page,
  options: {
    chunkContentBytes?: number;
    chunksPerFile: number;
    fileContentBytes?: number;
    fileCount: number;
    persistActiveSet?: boolean;
  }
): Promise<BackfillCorpusFixture> {
  return await page.evaluate<
    BackfillCorpusFixture,
    {
      chunkContentBytes: number;
      chunksPerFile: number;
      fileContentBytes: number;
      fileCount: number;
      persistActiveSet: boolean;
    }
  >(
    async ({ chunkContentBytes, chunksPerFile, fileContentBytes, fileCount, persistActiveSet }) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              exec?: (sql: string) => Promise<unknown>;
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
            };
            storage?: {
              setItem?: (key: string, value: string) => Promise<void>;
            };
          };
        }
      ).electronAPI;

      if (!(api?.db?.query && api.db.exec)) {
        throw new Error('Database API not available');
      }
      if (!api?.storage?.setItem) {
        throw new Error('Storage API not available');
      }
      const dbApi = api.db;
      const exec = dbApi.exec;
      const query = dbApi.query;
      if (typeof exec !== 'function' || typeof query !== 'function') {
        throw new Error('Database API not available');
      }

      const now = new Date().toISOString();
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const embeddingSetId = `corpus-set-${randomSuffix}`;
      const modelId = 'Xenova/all-MiniLM-L6-v2';
      const modelKey = `local::${modelId}`;
      const fileBatchSize = 100;
      const chunkBatchSize = 200;
      const fileContentTemplate = 'f'.repeat(fileContentBytes);
      const chunkContentTemplate = 'c'.repeat(chunkContentBytes);

      const insertFileBatch = async (offset: number, count: number): Promise<void> => {
        const values: string[] = [];
        const params: unknown[] = [];
        let nextParam = 1;

        for (let index = 0; index < count; index += 1) {
          const fileIndex = offset + index;
          const fileRecordId = `${embeddingSetId}-file-${fileIndex}`;
          values.push(
            `($${nextParam}, $${nextParam + 1}, $${nextParam + 2}, $${nextParam + 3}, $${nextParam + 4}, $${nextParam + 5}, $${nextParam + 6}, $${nextParam + 7}, $${nextParam + 8}, $${nextParam + 8})`
          );
          params.push(
            fileRecordId,
            `/corpus/${embeddingSetId}/file-${fileIndex}.ts`,
            `file-${fileIndex}.ts`,
            chunksPerFile * 128,
            `${fileContentTemplate}\nexport const corpusFile${fileIndex} = "${embeddingSetId}-${fileIndex}";`,
            `file-hash-${embeddingSetId}-${fileIndex}`,
            chunksPerFile * 32,
            embeddingSetId,
            now
          );
          nextParam += 9;
        }

        await query(
          `INSERT INTO file_records (
             id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at
           )
           VALUES ${values.join(', ')}`,
          params
        );
      };

      const insertChunkBatch = async (
        rows: Array<{ chunkIndex: number; content: string; fileRecordId: string; id: string }>
      ): Promise<void> => {
        const values: string[] = [];
        const params: unknown[] = [];
        let nextParam = 1;

        for (const row of rows) {
          values.push(
            `($${nextParam}, $${nextParam + 1}, $${nextParam + 2}, $${nextParam + 3}, $${nextParam + 4}, $${nextParam + 5}, 'text', $${nextParam + 6}, $${nextParam + 7}, $${nextParam + 7})`
          );
          params.push(
            row.id,
            row.fileRecordId,
            row.chunkIndex,
            `${chunkContentTemplate}\n${row.content}`,
            `chunk-hash-${row.id}`,
            32,
            32,
            now
          );
          nextParam += 8;
        }

        await query(
          `INSERT INTO file_chunks (
             id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at
           )
           VALUES ${values.join(', ')}`,
          params
        );
      };

      await exec('BEGIN');
      try {
        await query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [embeddingSetId, modelKey, modelId, 384, 'cosine', 'Large Backfill Corpus', now]
        );

        for (let offset = 0; offset < fileCount; offset += fileBatchSize) {
          await insertFileBatch(offset, Math.min(fileBatchSize, fileCount - offset));
        }

        let chunkRows: Array<{
          chunkIndex: number;
          content: string;
          fileRecordId: string;
          id: string;
        }> = [];

        for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
          const fileRecordId = `${embeddingSetId}-file-${fileIndex}`;
          for (let chunkIndex = 0; chunkIndex < chunksPerFile; chunkIndex += 1) {
            chunkRows.push({
              chunkIndex,
              content: [
                `export const fileIndex = ${fileIndex};`,
                `export const chunkIndex = ${chunkIndex};`,
                `export const corpusId = "${embeddingSetId}";`,
                'export const note = "backfill-memory-regression";',
              ].join('\n'),
              fileRecordId,
              id: `${fileRecordId}-chunk-${chunkIndex}`,
            });

            if (chunkRows.length === chunkBatchSize) {
              await insertChunkBatch(chunkRows);
              chunkRows = [];
            }
          }
        }

        if (chunkRows.length > 0) {
          await insertChunkBatch(chunkRows);
        }

        await exec('COMMIT');
      } catch (error) {
        await exec('ROLLBACK');
        throw error;
      }

      if (persistActiveSet) {
        await api.storage.setItem(
          'vector-status-ui.v1',
          JSON.stringify({
            state: { activeEmbeddingSetId: embeddingSetId },
            version: 1,
          })
        );
      }

      return {
        embeddingSetId,
        fileCount,
        totalChunks: fileCount * chunksPerFile,
      };
    },
    {
      chunkContentBytes: options.chunkContentBytes ?? 0,
      chunksPerFile: options.chunksPerFile,
      fileContentBytes: options.fileContentBytes ?? 0,
      fileCount: options.fileCount,
      persistActiveSet: options.persistActiveSet ?? true,
    }
  );
}

export async function createLargeCollectionListFixture(
  page: Page,
  options: {
    fileCount: number;
    fileContentBytes?: number;
    persistActiveSet?: boolean;
  }
): Promise<LargeCollectionListFixture> {
  return await page.evaluate<
    LargeCollectionListFixture,
    {
      fileContentBytes: number;
      fileCount: number;
      persistActiveSet: boolean;
    }
  >(
    async ({ fileContentBytes, fileCount, persistActiveSet }) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              exec?: (sql: string) => Promise<unknown>;
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
            };
            storage?: {
              setItem?: (key: string, value: string) => Promise<void>;
            };
          };
        }
      ).electronAPI;

      if (!(api?.db?.query && api.db.exec)) {
        throw new Error('Database API not available');
      }
      if (!api?.storage?.setItem) {
        throw new Error('Storage API not available');
      }

      const now = new Date().toISOString();
      const randomSuffix = Math.random().toString(36).slice(2, 10);
      const embeddingSetId = `list-set-${randomSuffix}`;
      const modelId = 'Xenova/all-MiniLM-L6-v2';
      const modelKey = `local::${modelId}`;
      const fileBatchSize = 250;
      const fileContentTemplate = 'l'.repeat(fileContentBytes);
      const dbApi = api.db;
      const exec = dbApi.exec;
      const query = dbApi.query;
      if (typeof exec !== 'function' || typeof query !== 'function') {
        throw new Error('Database API not available');
      }

      const insertFileBatch = async (offset: number, count: number): Promise<void> => {
        const values: string[] = [];
        const params: unknown[] = [];
        let nextParam = 1;

        for (let index = 0; index < count; index += 1) {
          const fileIndex = offset + index;
          const fileRecordId = `${embeddingSetId}-file-${String(fileIndex).padStart(5, '0')}`;
          values.push(
            `($${nextParam}, $${nextParam + 1}, $${nextParam + 2}, $${nextParam + 3}, $${nextParam + 4}, $${nextParam + 5}, $${nextParam + 6}, $${nextParam + 7}, $${nextParam + 7}, 0, 0)`
          );
          params.push(
            fileRecordId,
            `/list/${embeddingSetId}/file-${String(fileIndex).padStart(5, '0')}.ts`,
            `file-${String(fileIndex).padStart(5, '0')}.ts`,
            64,
            `${fileContentTemplate}\nexport const fileIndex = ${fileIndex};`,
            `file-hash-${embeddingSetId}-${fileIndex}`,
            embeddingSetId,
            now
          );
          nextParam += 8;
        }

        await query(
          `INSERT INTO file_records (
             id, path, name, size, content, content_hash, embedding_set_id, created_at, updated_at, chunks_count, token_count
           )
           VALUES ${values.join(', ')}`,
          params
        );
      };

      await exec('BEGIN');
      try {
        await query(
          `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [embeddingSetId, modelKey, modelId, 384, 'cosine', 'Large Collection List', now]
        );

        for (let offset = 0; offset < fileCount; offset += fileBatchSize) {
          await insertFileBatch(offset, Math.min(fileBatchSize, fileCount - offset));
        }

        await exec('COMMIT');
      } catch (error) {
        await exec('ROLLBACK');
        throw error;
      }

      if (persistActiveSet) {
        await api.storage.setItem(
          'vector-status-ui.v1',
          JSON.stringify({
            state: { activeEmbeddingSetId: embeddingSetId },
            version: 1,
          })
        );
      }

      return {
        embeddingSetId,
        fileCount,
      };
    },
    {
      fileContentBytes: options.fileContentBytes ?? 0,
      fileCount: options.fileCount,
      persistActiveSet: options.persistActiveSet ?? true,
    }
  );
}

export async function createCollectionViaDialog(page: Page, collectionName: string): Promise<void> {
  const databasePanel = page.getByTestId('database-demo-panel');
  await databasePanel.getByRole('button', { name: 'New' }).click({ timeout: 15_000 });

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Create Search Collection')).toBeVisible({ timeout: 15_000 });

  const nameInput = dialog.getByLabel('Name *');
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  await nameInput.fill(collectionName);

  const createButton = dialog.getByRole('button', { name: 'Create Collection' });
  await expect(createButton).toBeEnabled({ timeout: 15_000 });
  await createButton.click({ timeout: 15_000 });

  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

export async function getJobStatus(page: Page, jobId: string): Promise<string | null> {
  return await page.evaluate<string | null, string>(async (id) => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              params?: unknown[],
              options?: { label?: string; priority?: 'background' | 'foreground' | 'normal' }
            ) => Promise<{ rows: { state: string }[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Database API not available');
    }
    const result = (await api.db.query('SELECT state FROM job_queue WHERE id = $1', [id], {
      label: 'e2e-get-embedding-job-status',
      priority: 'background',
    })) as { rows: Array<{ state?: string }> };
    return result.rows[0]?.state ?? null;
  }, jobId);
}

export async function getEmbeddingQueueStats(page: Page): Promise<QueueStatsRow> {
  return await page.evaluate<QueueStatsRow>(async () => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              params?: unknown[],
              options?: { label?: string; priority?: 'background' | 'foreground' | 'normal' }
            ) => Promise<{ rows: QueueStatsRow[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Database API not available');
    }
    const result = await api.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
         COUNT(*) FILTER (WHERE state = 'running')::int AS running,
         COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded
       FROM job_queue
       WHERE queue = 'embeddings'`,
      [],
      { label: 'e2e-get-embedding-queue-stats', priority: 'background' }
    );
    const row = result.rows[0] as QueueStatsRow | undefined;
    if (!row) {
      throw new Error('Queue stats query returned no rows');
    }
    return row;
  });
}

export async function getImportedPathCounts(
  page: Page,
  rootPathPrefix: string
): Promise<ImportedPathCounts> {
  return await page.evaluate<ImportedPathCounts, string>(async (pathPrefix) => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              params?: unknown[]
            ) => Promise<{
              rows: Array<{
                fileCount?: number | string | null;
                totalChunks?: number | string | null;
              }>;
            }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Database API not available');
    }
    const result = await api.db.query(
      `SELECT
         COUNT(DISTINCT fr.id)::int AS "fileCount",
         COUNT(fc.id)::int AS "totalChunks"
       FROM file_records fr
       LEFT JOIN file_chunks fc ON fc.file_record_id = fr.id
       WHERE fr.path LIKE $1`,
      [`${pathPrefix}/%`]
    );
    const row = (result.rows[0] ?? {}) as {
      fileCount?: number | string;
      totalChunks?: number | string;
    };
    return {
      fileCount: Number(row.fileCount ?? 0),
      totalChunks: Number(row.totalChunks ?? 0),
    };
  }, rootPathPrefix);
}

export async function getEmbeddingSetQueueStats(
  page: Page,
  embeddingSetId: string
): Promise<QueueStatsRow> {
  return await page.evaluate<QueueStatsRow, string>(async (id) => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              params?: unknown[],
              options?: { label?: string; priority?: 'background' | 'foreground' | 'normal' }
            ) => Promise<{ rows: QueueStatsRow[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Database API not available');
    }
    const result = await api.db.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
         COUNT(*) FILTER (WHERE state = 'running')::int AS running,
         COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
         COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded
       FROM job_queue
       WHERE queue = 'embeddings'
         AND job_type = 'embed_chunk'
         AND embedding_set_id = $1`,
      [id],
      { label: 'e2e-get-embedding-set-queue-stats', priority: 'background' }
    );
    const row = result.rows[0] as QueueStatsRow | undefined;
    if (!row) {
      throw new Error('Embedding-set queue stats query returned no rows');
    }
    return row;
  }, embeddingSetId);
}

export async function getEmbeddingSetCounts(
  page: Page,
  embeddingSetId: string
): Promise<EmbeddingSetCounts> {
  return await page.evaluate<EmbeddingSetCounts, string>(async (id) => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (
              sql: string,
              params?: unknown[]
            ) => Promise<{ rows: Record<string, number | string | null>[] }>;
          };
        };
      }
    ).electronAPI;
    if (!api?.db?.query) {
      throw new Error('Database API not available');
    }

    const result = await api.db.query(
      `SELECT
         COUNT(DISTINCT fr.id)::int AS "fileCount",
         COUNT(c.id)::int AS "totalChunks",
         COUNT(*) FILTER (WHERE c.embedding IS NOT NULL)::int AS "embeddedChunks"
       FROM file_records fr
       LEFT JOIN file_chunks c ON c.file_record_id = fr.id
       WHERE fr.embedding_set_id = $1`,
      [id]
    );
    const row = result.rows[0] as EmbeddingSetCountsRow | undefined;
    if (!row) {
      throw new Error('Embedding-set counts query returned no rows');
    }
    return {
      embeddedChunks: Number(row['embeddedChunks'] ?? 0),
      fileCount: Number(row['fileCount'] ?? 0),
      totalChunks: Number(row['totalChunks'] ?? 0),
    };
  }, embeddingSetId);
}

export interface CollectionSummaryCounts {
  embeddedChunks: number;
  fileCount: number;
  totalChunks: number;
}

export function parseCollectionSummaryCounts(summaryText: string): CollectionSummaryCounts {
  const normalized = summaryText.replace(/\s+/g, ' ').trim();
  const match = normalized.match(
    /(\d+)\s+files?.*?(\d+)\s+chunks?.*?(\d+)\s*\/\s*(\d+)\s+embedded/i
  );

  if (!match) {
    throw new Error(`Unable to parse collection summary counts from: ${summaryText}`);
  }

  return {
    embeddedChunks: Number(match[3]),
    fileCount: Number(match[1]),
    totalChunks: Number(match[2]),
  };
}

export async function getCollectionSummaryCounts(
  page: Page,
  collectionName: string
): Promise<CollectionSummaryCounts> {
  const option = page.getByRole('option').filter({ hasText: collectionName }).first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  const text = await option.innerText();
  return parseCollectionSummaryCounts(text);
}

export async function resolveCollectionIdByName(
  page: Page,
  collectionName: string
): Promise<string> {
  const option = page.getByRole('option').filter({ hasText: collectionName }).first();
  await expect(option).toBeVisible({ timeout: 15_000 });
  const optionId = await option.getAttribute('id');
  if (!optionId?.startsWith('collection-option-')) {
    throw new Error(`Collection option is missing the canonical id for ${collectionName}`);
  }
  return optionId.replace('collection-option-', '');
}

export async function createImportTargetCollection(
  page: Page,
  collectionName?: string
): Promise<{ collectionName: string; embeddingSetId: string }> {
  return await page.evaluate(async (name) => {
    const api = (
      window as Window & {
        electronAPI?: {
          db?: {
            query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
          };
          storage?: {
            setItem?: (key: string, value: string) => Promise<void>;
          };
        };
      }
    ).electronAPI;

    if (!api?.db?.query) {
      throw new Error('Database API not available');
    }
    if (!api?.storage?.setItem) {
      throw new Error('Storage API not available');
    }

    const now = new Date().toISOString();
    const randomSuffix = Math.random().toString(36).slice(2, 10);
    const embeddingSetId = `import-set-${randomSuffix}`;
    const modelId = 'Xenova/all-MiniLM-L6-v2';
    const modelKey = `local::${modelId}`;

    await api.db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [embeddingSetId, modelKey, modelId, 384, 'cosine', name ?? 'Import Backfill Test', now]
    );

    await api.storage.setItem(
      'vector-status-ui.v1',
      JSON.stringify({
        state: { activeEmbeddingSetId: embeddingSetId },
        version: 1,
      })
    );

    return { collectionName: name ?? 'Import Backfill Test', embeddingSetId };
  }, collectionName);
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

export async function waitForImportedChunks(page: Page, embeddingSetId: string): Promise<void> {
  await expect
    .poll(async () => await getEmbeddingSetCounts(page, embeddingSetId), {
      timeout: 30_000,
    })
    .toMatchObject({
      fileCount: 2,
      totalChunks: expect.any(Number),
    });

  const counts = await getEmbeddingSetCounts(page, embeddingSetId);
  expect(counts.totalChunks).toBeGreaterThan(0);
}

export async function createChunkedImportFixture(
  page: Page,
  embeddingSetId: string
): Promise<{ fileCount: number; totalChunks: number }> {
  return await page.evaluate<
    { fileCount: number; totalChunks: number },
    { embeddingSetId: string }
  >(
    async ({ embeddingSetId: id }) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (
                sql: string,
                params?: unknown[]
              ) => Promise<{ rows: Record<string, unknown>[] }>;
            };
          };
        }
      ).electronAPI;

      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }

      const now = new Date().toISOString();
      const files = [
        {
          chunks: [
            'This is a deterministic imported text fixture used to validate desktop chunking and immediate manual backfill.',
            'The second chunk ensures manual backfill sees multiple persisted chunks for the same imported file.',
          ],
          content:
            'This is a deterministic imported text fixture used to validate desktop chunking and immediate manual backfill.\nThe second chunk ensures manual backfill sees multiple persisted chunks for the same imported file.',
          id: `import-file-${crypto.randomUUID()}`,
          name: 'mock-file1.txt',
          path: '/mock/test/directory/mock-file1.txt',
          strategy: 'sentence',
        },
        {
          chunks: [
            'export function fixtureValue(): string { return "desktop import backfill regression"; }',
            'export const fixtureLines = ["alpha", "beta", "gamma", "delta"];',
          ],
          content:
            'export function fixtureValue(): string { return "desktop import backfill regression"; }\nexport const fixtureLines = ["alpha", "beta", "gamma", "delta"];',
          id: `import-file-${crypto.randomUUID()}`,
          name: 'mock-file2.ts',
          path: '/mock/test/directory/mock-file2.ts',
          strategy: 'recursive',
        },
      ] as const;

      let totalChunks = 0;

      for (const file of files) {
        await api.db.query(
          `INSERT INTO file_records (
           id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
          [
            file.id,
            file.path,
            file.name,
            file.content.length,
            file.content,
            `content-hash-${file.id}`,
            Math.max(1, Math.ceil(file.content.length / 8)),
            id,
            now,
          ]
        );

        for (const [chunkIndex, chunkContent] of file.chunks.entries()) {
          // Each fixture chunk is exactly one line of `file.content` (the chunks
          // are joined with '\n'), so the 1-based line span is the chunk index.
          // Line attribution is not decoration: the workspace-search semantic
          // executor DROPS any chunk missing start/end lines because it cannot
          // build a navigable range for it.
          const lineNumber = chunkIndex + 1;
          await api.db.query(
            `INSERT INTO file_chunks (
             id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, start_line, end_line, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
            [
              `${file.id}-chunk-${chunkIndex}`,
              file.id,
              chunkIndex,
              chunkContent,
              `chunk-hash-${file.id}-${chunkIndex}`,
              Math.max(1, Math.ceil(chunkContent.length / 8)),
              file.name.endsWith('.ts') ? 'code' : 'text',
              chunkContent.length,
              lineNumber,
              lineNumber,
              now,
            ]
          );
        }

        await api.db.query(
          `UPDATE file_records
            SET chunks_processed_at = $2,
                chunks_count = $3,
                chunking_strategy = $4,
                updated_at = $2
          WHERE id = $1`,
          [file.id, now, file.chunks.length, file.strategy]
        );

        totalChunks += file.chunks.length;
      }

      return { fileCount: files.length, totalChunks };
    },
    { embeddingSetId }
  );
}

export async function waitForEmbeddedCollectionSummary(
  page: Page,
  collectionName: string,
  timeoutMs = 90_000
): Promise<CollectionSummaryCounts> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const summary = await getCollectionSummaryCounts(page, collectionName);
    if (summary.totalChunks > 0 && summary.embeddedChunks === summary.totalChunks) {
      return summary;
    }
    await page.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for collection summary to reach full embedding coverage');
}

export async function waitForBackfillQueueMovementOrFatalError(
  page: Page,
  embeddingSetId: string,
  timeoutMs = 30_000
): Promise<'error' | 'queued'> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [status, queueStats] = await Promise.all([
      getEmbeddingHostStatus(page),
      getEmbeddingSetQueueStats(page, embeddingSetId),
    ]);

    if (status.state === 'error') {
      return 'error';
    }

    const totalObserved =
      queueStats.queued + queueStats.running + queueStats.failed + queueStats.succeeded;
    if (totalObserved > 0) {
      return 'queued';
    }

    await page.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for set-scoped backfill queue movement or fatal host error');
}

export async function waitForBackfillEnqueueComplete(
  page: Page,
  embeddingSetId: string,
  expectedJobs: number,
  timeoutMs = 30_000
): Promise<QueueStatsRow> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [status, queueStats] = await Promise.all([
      getEmbeddingHostStatus(page),
      getEmbeddingSetQueueStats(page, embeddingSetId),
    ]);

    if (status.state === 'error') {
      throw new Error(
        status.lastError ?? 'Embedding host entered an error state while waiting for enqueue.'
      );
    }

    const totalObserved =
      queueStats.queued + queueStats.running + queueStats.failed + queueStats.succeeded;
    if (totalObserved >= expectedJobs) {
      return queueStats;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for backfill enqueue to reach ${expectedJobs} jobs for set ${embeddingSetId}`
  );
}

export async function waitForJobTerminalState(
  page: Page,
  jobId: string,
  timeoutMs = 120_000
): Promise<'failed' | 'succeeded'> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = await getJobStatus(page, jobId);
    if (state === 'succeeded' || state === 'failed') {
      return state;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for terminal state for job ${jobId}`);
}

export async function ensureEmbeddingHostWarmed(page: Page): Promise<Page> {
  await clearEmbeddingQueue(page);
  const warmupJob = await createTestBackfillJob(page);
  const status = await waitForEmbeddingHostState(
    page,
    (candidate) => candidate.state === 'error' || candidate.state === 'running',
    60_000
  );

  if (status.state === 'error') {
    throw new Error(`Embedding host warmup failed: ${status.lastError ?? 'unknown error'}`);
  }

  const terminalState = await waitForJobTerminalState(page, warmupJob.jobId, 120_000);
  if (terminalState !== 'succeeded') {
    throw new Error(`Embedding host warmup job failed with state ${terminalState}`);
  }

  await clearEmbeddingQueue(page);
  const hostPage = await getEmbeddingHostPage(page);
  await hostPage.waitForTimeout(1000);
  await forceRendererGarbageCollection(page);
  await forceRendererGarbageCollection(hostPage);
  return hostPage;
}

export async function startBackfillViaBridge(page: Page, embeddingSetId: string): Promise<void> {
  await page.evaluate<void, string>(async (id) => {
    const host = (
      window as Window & {
        __e2eEmbeddingBackfillState?: {
          done: boolean;
          embeddingSetId: string;
          error: string | null;
        };
        embeddingHost?: {
          enqueueBackfill?: (embeddingSetId: string) => Promise<void>;
        };
      }
    ).embeddingHost;

    if (!host?.enqueueBackfill) {
      throw new Error('Embedding host enqueue bridge is not available');
    }

    const state = {
      done: false,
      embeddingSetId: id,
      error: null as string | null,
    };
    (
      window as Window & { __e2eEmbeddingBackfillState?: typeof state }
    ).__e2eEmbeddingBackfillState = state;

    void host.enqueueBackfill(id).then(
      () => {
        state.done = true;
      },
      (error: unknown) => {
        state.done = true;
        state.error = error instanceof Error ? error.message : String(error);
      }
    );
  }, embeddingSetId);
}

export async function waitForBridgeBackfillCompletion(
  page: Page,
  timeoutMs = 240_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = await page.evaluate(
      () =>
        (
          window as Window & {
            __e2eEmbeddingBackfillState?: {
              done: boolean;
              embeddingSetId: string;
              error: string | null;
            };
          }
        ).__e2eEmbeddingBackfillState ?? null
    );

    if (state?.done) {
      if (state.error) {
        throw new Error(state.error);
      }
      return;
    }

    await page.waitForTimeout(250);
  }

  throw new Error('Timed out waiting for bridge-driven backfill completion');
}

export async function waitForDatabaseDemoImportIdle(page: Page, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  let lastSnapshot: DatabaseDemoImportTestSnapshot | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastSnapshot = await getDatabaseDemoImportSnapshot(page);

    const importErrors = lastSnapshot?.progress?.errors ?? [];
    if (importErrors.length > 0) {
      throw new Error(
        `Database import reported errors while waiting for idle: ${JSON.stringify(importErrors.slice(0, 10))}\nsnapshot=${JSON.stringify(lastSnapshot)}`
      );
    }

    if (lastSnapshot && !lastSnapshot.isImporting) {
      return;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for database import to become idle; snapshot=${JSON.stringify(lastSnapshot)}`
  );
}

export async function getBridgeBackfillState(page: Page): Promise<{
  done: boolean;
  embeddingSetId: string;
  error: string | null;
} | null> {
  return await page.evaluate(
    () =>
      (
        window as Window & {
          __e2eEmbeddingBackfillState?: {
            done: boolean;
            embeddingSetId: string;
            error: string | null;
          };
        }
      ).__e2eEmbeddingBackfillState ?? null
  );
}

export async function getEmbeddingBackfillsInFlight(page: Page): Promise<EmbeddingBackfillInfo[]> {
  return await page.evaluate<EmbeddingBackfillInfo[]>(async () => {
    const host = (
      window as Window & {
        embeddingHost?: {
          getBackfillsInFlight?: () => Promise<EmbeddingBackfillInfo[]>;
        };
      }
    ).embeddingHost;
    if (!host?.getBackfillsInFlight) {
      throw new Error('Embedding host backfill diagnostics bridge is not available');
    }
    return await host.getBackfillsInFlight();
  });
}

export async function cancelAllEmbeddingBackfillsAndDrain(
  page: Page,
  timeoutMs = 60_000
): Promise<void> {
  await page.evaluate(async () => {
    const host = (
      window as Window & {
        embeddingHost?: {
          cancelAllBackfills?: () => Promise<void>;
        };
      }
    ).embeddingHost;
    if (!host?.cancelAllBackfills) {
      throw new Error('Embedding host cancel-all bridge is not available');
    }
    await host.cancelAllBackfills();
  });

  const startedAt = Date.now();
  let lastBridgeState: Awaited<ReturnType<typeof getBridgeBackfillState>> = null;
  let lastInFlight: EmbeddingBackfillInfo[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    [lastInFlight, lastBridgeState] = await Promise.all([
      getEmbeddingBackfillsInFlight(page),
      getBridgeBackfillState(page),
    ]);

    if (lastInFlight.length === 0 && (!lastBridgeState || lastBridgeState.done)) {
      if (
        lastBridgeState?.done &&
        lastBridgeState.error &&
        !lastBridgeState.error.includes(EMBEDDING_BACKFILL_CANCELED_MESSAGE)
      ) {
        throw new Error(lastBridgeState.error);
      }
      return;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for embedding backfills to cancel; inFlight=${JSON.stringify(lastInFlight)} bridgeState=${JSON.stringify(lastBridgeState)}`
  );
}

export async function settleEmbeddingBackfillsStopHostAndClearQueue(page: Page): Promise<void> {
  let cancelError: unknown = null;
  try {
    await cancelAllEmbeddingBackfillsAndDrain(page);
  } catch (error) {
    cancelError = error;
  }

  try {
    await stopEmbeddingHost(page);
  } finally {
    await clearEmbeddingQueue(page);
  }

  if (cancelError) {
    throw cancelError;
  }
}

export async function cleanupRealWorldMixedStateTest(
  electronApp: ElectronAppContext,
  page: Page
): Promise<void> {
  let importIdleError: unknown = null;

  try {
    await waitForDatabaseDemoImportIdle(page);
  } catch (error) {
    importIdleError = error;
  }

  try {
    await settleEmbeddingBackfillsStopHostAndClearQueue(page);
  } finally {
    try {
      await clearLargeImportFileSystemMock(electronApp.app);
    } finally {
      await stopChunkingHost(page);
    }
  }

  if (importIdleError) {
    throw importIdleError;
  }
}

export async function getRelevantElectronStderr(app: ElectronApplication): Promise<string[]> {
  const output = await getBufferedElectronOutputInTest(app);
  return output.stderr.filter(
    (line) =>
      line.includes('Embedding host stopped while backfill was in progress.') ||
      line.includes('Embedding backfill is already running for set') ||
      line.includes('Chunking host stopped while requests were in flight.') ||
      line.includes("Error occurred in handler for 'embedding-host:enqueue-backfill'") ||
      line.includes("Error occurred in handler for 'chunking-host:chunk-file'")
  );
}

export async function getRelevantElectronStderrSince(
  app: ElectronApplication,
  baselineCount: number
): Promise<string[]> {
  const lines = await getRelevantElectronStderr(app);
  return lines.slice(baselineCount);
}

export function countPlannedMaintenanceLogs(records: readonly MainBufferedLogRecord[]): number {
  return records.filter((record) =>
    (record.message ?? '').includes('Completed embedding host GPU reclaim maintenance')
  ).length;
}

export function detectObservedMaintenanceCycles(options: {
  finalRuntimeId: string;
  initialRuntimeId: string;
  logsSinceBaseline: readonly MainBufferedLogRecord[];
}): number {
  const logCount = countPlannedMaintenanceLogs(options.logsSinceBaseline);
  const runtimeRestartCycles = options.finalRuntimeId === options.initialRuntimeId ? 0 : 1;
  return Math.max(logCount, runtimeRestartCycles);
}

export async function assertCleanBackfillMeasurementScenario(
  activeWindow: Page,
  app: ElectronApplication,
  baselineLogCount: number,
  baselineStderrCount: number
): Promise<{
  mainLogs: MainBufferedLogRecord[];
  relevantElectronStderr: string[];
}> {
  const [mainLogs, relevantElectronStderr] = await Promise.all([
    getMainBufferedLogs(activeWindow),
    getRelevantElectronStderrSince(app, baselineStderrCount),
  ]);
  const scenarioLogs = mainLogs.slice(baselineLogCount);
  const unexpectedLifecycleLogs = extractUnexpectedLifecycleLogs(scenarioLogs);
  expect(unexpectedLifecycleLogs).toEqual([]);
  expect(relevantElectronStderr).toEqual([]);
  return { mainLogs, relevantElectronStderr };
}

export async function waitForReclaimCycleAndResumedProcessing(
  page: Page,
  initialRuntimeId: string,
  baselineLogCount: number,
  minimumSucceededItems: number,
  timeoutMs = 120_000
): Promise<{
  mainLogs: MainBufferedLogRecord[];
  queueStats: QueueStatsRow;
  status: EmbeddingHostStatus;
}> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const [queueStats, status, mainLogs] = await Promise.all([
      getEmbeddingQueueStats(page),
      getEmbeddingHostStatus(page),
      getMainBufferedLogs(page),
    ]);
    if (status.state === 'error') {
      throw new Error(
        status.lastError ??
          'Embedding host entered an error state while waiting for reclaim to resume work.'
      );
    }

    const observedMaintenanceCycles = detectObservedMaintenanceCycles({
      finalRuntimeId: status.runtimeId,
      initialRuntimeId,
      logsSinceBaseline: mainLogs.slice(baselineLogCount),
    });
    const resumedOnFreshRuntime =
      observedMaintenanceCycles > 0 &&
      status.runtimeId !== initialRuntimeId &&
      status.state === 'running' &&
      status.active &&
      queueStats.running > 0 &&
      queueStats.succeeded >= minimumSucceededItems;
    if (resumedOnFreshRuntime) {
      return {
        mainLogs,
        queueStats,
        status,
      };
    }

    await page.waitForTimeout(500);
  }

  throw new Error('Timed out waiting for reclaim maintenance to resume processing.');
}

export async function prepareRealWorldMixedStateScenario(
  electronApp: ElectronApplication,
  window: Page
): Promise<RealWorldMixedStateScenario> {
  let activeWindow = await showDatabaseDemoPanel(window);

  if (await isDatabaseError(activeWindow)) {
    await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
    throw new Error('Database initialization failed in desktop mixed-state setup');
  }

  await cancelAllEmbeddingBackfillsAndDrain(activeWindow);
  await stopEmbeddingHost(activeWindow);
  await clearEmbeddingQueue(activeWindow);
  await stopChunkingHost(activeWindow);
  await setVectorDevicePreference(activeWindow, 'wasm');
  await setImportSettingsForStressTest(activeWindow);
  await reloadRendererInTest(activeWindow, 'embedding-worker-real-world-mixed-state');
  activeWindow = await showDatabaseDemoPanel(activeWindow);

  await expect
    .poll(async () => await getEmbeddingHostStatus(activeWindow), {
      timeout: 15_000,
    })
    .toMatchObject({ state: 'stopped' });
  await expect
    .poll(async () => await getChunkingHostStatus(activeWindow), {
      timeout: 15_000,
    })
    .toMatchObject({ state: 'stopped' });

  await ensureFileExplorerPanelVisible(activeWindow);
  await installLargeImportFileSystemMock(electronApp, {
    fileCount: REAL_WORLD_MIXED_STATE_FILE_COUNT,
    rootPath: '/mock/real-world-import',
    sentencesPerFile: ACTUAL_IMPORT_SENTENCES_PER_FILE,
  });

  const searchableCollectionName = `Searchable Mixed State ${Date.now()}`;
  await createCollectionViaDialog(activeWindow, searchableCollectionName);
  const searchableEmbeddingSetId = await resolveCollectionIdByName(
    activeWindow,
    searchableCollectionName
  );
  const searchableFixture = await createChunkedImportFixture(
    activeWindow,
    searchableEmbeddingSetId
  );

  const searchableCollectionOption = activeWindow.locator(
    `#collection-option-${searchableEmbeddingSetId}`
  );
  await expect(searchableCollectionOption).toBeVisible({ timeout: 15_000 });
  await searchableCollectionOption.click({ timeout: 5000 });
  await waitForImportedChunks(activeWindow, searchableEmbeddingSetId);

  const searchableBackfillButton = activeWindow
    .locator('[data-testid="database-demo-panel"]')
    .getByRole('button', { name: /^Backfill(?:\s|$)/ });
  await expect(searchableBackfillButton).toBeVisible({ timeout: 15_000 });
  await waitForBackfillButtonEnabled(activeWindow, searchableBackfillButton);
  await searchableBackfillButton.click({ timeout: 5000 });

  const searchableBackfillOutcome = await waitForBackfillQueueMovementOrFatalError(
    activeWindow,
    searchableEmbeddingSetId
  );
  if (searchableBackfillOutcome === 'error') {
    const status = await getEmbeddingHostStatus(activeWindow);
    throw new Error(
      `Searchable mixed-state setup failed during seed backfill: ${status.lastError ?? 'unknown host error'}`
    );
  }

  await waitForEmbeddedCollectionSummary(activeWindow, searchableCollectionName);
  await expect
    .poll(async () => await getEmbeddingSetCounts(activeWindow, searchableEmbeddingSetId), {
      timeout: 120_000,
    })
    .toMatchObject({
      embeddedChunks: searchableFixture.totalChunks,
      fileCount: searchableFixture.fileCount,
      totalChunks: searchableFixture.totalChunks,
    });

  const importCollectionName = `Mixed State Import ${Date.now()}`;
  await createCollectionViaDialog(activeWindow, importCollectionName);
  const importEmbeddingSetId = await resolveCollectionIdByName(activeWindow, importCollectionName);

  const initialTimeOrigin = await getRendererTimeOrigin(activeWindow);
  const selectRootButton = activeWindow.getByTestId('select-root-button');
  await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
  await selectRootButton.click({ timeout: 5000 });
  await setFileExplorerMaxSelectionCount(activeWindow, REAL_WORLD_MIXED_STATE_FILE_COUNT);

  await expect
    .poll(async () => await getMainProcessFileSystemFixtureSummary(electronApp), {
      timeout: 30_000,
    })
    .toMatchObject({
      fileCount: REAL_WORLD_MIXED_STATE_FILE_COUNT,
      requestDirectoryAccessCount: 1,
      rootHandlePath: '/mock/real-world-import',
    });

  const selectAllButton = activeWindow.getByRole('button', { name: /^Select All$/i }).first();
  await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
  await selectAllButton.click({ timeout: 5000 });

  await expect(activeWindow.getByTestId('selection-count')).toHaveText(
    new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 1,
      notation: 'compact',
    }).format(REAL_WORLD_MIXED_STATE_FILE_COUNT),
    {
      timeout: 60_000,
    }
  );

  await importSelectedFilesFromExplorer(activeWindow, {
    expectedSelectedCount: REAL_WORLD_MIXED_STATE_FILE_COUNT,
    timeout: 30_000,
  });

  let sawChunkingHostActive = false;
  let importImportedPathCounts: ImportedPathCounts | null = null;
  const importStartedAt = Date.now();
  while (Date.now() - importStartedAt < 240_000) {
    const [pathCounts, timeOrigin, chunkingStatus, importSnapshot, rendererLogs] =
      await Promise.all([
        getImportedPathCounts(activeWindow, '/mock/real-world-import'),
        getRendererTimeOrigin(activeWindow),
        getChunkingHostStatus(activeWindow),
        getDatabaseDemoImportSnapshot(activeWindow),
        getRendererLogRecords(activeWindow),
      ]);

    expect(timeOrigin).toBe(initialTimeOrigin);

    if (chunkingStatus.state !== 'stopped') {
      sawChunkingHostActive = true;
    }

    const catastrophicImportLog = rendererLogs.find((record) =>
      recordContainsText(record, 'Enhanced import failed catastrophically')
    );
    const importErrors = importSnapshot?.progress?.errors ?? [];

    if (importErrors.length > 0) {
      throw new Error(
        `Mixed-state import reported progress errors: ${JSON.stringify(importErrors.slice(0, 10))}\nimportSnapshot=${JSON.stringify(importSnapshot)}`
      );
    }

    if (catastrophicImportLog) {
      const errorMessage =
        extractStructuredLogString(catastrophicImportLog, 'error') ??
        catastrophicImportLog.message ??
        'unknown enhanced import failure';
      const errorStack = extractStructuredLogString(catastrophicImportLog, 'stack');
      throw new Error(
        `Mixed-state import failed during chunking/token sizing: ${errorMessage}${errorStack ? `\n${errorStack}` : ''}`
      );
    }

    if (pathCounts.fileCount === REAL_WORLD_MIXED_STATE_FILE_COUNT && pathCounts.totalChunks > 0) {
      importImportedPathCounts = pathCounts;
      break;
    }

    await activeWindow.waitForTimeout(1000);
  }

  if (!importImportedPathCounts) {
    const [fixtureSummary, fileExplorerSnapshot, importSnapshot] = await Promise.all([
      getMainProcessFileSystemFixtureSummary(electronApp),
      getFileExplorerTestSnapshot(activeWindow),
      getDatabaseDemoImportSnapshot(activeWindow),
    ]);
    throw new Error(
      `Timed out waiting for mixed-state import to persist files and chunks\nfixture=${JSON.stringify(fixtureSummary)}\nfileExplorer=${JSON.stringify(fileExplorerSnapshot)}\nimportSnapshot=${JSON.stringify(importSnapshot)}`
    );
  }

  expect(sawChunkingHostActive).toBe(true);
  expect(importImportedPathCounts.fileCount).toBe(REAL_WORLD_MIXED_STATE_FILE_COUNT);
  expect(importImportedPathCounts.totalChunks).toBeGreaterThan(0);

  await expect
    .poll(async () => await getEmbeddingSetCounts(activeWindow, importEmbeddingSetId), {
      timeout: 30_000,
    })
    .toMatchObject({
      embeddedChunks: 0,
      fileCount: REAL_WORLD_MIXED_STATE_FILE_COUNT,
      totalChunks: expect.any(Number),
    });

  await waitForDatabaseDemoImportIdle(activeWindow);

  const backgroundFixture = await createLargeBackfillCorpusFixture(activeWindow, {
    chunksPerFile: REAL_WORLD_BACKGROUND_CHUNKS_PER_FILE,
    fileCount: REAL_WORLD_BACKGROUND_FILE_COUNT,
    persistActiveSet: false,
  });

  await startBackfillViaBridge(activeWindow, backgroundFixture.embeddingSetId);

  const backgroundOutcome = await waitForBackfillQueueMovementOrFatalError(
    activeWindow,
    backgroundFixture.embeddingSetId,
    120_000
  );
  expect(backgroundOutcome).toBe('queued');

  await expect
    .poll(
      async () => {
        const stats = await getEmbeddingQueueStats(activeWindow);
        return stats.queued + stats.running;
      },
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);

  const fileExplorerSnapshotBeforeChecks = await getFileExplorerTestSnapshot(activeWindow);
  const currentFolderId = fileExplorerSnapshotBeforeChecks?.currentFolderId;
  expect(typeof currentFolderId).toBe('string');
  expect(currentFolderId).toBeTruthy();
  expect(currentFolderId).not.toBe('/mock/real-world-import');
  expect(fileExplorerSnapshotBeforeChecks).toMatchObject({
    rootDirectoryPath: '/mock/real-world-import',
    selectedFilePathCount: REAL_WORLD_MIXED_STATE_FILE_COUNT,
  });
  expect(
    fileExplorerSnapshotBeforeChecks?.selectedFilePathSamples.every((key) =>
      key.startsWith(`${currentFolderId}|@|`)
    )
  ).toBe(true);

  // The searchable set is a synthetic fixture, so its file records carry no
  // root. Workspace search is root-scoped and excludes NULL-root rows, so
  // attribute them to the root the real import just mounted — otherwise every
  // search assertion below would be unfalsifiable.
  const searchableWorkspaceRootId = await attachCollectionFilesToWorkspaceRoot(
    activeWindow,
    searchableEmbeddingSetId
  );

  return {
    activeWindow,
    backgroundFixture,
    importCollectionName,
    importEmbeddingSetId,
    importImportedPathCounts,
    initialTimeOrigin,
    sawChunkingHostActive,
    searchableCollectionName,
    searchableEmbeddingSetId,
    searchableWorkspaceRootId,
  };
}

test.beforeAll(async ({ electron }) => {
  test.setTimeout(300_000);
  const { window: appWindow } = await electron.ensureContext();
  await waitForAppReadyInTest(appWindow);

  const dbStatus = await appWindow.evaluate(async () => {
    const api = (
      globalThis.window as Window & {
        electronAPI?: {
          db?: {
            clearAll?: (token?: string) => Promise<{ message?: string; success: boolean }>;
            test?: () => Promise<unknown>;
          };
        };
      }
    ).electronAPI;

    if (!api?.db?.test) {
      return { message: 'Database API not available', ok: false };
    }

    try {
      await api.db.test();
    } catch (error) {
      return { message: error instanceof Error ? error.message : String(error), ok: false };
    }

    if (!api.db.clearAll) {
      return { message: null, ok: true };
    }

    const result = await api.db.clearAll('CONFIRM_CLEAR_DATABASE');
    return { message: result.message ?? null, ok: result.success };
  });

  if (!dbStatus.ok) {
    console.warn('Database unavailable in test setup:', dbStatus.message);
  }
});

test.beforeEach(async ({ electron }) => {
  await electron.ensureWindow();
});

export const CRASH_REPRO_LARGE_FILE_COUNT = 1000;
export const CRASH_REPRO_LARGE_CHUNKS_PER_FILE = 20;
// Match the existing 20K test's sampling window (6 samples × 2.5s = 15s)
// to stay within the stable window. The ~60s crash point during extended
// backfills in test mode (--disable-gpu + --no-sandbox) is a separate
// Chromium test-environment limitation, not the production crash.
export const CRASH_REPRO_SAMPLE_COUNT = LARGE_BACKFILL_SAMPLE_COUNT;
export const CRASH_REPRO_SAMPLE_INTERVAL_MS = LARGE_BACKFILL_SAMPLE_INTERVAL_MS;
export const CRASH_REPRO_BACKGROUNDING_FILE_COUNT = 500;
export const CRASH_REPRO_BACKGROUNDING_CHUNKS_PER_FILE = 20;
export const CRASH_REPRO_IDLE_FILE_COUNT = 50;
export const CRASH_REPRO_IDLE_CHUNKS_PER_FILE = 20;
export const CRASH_REPRO_IPC_FILE_COUNT = 1000;
export const CRASH_REPRO_IPC_CHUNKS_PER_FILE = 20;
export const CRASH_REPRO_SUSPEND_FILE_COUNT = 50;
export const CRASH_REPRO_SUSPEND_CHUNKS_PER_FILE = 20;
export const CRASH_REPRO_IDLE_POLL_INTERVAL_MS = 30_000;
export const CRASH_REPRO_IDLE_POLL_COUNT = 10;
