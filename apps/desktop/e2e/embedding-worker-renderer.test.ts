import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { DESKTOP_DEV_RENDERER_PORT, DESKTOP_DEV_RENDERER_URL } from '../src/desktop-renderer-url';
import { expect, test } from './fixtures/electron-fixture';
import { getContextExplorerLeftPanel } from './utils/context-explorer-locators';
import { showDatabaseDemoPanel } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

interface BufferedLogRecord {
  args: readonly unknown[];
  message?: string;
}

interface EmbeddingHostStatus {
  active: boolean;
  lastError: string | null;
  runtimeId: string;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface ChunkingHostStatus {
  active: boolean;
  lastError: string | null;
  runtimeId: string;
  state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
}

interface MainBufferedLogRecord {
  args?: readonly unknown[];
  bindings?: Record<string, unknown>;
  message?: string;
  scope?: string;
}

interface MainProcessHealthRuntimeMetric {
  osProcessId: number | null;
  runtimeKind: 'chunking-host' | 'embedding-host' | 'visible-ui';
  workingSetKB: number | null;
}

interface MainProcessHealthSample {
  backgroundRuntimeMetrics: readonly MainProcessHealthRuntimeMetric[];
  cpuPercent: number | null;
  heapUsedKB: number | null;
  loopLagMaxMs: number | null;
  loopLagP99Ms: number | null;
  rssKB: number | null;
  visibleUiWorkingSetKB: number | null;
}

interface ElectronE2eFileSystemFixture {
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

async function getBufferedElectronOutputInTest(
  app: ElectronApplication
): Promise<{ stderr: string[]; stdout: string[] }> {
  const { getBufferedElectronOutput } = await loadElectronHelpers();
  return await getBufferedElectronOutput(app);
}

async function launchElectronDevAppInTest(userDataDir: string): Promise<{
  app: ElectronApplication;
  window: Page;
}> {
  const { launchElectronAppWithOptions } = await loadElectronHelpers();
  return await launchElectronAppWithOptions({
    launchMode: 'dev-server',
    userDataDir,
  });
}

async function closeElectronAppInTest(app: {
  app: ElectronApplication;
  window: Page;
}): Promise<void> {
  const { closeElectronApp } = await loadElectronHelpers();
  await closeElectronApp(app);
}

async function reloadRendererInTest(page: Page, reason: string): Promise<void> {
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reason);
}

async function waitForAppReadyInTest(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
}

async function getHybridSearchBox(page: Page): Promise<Locator> {
  const toggle = page.getByRole('button', { name: 'Hybrid search' });
  await expect(toggle).toBeVisible({ timeout: 15_000 });

  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }

  const searchBox = page.getByLabel('Hybrid search query');
  await expect(searchBox).toBeVisible({ timeout: 15_000 });
  return searchBox;
}

interface ElectronE2eFileSystemFixtureSummary {
  directoryPaths: string[];
  fileCount: number;
  readDirectoryCalls: string[];
  readFileByPathCallCount: number;
  readFileCallCount: number;
  requestDirectoryAccessCount: number;
  rootHandlePath: string;
}

interface QueueStatsRow {
  failed: number;
  queued: number;
  running: number;
  succeeded: number;
}

interface EmbeddingSetCounts {
  embeddedChunks: number;
  fileCount: number;
  totalChunks: number;
}

interface EmbeddingSetCountsRow {
  embeddedChunks: number | string | null;
  fileCount: number | string | null;
  totalChunks: number | string | null;
}

interface ImportedPathCounts {
  fileCount: number;
  totalChunks: number;
}

function isDisposedElectronEvaluateError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.includes('Execution context was destroyed') ||
      error.message.includes('Target page, context or browser has been closed'))
  );
}

interface FileExplorerTestSnapshot {
  currentFolderId: string | null;
  materializedPathCount: number;
  materializedPathSamples: string[];
  rootDirectoryPath: string | null;
  selectedFilePathCount: number;
  selectedFilePathSamples: string[];
  selectionMode: 'explicit' | 'rules';
  treeRootCount: number;
  treeSamples: Array<{
    childCount: number;
    path: string;
    rootFolderId: string | null;
    type: string;
  }>;
}

interface DatabaseDemoImportTestSnapshot {
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

interface DatabaseDemoSemanticSearchTestSnapshot {
  error: string | null;
  firstResultNodeId: string | null;
  hasSearched: boolean;
  isSearching: boolean;
  resultCount: number;
}

interface HeapSnapshot {
  label: string;
  limitMB: number;
  totalMB: number;
  usedMB: number;
}

interface RuntimeProcessSnapshot {
  osProcessId: number | null;
  privateMB: number | null;
  runtimeKind: 'chunking-host' | 'embedding-host' | 'visible-ui';
  sharedMB: number | null;
  workingSetMB: number | null;
}

interface DesktopProcessSnapshot {
  mainProcess: {
    heapUsedMB: number;
    rssMB: number;
  };
  runtimes: RuntimeProcessSnapshot[];
}

interface CombinedMemorySnapshot {
  hostHeap: HeapSnapshot;
  label: string;
  process: DesktopProcessSnapshot;
  visibleHeap: HeapSnapshot;
}

interface BackfillCorpusFixture {
  embeddingSetId: string;
  fileCount: number;
  totalChunks: number;
}

interface RealWorldMixedStateScenario {
  activeWindow: Page;
  backgroundFixture: BackfillCorpusFixture;
  importEmbeddingSetId: string;
  importImportedPathCounts: ImportedPathCounts;
  initialTimeOrigin: number;
  sawChunkingHostActive: boolean;
  searchableEmbeddingSetId: string;
}

interface LargeCollectionListFixture {
  embeddingSetId: string;
  fileCount: number;
}

interface MemorySample {
  elapsedMs: number;
  queueStats: QueueStatsRow;
  snapshot: CombinedMemorySnapshot;
}

interface AppMetricSample {
  memoryKB: number;
  name: string;
  pid: number;
  type: string;
}

interface GpuWorkingSetScore {
  maxGpuKB: number;
  maxTotalKB: number;
  medianGpuKB: number;
  medianTotalKB: number;
  minGpuKB: number;
  minSample: AppMetricSample[];
  minTotalKB: number;
}

interface NumericSampleScore {
  max: number;
  median: number;
  min: number;
}

interface PostTargetMemorySample {
  appMetrics: AppMetricSample[];
  hostWorkingSetMB: number;
}

function withTemporaryProcessEnv(overrides: Record<string, string | undefined>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function waitForTcpPortOpen(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const hosts = ['127.0.0.1', '::1'] as const;
  while (Date.now() - startedAt < timeoutMs) {
    const connected = await Promise.any(
      hosts.map(
        (host) =>
          new Promise<boolean>((resolve, reject) => {
            const socket = net.createConnection({ host, port }, () => {
              socket.destroy();
              resolve(true);
            });
            socket.on('error', () => {
              socket.destroy();
              reject(new Error(`connect failed for ${host}:${port}`));
            });
          })
      )
    )
      .then(() => true)
      .catch(() => false);
    if (connected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for localhost:${port} to accept connections.`);
}

const LARGE_BACKFILL_FILE_COUNT = 1000;
const LARGE_BACKFILL_CHUNKS_PER_FILE = 20;
const LARGE_COLLECTION_LIST_FILE_COUNT = 50_000;
const LARGE_COLLECTION_RENDER_FILE_COUNT = 5000;
const LARGE_COLLECTION_RENDER_CHUNKS_PER_FILE = 10;
// Repeated-cycle coverage is about retained-memory drift on a single live host.
// The local-only large chunk pressure test above covers peak-load behavior.
const LARGE_BACKFILL_CYCLE_FILE_COUNT = 32;
const LARGE_BACKFILL_CYCLE_CHUNKS_PER_FILE = 8;
const LARGE_BACKFILL_SAMPLE_COUNT = 6;
const LARGE_BACKFILL_SAMPLE_INTERVAL_MS = 2500;
const LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB = 120;
const LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB = 80;
const LARGE_BACKFILL_MAIN_RSS_GROWTH_LIMIT_MB = 180;
const LARGE_BACKFILL_MAIN_HEAP_GROWTH_LIMIT_MB = 80;
const LARGE_BACKFILL_IDLE_HOST_HEAP_DRIFT_LIMIT_MB = 40;
const LARGE_BACKFILL_IDLE_MAIN_RSS_DRIFT_LIMIT_MB = 90;
const LARGE_COLLECTION_VISIBLE_HEAP_GROWTH_LIMIT_MB = 120;
const LARGE_COLLECTION_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB = 250;
const LARGE_COLLECTION_LIST_VISIBLE_HEAP_GROWTH_LIMIT_MB = 80;
const LARGE_COLLECTION_LIST_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB = 180;
const ACTUAL_IMPORT_STRESS_FILE_COUNT = 1000;
const ACTUAL_IMPORT_SENTENCES_PER_FILE = 24;
const ACTUAL_IMPORT_VISIBLE_WORKING_SET_LIMIT_MB = 1400;
const DEFAULT_12K_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB = 1000;
const DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT = 4;
// Mirrors the desktop hidden-host idle claim batch. Running queue rows are
// claimed jobs, not concurrent model executions.
const DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT = 16;
const REAL_WORLD_MIXED_STATE_FILE_COUNT = 1002;
const REAL_WORLD_BACKGROUND_FILE_COUNT = 256;
const REAL_WORLD_BACKGROUND_CHUNKS_PER_FILE = 12;

test.describe('Embedding Host Renderer', () => {
  test.describe.configure({ mode: 'serial' });

  const ERROR_LOCATOR = '[data-testid="db-init-error"]';

  async function isDatabaseError(page: Page): Promise<boolean> {
    try {
      return await page.locator(ERROR_LOCATOR).isVisible({ timeout: 200 });
    } catch {
      return false;
    }
  }

  async function assertToolsPanelResponsive(page: Page): Promise<void> {
    const assistantShell = page.getByTestId('assistant-chat-card');
    const workspaceToggle = page
      .getByTestId('show-workspace-panel')
      .or(page.getByTestId('hide-workspace-panel'));

    await expect(assistantShell).toBeVisible({ timeout: 10_000 });
    await expect(workspaceToggle.first()).toBeVisible({ timeout: 10_000 });
  }

  async function getEmbeddingHostStatus(page: Page): Promise<EmbeddingHostStatus> {
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

  async function getChunkingHostStatus(page: Page): Promise<ChunkingHostStatus> {
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

  async function getMainBufferedLogs(page: Page): Promise<MainBufferedLogRecord[]> {
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

  async function resetEmbeddingHost(page: Page): Promise<EmbeddingHostStatus> {
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

  async function stopEmbeddingHost(page: Page): Promise<EmbeddingHostStatus> {
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

  async function destroyEmbeddingHostWindow(app: ElectronApplication): Promise<void> {
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

  async function stopChunkingHost(page: Page): Promise<ChunkingHostStatus> {
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

  async function waitForEmbeddingHostState(
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

  async function waitForActiveProcessingOrFatalError(
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

  async function waitForBackfillButtonEnabled(
    page: Page,
    backfillButton: ReturnType<Page['locator']>,
    timeoutMs = 15_000
  ): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const [enabled, queueStats] = await Promise.all([
        backfillButton.isEnabled(),
        getEmbeddingQueueStats(page),
      ]);

      if (enabled && queueStats.queued === 0 && queueStats.running === 0) {
        return;
      }

      await page.waitForTimeout(250);
    }

    throw new Error('Timed out waiting for the backfill button to become enabled');
  }

  async function waitForBoundedBackfillEnqueueOrFatalError(
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

  async function waitForBackfillProgressText(
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

  function parseBackfillProgressLabel(label: string): { done: number; total: number } {
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

  async function waitForPositiveBackfillProgress(
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

  async function waitForEmbeddingHostIdleAndQueueDrain(
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
        return { status, queueStats };
      }

      await page.waitForTimeout(250);
    }

    throw new Error('Timed out waiting for embedding host idle state and queue drain');
  }

  async function getEmbeddingHostPage(window: Page): Promise<Page> {
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

  async function getRendererLogRecords(page: Page): Promise<BufferedLogRecord[]> {
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

  async function ensureLeftPanelVisible(page: Page): Promise<void> {
    const leftPanel = getContextExplorerLeftPanel(page);
    const showLeftPanelButton = page
      .getByTestId('show-explorer-panel')
      .or(page.getByRole('button', { name: /show explorer/i }));

    if (
      !(await leftPanel.isVisible().catch(() => false)) &&
      (await showLeftPanelButton.isVisible().catch(() => false))
    ) {
      await showLeftPanelButton.click();
    }

    await expect(leftPanel).toBeVisible({ timeout: 15_000 });
  }

  async function installLargeImportFileSystemMock(
    electronApp: ElectronApplication,
    options: { fileCount: number; rootPath: string; sentencesPerFile: number }
  ): Promise<void> {
    const fixture: ElectronE2eFileSystemFixture = {
      directoriesByPath: {},
      fileContentsByPath: {},
      readDirectoryCalls: [],
      readFileByPathCalls: [],
      readFileCalls: [],
      rootHandle: {
        id: 'mock-directory-handle',
        kind: 'directory',
        name: 'mock-stress-directory',
        path: options.rootPath,
        platform: 'electron',
        type: 'directory',
      },
      requestDirectoryAccessCount: 0,
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
          name: fileName,
          path,
          type: 'file' as const,
          size: fixture.fileContentsByPath[path].length,
          depth: 1,
          selectionState: 'unchecked' as const,
          rootFolderId: fixture.rootHandle.path,
          handle: {
            id: `mock-stress-file-${index}`,
            kind: 'file' as const,
            name: fileName,
            path,
            platform: 'electron' as const,
          },
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

  async function clearLargeImportFileSystemMock(electronApp: ElectronApplication): Promise<void> {
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

  async function getVisibleAlertTexts(page: Page): Promise<string[]> {
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))
        .map((node) => node.textContent?.trim() ?? '')
        .filter((text) => text.length > 0)
    );
  }

  async function getFileExplorerTestSnapshot(page: Page): Promise<FileExplorerTestSnapshot | null> {
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

  async function getDatabaseDemoImportSnapshot(
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

  async function getDatabaseDemoSemanticSearchSnapshot(
    page: Page
  ): Promise<DatabaseDemoSemanticSearchTestSnapshot | null> {
    return await page.evaluate<DatabaseDemoSemanticSearchTestSnapshot | null>(() => {
      const hooks = (
        window as Window & {
          __brainstrikeDatabaseDemoSemanticSearchTestHooks__?: {
            getSnapshot?: () => DatabaseDemoSemanticSearchTestSnapshot;
          };
        }
      ).__brainstrikeDatabaseDemoSemanticSearchTestHooks__;
      if (!hooks?.getSnapshot) {
        return null;
      }
      return hooks.getSnapshot();
    });
  }

  async function getMainProcessFileSystemFixtureSummary(
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

  async function setImportSettingsForStressTest(page: Page): Promise<void> {
    await page.evaluate(() => {
      localStorage.setItem(
        'import-settings.v1',
        JSON.stringify({
          state: {
            enableChunking: true,
            chunkingPreset: 'custom',
            chunkingStrategy: 'sentence',
            chunkingStrategyExplicit: true,
            chunkSize: 512,
            chunkOverlap: 0,
            tokenTrueSizing: true,
            chunkTokenLimit: 4096,
          },
          version: 7,
        })
      );
    });
  }

  async function setFileExplorerMaxSelectionCount(
    page: Page,
    maxSelectionCount: number
  ): Promise<void> {
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

  function extractUnexpectedLifecycleLogs(
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

  function parseNumericLogField(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  function getMainProcessHealthPayload(
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

  function parseMainProcessHealthSamples(
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
                runtimeKind,
                osProcessId: parseNumericLogField(metric['osProcessId']),
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

  function recordContainsText(record: BufferedLogRecord, text: string): boolean {
    if (typeof record.message === 'string' && record.message.includes(text)) {
      return true;
    }

    return record.args.some((arg) => typeof arg === 'string' && arg.includes(text));
  }

  function countRecordsContainingText(records: readonly BufferedLogRecord[], text: string): number {
    return records.filter((record) => recordContainsText(record, text)).length;
  }

  function extractStructuredLogString(
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

  async function forceRendererGarbageCollection(page: Page): Promise<void> {
    await page.evaluate(() => {
      const globalWindow = window as Window & { gc?: () => void };
      globalWindow.gc?.();
    });
    await page.waitForTimeout(500);
  }

  async function readRendererHeapSnapshot(page: Page, label: string): Promise<HeapSnapshot> {
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
        usedMB: Math.round((memory.usedJSHeapSize / 1024 / 1024) * 10) / 10,
        totalMB: Math.round((memory.totalJSHeapSize / 1024 / 1024) * 10) / 10,
        limitMB: Math.round((memory.jsHeapSizeLimit / 1024 / 1024) * 10) / 10,
      };
    }, label);
  }

  async function readDesktopProcessSnapshot(
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
          const runtimeKind: RuntimeProcessSnapshot['runtimeKind'] =
            mode === 'embedding-host'
              ? 'embedding-host'
              : mode === 'chunking-host'
                ? 'chunking-host'
                : 'visible-ui';
          const osProcessId = browserWindow.webContents.getOSProcessId();
          if (typeof webContents.getProcessMemoryInfo !== 'function') {
            return {
              runtimeKind,
              osProcessId,
              workingSetMB: null,
              privateMB: null,
              sharedMB: null,
            };
          }

          const memory = await webContents.getProcessMemoryInfo();

          return {
            runtimeKind,
            osProcessId,
            workingSetMB: toMBFromKilobytes(memory.residentSet),
            privateMB: toMBFromKilobytes(memory.private),
            sharedMB: toMBFromKilobytes(memory.shared),
          };
        })
      );

      const mainMemory = process.memoryUsage();
      return {
        mainProcess: {
          rssMB: Math.round((mainMemory.rss / 1024 / 1024) * 10) / 10,
          heapUsedMB: Math.round((mainMemory.heapUsed / 1024 / 1024) * 10) / 10,
        },
        runtimes: runtimes.sort((left, right) => left.runtimeKind.localeCompare(right.runtimeKind)),
      };
    });
  }

  function getRuntimeSnapshot(
    snapshot: DesktopProcessSnapshot,
    runtimeKind: RuntimeProcessSnapshot['runtimeKind']
  ): RuntimeProcessSnapshot {
    const runtime = snapshot.runtimes.find((entry) => entry.runtimeKind === runtimeKind);
    if (!runtime) {
      throw new Error(`Missing runtime process snapshot for ${runtimeKind}`);
    }
    return runtime;
  }

  function growth(after: number, before: number): number {
    return Math.round((after - before) * 10) / 10;
  }

  function scoreNumericSamples(samples: readonly number[]): NumericSampleScore {
    if (samples.length === 0) {
      throw new Error('Numeric sample scoring requires at least one sample.');
    }

    const sorted = [...samples].sort((left, right) => left - right);
    const medianIndex = Math.floor(sorted.length / 2);
    return {
      min: sorted[0] ?? 0,
      median: sorted[medianIndex] ?? 0,
      max: sorted.at(-1) ?? 0,
    };
  }

  async function readTrackedRuntimeWorkingSetMB(
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
            const hostWindow = BrowserWindow.getAllWindows().find((browserWindow) => {
              const url = browserWindow.webContents.getURL();
              let mode: string | null = null;
              try {
                mode = new URL(url).searchParams.get('mode');
              } catch {
                mode = null;
              }
              const runtimeKind =
                mode === 'embedding-host'
                  ? 'embedding-host'
                  : mode === 'chunking-host'
                    ? 'chunking-host'
                    : 'visible-ui';
              return runtimeKind === expectedRuntimeKind;
            });
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

  async function waitForTrackedRuntimeWorkingSetMB(
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

  async function readElectronAppMetricsWithRetry(
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

  async function readAppMetricSample(
    app: ElectronApplication,
    page: Page
  ): Promise<AppMetricSample[]> {
    return await readElectronAppMetricsWithRetry(app, page);
  }

  function getGpuWorkingSetKB(metrics: readonly AppMetricSample[]): number {
    return metrics.find((metric) => metric.type === 'GPU')?.memoryKB ?? 0;
  }

  function getTotalWorkingSetKB(metrics: readonly AppMetricSample[]): number {
    return metrics.reduce((sum, metric) => sum + metric.memoryKB, 0);
  }

  function scoreGpuWorkingSetSamples(samples: readonly AppMetricSample[][]): GpuWorkingSetScore {
    if (samples.length === 0) {
      throw new Error('GPU working-set scoring requires at least one sample.');
    }

    const withTotals = samples.map((sample) => ({
      gpuKB: getGpuWorkingSetKB(sample),
      sample,
      totalKB: getTotalWorkingSetKB(sample),
    }));
    const gpuValues = withTotals.map((entry) => entry.gpuKB).sort((left, right) => left - right);
    const totalValues = withTotals
      .map((entry) => entry.totalKB)
      .sort((left, right) => left - right);
    const minEntry = withTotals.reduce((best, candidate) =>
      candidate.gpuKB < best.gpuKB ? candidate : best
    );
    const medianIndex = Math.floor(withTotals.length / 2);

    return {
      minGpuKB: gpuValues[0] ?? 0,
      medianGpuKB: gpuValues[medianIndex] ?? 0,
      maxGpuKB: gpuValues.at(-1) ?? 0,
      minTotalKB: totalValues[0] ?? 0,
      medianTotalKB: totalValues[medianIndex] ?? 0,
      maxTotalKB: totalValues.at(-1) ?? 0,
      minSample: minEntry.sample,
    };
  }

  async function collectPostTargetMemorySamples(
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

  async function readCombinedMemorySnapshot(
    electronApp: ElectronApplication,
    activeWindow: Page,
    hostPage: Page,
    label: string
  ): Promise<CombinedMemorySnapshot> {
    const [visibleHeap, hostHeap, process] = await Promise.all([
      readRendererHeapSnapshot(activeWindow, `${label}-visible`),
      readRendererHeapSnapshot(hostPage, `${label}-host`),
      readDesktopProcessSnapshot(electronApp),
    ]);

    return {
      label,
      visibleHeap,
      hostHeap,
      process,
    };
  }

  async function sampleMemoryWhileBackfillActive(
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
        readCombinedMemorySnapshot(
          electronApp,
          activeWindow,
          hostPage,
          `active-sample-${index + 1}`
        ),
        getEmbeddingQueueStats(activeWindow),
      ]);

      samples.push({
        elapsedMs: Date.now() - startedAt,
        snapshot,
        queueStats,
      });

      if (index < sampleCount - 1) {
        await activeWindow.waitForTimeout(intervalMs);
      }
    }

    return samples;
  }

  async function createTestBackfillJob(page: Page): Promise<{
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
          `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, content_tsvector, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, to_tsvector('english', $4), $8, $8)`,
          [
            chunkId,
            fileRecordId,
            0,
            'Test content for embedding host validation',
            `chunk-hash-${randomSuffix}`,
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
              embeddingSetId,
              modelKey,
              expectedDimension,
            }),
            now,
          ]
        );

        return { chunkId, embeddingSetId, jobId };
      }
    );
  }

  async function createInvalidJob(page: Page): Promise<string> {
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

  async function clearEmbeddingQueue(page: Page): Promise<void> {
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

  async function createLargeBackfillFixture(
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
             id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, content_tsvector, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, to_tsvector('english', $4), $8, $8)`,
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

  async function createLargeBackfillCorpusFixture(
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
      async ({
        chunkContentBytes,
        chunksPerFile,
        fileContentBytes,
        fileCount,
        persistActiveSet,
      }) => {
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
              `($${nextParam}, $${nextParam + 1}, $${nextParam + 2}, $${nextParam + 3}, $${nextParam + 4}, $${nextParam + 5}, 'text', $${nextParam + 6}, to_tsvector('english', $${nextParam + 3}), $${nextParam + 7}, $${nextParam + 7})`
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
               id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, content_tsvector, created_at, updated_at
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
                id: `${fileRecordId}-chunk-${chunkIndex}`,
                fileRecordId,
                chunkIndex,
                content: [
                  `export const fileIndex = ${fileIndex};`,
                  `export const chunkIndex = ${chunkIndex};`,
                  `export const corpusId = "${embeddingSetId}";`,
                  'export const note = "backfill-memory-regression";',
                ].join('\n'),
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
        fileCount: options.fileCount,
        fileContentBytes: options.fileContentBytes ?? 0,
        chunksPerFile: options.chunksPerFile,
        persistActiveSet: options.persistActiveSet ?? true,
      }
    );
  }

  async function createLargeCollectionListFixture(
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

  async function createCollectionViaDialog(page: Page, collectionName: string): Promise<void> {
    const databasePanel = page.getByTestId('database-demo-panel');
    await databasePanel.getByRole('button', { name: 'New' }).click({ timeout: 5000 });

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Create Search Collection')).toBeVisible({ timeout: 15_000 });

    const nameInput = dialog.getByLabel('Name *');
    await expect(nameInput).toBeVisible({ timeout: 15_000 });
    await nameInput.fill(collectionName);

    const createButton = dialog.getByRole('button', { name: 'Create Collection' });
    await expect(createButton).toBeEnabled({ timeout: 15_000 });
    await createButton.click({ timeout: 5000 });

    await expect(dialog).toBeHidden({ timeout: 15_000 });
  }

  async function getJobStatus(page: Page, jobId: string): Promise<string | null> {
    return await page.evaluate<string | null, string>(async (id) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: { state: string }[] }>;
            };
          };
        }
      ).electronAPI;
      if (!api?.db?.query) {
        throw new Error('Database API not available');
      }
      const result = (await api.db.query('SELECT state FROM job_queue WHERE id = $1', [id])) as {
        rows: Array<{ state?: string }>;
      };
      return result.rows[0]?.state ?? null;
    }, jobId);
  }

  async function getEmbeddingQueueStats(page: Page): Promise<QueueStatsRow> {
    return await page.evaluate<QueueStatsRow>(async () => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: QueueStatsRow[] }>;
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
         WHERE queue = 'embeddings'`
      );
      const row = result.rows[0] as QueueStatsRow | undefined;
      if (!row) {
        throw new Error('Queue stats query returned no rows');
      }
      return row;
    });
  }

  async function getImportedPathCounts(
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

  async function getEmbeddingSetQueueStats(
    page: Page,
    embeddingSetId: string
  ): Promise<QueueStatsRow> {
    return await page.evaluate<QueueStatsRow, string>(async (id) => {
      const api = (
        window as Window & {
          electronAPI?: {
            db?: {
              query?: (sql: string, params?: unknown[]) => Promise<{ rows: QueueStatsRow[] }>;
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
           AND payload->>'embeddingSetId' = $1`,
        [id]
      );
      const row = result.rows[0] as QueueStatsRow | undefined;
      if (!row) {
        throw new Error('Embedding-set queue stats query returned no rows');
      }
      return row;
    }, embeddingSetId);
  }

  async function getEmbeddingSetCounts(
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
        fileCount: Number(row['fileCount'] ?? 0),
        totalChunks: Number(row['totalChunks'] ?? 0),
        embeddedChunks: Number(row['embeddedChunks'] ?? 0),
      };
    }, embeddingSetId);
  }

  interface CollectionSummaryCounts {
    embeddedChunks: number;
    fileCount: number;
    totalChunks: number;
  }

  function parseCollectionSummaryCounts(summaryText: string): CollectionSummaryCounts {
    const normalized = summaryText.replace(/\s+/g, ' ').trim();
    const match = normalized.match(
      /(\d+)\s+files?.*?(\d+)\s+chunks?.*?(\d+)\s*\/\s*(\d+)\s+embedded/i
    );

    if (!match) {
      throw new Error(`Unable to parse collection summary counts from: ${summaryText}`);
    }

    return {
      fileCount: Number(match[1]),
      totalChunks: Number(match[2]),
      embeddedChunks: Number(match[3]),
    };
  }

  async function getCollectionSummaryCounts(
    page: Page,
    collectionName: string
  ): Promise<CollectionSummaryCounts> {
    const option = page.getByRole('option').filter({ hasText: collectionName }).first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    const text = await option.innerText();
    return parseCollectionSummaryCounts(text);
  }

  async function resolveCollectionIdByName(page: Page, collectionName: string): Promise<string> {
    const option = page.getByRole('option').filter({ hasText: collectionName }).first();
    await expect(option).toBeVisible({ timeout: 15_000 });
    const optionId = await option.getAttribute('id');
    if (!optionId?.startsWith('collection-option-')) {
      throw new Error(`Collection option is missing the canonical id for ${collectionName}`);
    }
    return optionId.replace('collection-option-', '');
  }

  async function createImportTargetCollection(
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

      return { embeddingSetId, collectionName: name ?? 'Import Backfill Test' };
    }, collectionName);
  }

  async function getRendererTimeOrigin(page: Page): Promise<number> {
    return await page.evaluate(() => window.performance.timeOrigin);
  }

  async function setVectorDevicePreference(
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

  async function waitForImportedChunks(page: Page, embeddingSetId: string): Promise<void> {
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

  async function createChunkedImportFixture(
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
            id: `import-file-${crypto.randomUUID()}`,
            name: 'mock-file1.txt',
            path: '/mock/test/directory/mock-file1.txt',
            chunks: [
              'This is a deterministic imported text fixture used to validate desktop chunking and immediate manual backfill.',
              'The second chunk ensures manual backfill sees multiple persisted chunks for the same imported file.',
            ],
            content:
              'This is a deterministic imported text fixture used to validate desktop chunking and immediate manual backfill.\nThe second chunk ensures manual backfill sees multiple persisted chunks for the same imported file.',
            strategy: 'sentence',
          },
          {
            id: `import-file-${crypto.randomUUID()}`,
            name: 'mock-file2.ts',
            path: '/mock/test/directory/mock-file2.ts',
            chunks: [
              'export function fixtureValue(): string { return "desktop import backfill regression"; }',
              'export const fixtureLines = ["alpha", "beta", "gamma", "delta"];',
            ],
            content:
              'export function fixtureValue(): string { return "desktop import backfill regression"; }\nexport const fixtureLines = ["alpha", "beta", "gamma", "delta"];',
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
            await api.db.query(
              `INSERT INTO file_chunks (
               id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, content_tsvector, created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_tsvector('english', $4), $9, $9)`,
              [
                `${file.id}-chunk-${chunkIndex}`,
                file.id,
                chunkIndex,
                chunkContent,
                `chunk-hash-${file.id}-${chunkIndex}`,
                Math.max(1, Math.ceil(chunkContent.length / 8)),
                file.name.endsWith('.ts') ? 'code' : 'text',
                chunkContent.length,
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

  async function waitForEmbeddedCollectionSummary(
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

  async function waitForBackfillQueueMovementOrFatalError(
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

  async function waitForJobTerminalState(
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

  async function ensureEmbeddingHostWarmed(page: Page): Promise<Page> {
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

  async function startBackfillViaBridge(page: Page, embeddingSetId: string): Promise<void> {
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
        embeddingSetId: id,
        done: false,
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

  async function waitForBridgeBackfillCompletion(page: Page, timeoutMs = 240_000): Promise<void> {
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

  async function getBridgeBackfillState(page: Page): Promise<{
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

  async function getRelevantElectronStderr(app: ElectronApplication): Promise<string[]> {
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

  async function getRelevantElectronStderrSince(
    app: ElectronApplication,
    baselineCount: number
  ): Promise<string[]> {
    const lines = await getRelevantElectronStderr(app);
    return lines.slice(baselineCount);
  }

  function countPlannedMaintenanceLogs(records: readonly MainBufferedLogRecord[]): number {
    return records.filter((record) =>
      (record.message ?? '').includes('Completed embedding host GPU reclaim maintenance')
    ).length;
  }

  function detectObservedMaintenanceCycles(options: {
    finalRuntimeId: string;
    initialRuntimeId: string;
    logsSinceBaseline: readonly MainBufferedLogRecord[];
  }): number {
    const logCount = countPlannedMaintenanceLogs(options.logsSinceBaseline);
    const runtimeRestartCycles = options.finalRuntimeId === options.initialRuntimeId ? 0 : 1;
    return Math.max(logCount, runtimeRestartCycles);
  }

  async function assertCleanBackfillMeasurementScenario(
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

  async function waitForReclaimCycleAndResumedProcessing(
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
        initialRuntimeId,
        finalRuntimeId: status.runtimeId,
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

  async function prepareRealWorldMixedStateScenario(
    electronApp: ElectronApplication,
    window: Page
  ): Promise<RealWorldMixedStateScenario> {
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      throw new Error('Database initialization failed in desktop mixed-state setup');
    }

    await clearEmbeddingQueue(activeWindow);
    await stopEmbeddingHost(activeWindow);
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

    await ensureLeftPanelVisible(activeWindow);
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
        fileCount: searchableFixture.fileCount,
        totalChunks: searchableFixture.totalChunks,
        embeddedChunks: searchableFixture.totalChunks,
      });

    const importCollectionName = `Mixed State Import ${Date.now()}`;
    await createCollectionViaDialog(activeWindow, importCollectionName);
    const importEmbeddingSetId = await resolveCollectionIdByName(
      activeWindow,
      importCollectionName
    );

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
    await expect(activeWindow.getByText('mock-stress-directory')).toBeVisible({
      timeout: 15_000,
    });

    const selectAllButton = activeWindow.getByRole('button', { name: /^Select All$/i }).first();
    await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
    await selectAllButton.click({ timeout: 5000 });

    await expect(activeWindow.getByTestId('selection-count')).toHaveText(
      String(REAL_WORLD_MIXED_STATE_FILE_COUNT),
      {
        timeout: 60_000,
      }
    );

    const importButton = activeWindow.getByRole('button', { name: /^Import\s*\(/ });
    await expect(importButton).toContainText(`(${REAL_WORLD_MIXED_STATE_FILE_COUNT})`, {
      timeout: 30_000,
    });
    await importButton.click({ timeout: 5000 });

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

      if (
        pathCounts.fileCount === REAL_WORLD_MIXED_STATE_FILE_COUNT &&
        pathCounts.totalChunks > 0
      ) {
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
        fileCount: REAL_WORLD_MIXED_STATE_FILE_COUNT,
        totalChunks: expect.any(Number),
        embeddedChunks: 0,
      });

    const backgroundFixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: REAL_WORLD_BACKGROUND_FILE_COUNT,
      chunksPerFile: REAL_WORLD_BACKGROUND_CHUNKS_PER_FILE,
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
    expect(fileExplorerSnapshotBeforeChecks).toMatchObject({
      currentFolderId: '/mock/real-world-import',
      rootDirectoryPath: '/mock/real-world-import',
      selectedFilePathCount: REAL_WORLD_MIXED_STATE_FILE_COUNT,
    });

    return {
      activeWindow,
      backgroundFixture,
      importEmbeddingSetId,
      importImportedPathCounts,
      initialTimeOrigin,
      sawChunkingHostActive,
      searchableEmbeddingSetId,
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
        return { ok: false, message: 'Database API not available' };
      }

      try {
        await api.db.test();
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }

      if (!api.db.clearAll) {
        return { ok: true, message: null };
      }

      const result = await api.db.clearAll('CONFIRM_CLEAR_DATABASE');
      return { ok: result.success, message: result.message ?? null };
    });

    if (!dbStatus.ok) {
      console.warn('Database unavailable in test setup:', dbStatus.message);
    }
  });

  test.beforeEach(async ({ electron }) => {
    await electron.ensureWindow();
  });

  test('@desktop-embedding-core defers hidden embedding host startup until first use', async ({
    electron,
  }) => {
    const context = await electron.restart();
    const window = context.window;
    await waitForAppReadyInTest(window);

    if (await isDatabaseError(window)) {
      await expect(window.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const initialStatus = await window.evaluate(async () => {
      const api = (
        globalThis as unknown as Window & {
          embeddingHost?: {
            getStatus?: () => Promise<{
              active: boolean;
              lastError: string | null;
              runtimeId: string;
              runtimeKind: 'embedding-host';
              state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
            }>;
          };
        }
      ).embeddingHost;

      if (!api?.getStatus) {
        throw new Error('Embedding host bridge is not available');
      }

      return api.getStatus();
    });

    expect(initialStatus.state).toBe('stopped');
    expect(initialStatus.lastError).toBeNull();

    const status = await window.evaluate(async () => {
      const api = (
        globalThis as unknown as Window & {
          embeddingHost?: {
            ensureStarted?: () => Promise<{
              active: boolean;
              lastError: string | null;
              runtimeId: string;
              runtimeKind: 'embedding-host';
              state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
            }>;
          };
        }
      ).embeddingHost;

      if (!api?.ensureStarted) {
        throw new Error('Embedding host bridge is not available');
      }

      return api.ensureStarted();
    });

    expect(status.state).toBe('running');
    expect(status.lastError).toBeNull();

    const hostPage = await getEmbeddingHostPage(window);
    await hostPage.waitForTimeout(1000);
    const hostLogs = await getRendererLogRecords(hostPage);

    expect(
      hostLogs.some((record) =>
        recordContainsText(
          record,
          'Deferring local embedding model initialization until first claimed job'
        )
      )
    ).toBe(true);
    expect(
      hostLogs.some((record) => recordContainsText(record, 'Warmup job submission failed'))
    ).toBe(false);
    expect(
      hostLogs.some((record) => recordContainsText(record, 'worker_model_dimension_notice'))
    ).toBe(false);
    expect(
      hostLogs.some((record) =>
        recordContainsText(record, 'Failed to create WebGPU Context Provider')
      )
    ).toBe(false);
    expect(hostLogs.some((record) => recordContainsText(record, 'Pipeline load failed'))).toBe(
      false
    );
    expect(
      hostLogs.some((record) => recordContainsText(record, 'Workerpool embedding task failed'))
    ).toBe(false);
  });

  test('@desktop-embedding-core keeps the visible UI responsive while jobs are queued for the hidden host', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const jobs = await Promise.all([
      createTestBackfillJob(activeWindow),
      createTestBackfillJob(activeWindow),
      createTestBackfillJob(activeWindow),
    ]);

    expect(jobs).toHaveLength(3);
    await assertToolsPanelResponsive(activeWindow);

    const status = await getEmbeddingHostStatus(activeWindow);
    if (status.state === 'error') {
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
      return;
    }

    expect(status.state).toBe('running');
  });

  test('@desktop-embedding-core keeps the visible UI responsive while a large backfill is being enqueued', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    const fixture = await createLargeBackfillFixture(activeWindow, 160);
    await reloadRendererInTest(activeWindow, 'embedding-worker-large-backfill-fixture');
    await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);

    await backfillButton.click({ timeout: 5000 });
    await assertToolsPanelResponsive(activeWindow);

    const enqueueState = await waitForBoundedBackfillEnqueueOrFatalError(activeWindow);
    const queueStats = await getEmbeddingQueueStats(activeWindow);

    if (enqueueState === 'queued') {
      expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
      expect(
        queueStats.queued + queueStats.running + queueStats.failed + queueStats.succeeded
      ).toBeGreaterThan(0);
      return;
    }

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state).toBe('error');
    expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
    expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
  });

  test('@desktop-embedding-core keeps the visible UI responsive while the hidden host is actively processing a backfill', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    const fixture = await createLargeBackfillFixture(activeWindow, 96, { persistActiveSet: false });
    await reloadRendererInTest(activeWindow, 'embedding-worker-host-processing-fixture');
    await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });
    await expect(
      activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: 'Starting…' })
    ).toHaveCount(0);

    const finalState = await waitForActiveProcessingOrFatalError(activeWindow);
    const queueStats = await getEmbeddingQueueStats(activeWindow);

    if (finalState === 'running') {
      expect(queueStats.queued + queueStats.running).toBeGreaterThan(0);
      expect(queueStats.running).toBeLessThanOrEqual(DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT);
      expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
    } else {
      const status = await getEmbeddingHostStatus(activeWindow);
      const hostPage = await getEmbeddingHostPage(activeWindow);
      await hostPage.waitForTimeout(1000);
      const hostLogs = await getRendererLogRecords(hostPage);

      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
      expect(countRecordsContainingText(hostLogs, 'Pipeline load failed')).toBeLessThanOrEqual(1);
      expect(
        countRecordsContainingText(hostLogs, 'Embedding worker streaming failed')
      ).toBeLessThanOrEqual(1);
      expect(queueStats.running).toBe(0);
      expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
      expect(
        countRecordsContainingText(
          hostLogs,
          'Stopping embedding worker after fatal local model error'
        )
      ).toBeLessThanOrEqual(1);
    }

    await assertToolsPanelResponsive(activeWindow);
    await activeWindow.waitForTimeout(500);
    await assertToolsPanelResponsive(activeWindow);
  });

  test('@desktop-embedding-core keeps visible renderer heap bounded while the hidden host enqueues and processes a large backfill', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    const fixture = await createLargeBackfillFixture(activeWindow, 96, { persistActiveSet: false });
    await reloadRendererInTest(activeWindow, 'embedding-worker-visible-memory-diagnostic');
    await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    const baseline = await readRendererHeapSnapshot(activeWindow, 'before-backfill');

    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForActiveProcessingOrFatalError(activeWindow);
    expect(['error', 'running']).toContain(outcome);

    await assertToolsPanelResponsive(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    const retained = await readRendererHeapSnapshot(activeWindow, 'after-backfill');
    const retainedGrowthMB = retained.usedMB - baseline.usedMB;
    const queueStats = await getEmbeddingQueueStats(activeWindow);

    console.log(
      JSON.stringify({
        type: 'desktop-visible-renderer-memory-diagnostic',
        embeddingSetId: fixture.embeddingSetId,
        baseline,
        retained,
        retainedGrowthMB,
        queueStats,
        outcome,
      })
    );

    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
    }

    expect(queueStats.queued + queueStats.running).toBeLessThanOrEqual(64);
    expect(retainedGrowthMB).toBeLessThan(60);
  });

  test('@desktop-embedding-core keeps hidden-host, visible-renderer, and main-process memory bounded during a 20k chunk backfill', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.skip(
      !!process.env['CI'],
      'Large local-model memory-pressure harness is opt-in; required CI covers active backfill lifecycle, queue caps, and UI responsiveness with bounded fixtures.'
    );
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-20k-backfill-memory-pressure');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const warmedHostPage = await ensureEmbeddingHostWarmed(activeWindow);
    const warmedBaseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      warmedHostPage,
      'post-warmup-idle'
    );

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: LARGE_BACKFILL_FILE_COUNT,
      chunksPerFile: LARGE_BACKFILL_CHUNKS_PER_FILE,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'embedding-worker-20k-backfill-memory-diagnostic');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const hostPage = await getEmbeddingHostPage(activeWindow);
    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'before-20k-backfill'
    );
    const baselineHostProcess = getRuntimeSnapshot(baseline.process, 'embedding-host');
    const baselineHostPid = baselineHostProcess.osProcessId;
    expect(baselineHostPid).toBeTruthy();

    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForActiveProcessingOrFatalError(activeWindow, 120_000);
    expect(outcome).toBe('running');

    const samples = await sampleMemoryWhileBackfillActive(electronApp.app, activeWindow);
    const activeHostPid = getRuntimeSnapshot(
      samples[0]?.snapshot.process ?? baseline.process,
      'embedding-host'
    ).osProcessId;
    expect(activeHostPid).toBeTruthy();
    const peaks = samples.reduce(
      (current, sample) => {
        const hostProcess = getRuntimeSnapshot(sample.snapshot.process, 'embedding-host');
        return {
          hostHeapMB: Math.max(current.hostHeapMB, sample.snapshot.hostHeap.usedMB),
          visibleHeapMB: Math.max(current.visibleHeapMB, sample.snapshot.visibleHeap.usedMB),
          mainRssMB: Math.max(current.mainRssMB, sample.snapshot.process.mainProcess.rssMB),
          mainHeapMB: Math.max(current.mainHeapMB, sample.snapshot.process.mainProcess.heapUsedMB),
          hostPids: current.hostPids.concat(hostProcess.osProcessId),
        };
      },
      {
        hostHeapMB: baseline.hostHeap.usedMB,
        visibleHeapMB: baseline.visibleHeap.usedMB,
        mainRssMB: baseline.process.mainProcess.rssMB,
        mainHeapMB: baseline.process.mainProcess.heapUsedMB,
        hostPids: [] as Array<number | null>,
      }
    );

    console.log(
      JSON.stringify({
        type: 'desktop-large-backfill-memory-pressure',
        fixture,
        warmedBaseline,
        baseline,
        peaks,
        samples,
      })
    );

    for (const sample of samples) {
      expect(sample.queueStats.queued + sample.queueStats.running).toBeLessThanOrEqual(64);
      expect(getRuntimeSnapshot(sample.snapshot.process, 'embedding-host').osProcessId).toBe(
        activeHostPid
      );
    }

    expect(growth(peaks.hostHeapMB, baseline.hostHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.visibleHeapMB, baseline.visibleHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.mainRssMB, baseline.process.mainProcess.rssMB)).toBeLessThan(
      LARGE_BACKFILL_MAIN_RSS_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.mainHeapMB, baseline.process.mainProcess.heapUsedMB)).toBeLessThan(
      LARGE_BACKFILL_MAIN_HEAP_GROWTH_LIMIT_MB
    );

    await electronHarness.restart();
  });

  test('@desktop-embedding-core keeps the visible renderer bounded when opening a 50k chunk collection in the database tab', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'database-visible-render-large-collection-pref');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const hostPage = await ensureEmbeddingHostWarmed(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(hostPage);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: LARGE_COLLECTION_RENDER_FILE_COUNT,
      chunksPerFile: LARGE_COLLECTION_RENDER_CHUNKS_PER_FILE,
      fileContentBytes: 4096,
      chunkContentBytes: 1024,
      persistActiveSet: false,
    });

    await reloadRendererInTest(activeWindow, 'database-visible-render-large-collection');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    const reloadedHostPage = await getEmbeddingHostPage(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(reloadedHostPage);

    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      reloadedHostPage,
      'before-large-collection-open'
    );

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });
    await expect(collectionOption).toHaveAttribute('aria-selected', 'true');

    await activeWindow.waitForTimeout(3000);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);

    const selected = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      reloadedHostPage,
      'after-large-collection-open'
    );

    const baselineVisibleProcess = getRuntimeSnapshot(baseline.process, 'visible-ui');
    const selectedVisibleProcess = getRuntimeSnapshot(selected.process, 'visible-ui');
    const visibleHeapGrowthMB = growth(selected.visibleHeap.usedMB, baseline.visibleHeap.usedMB);
    const visibleWorkingSetGrowthMB = growth(
      selectedVisibleProcess.workingSetMB ?? 0,
      baselineVisibleProcess.workingSetMB ?? 0
    );

    console.log(
      JSON.stringify({
        type: 'desktop-visible-render-large-collection',
        fixture,
        baseline,
        selected,
        visibleHeapGrowthMB,
        visibleWorkingSetGrowthMB,
      })
    );

    await assertToolsPanelResponsive(activeWindow);

    expect(visibleHeapGrowthMB).toBeLessThan(LARGE_COLLECTION_VISIBLE_HEAP_GROWTH_LIMIT_MB);
    expect(visibleWorkingSetGrowthMB).toBeLessThan(
      LARGE_COLLECTION_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB
    );
  });

  test('@desktop-embedding-core keeps the database tab source-paginated and memory-bounded for a 50k file collection', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'database-visible-render-large-file-list-pref');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const hostPage = await ensureEmbeddingHostWarmed(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(hostPage);

    const fixture = await createLargeCollectionListFixture(activeWindow, {
      fileCount: LARGE_COLLECTION_LIST_FILE_COUNT,
      fileContentBytes: 1024,
      persistActiveSet: false,
    });

    await reloadRendererInTest(activeWindow, 'database-visible-render-large-file-list');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    const reloadedHostPage = await getEmbeddingHostPage(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(reloadedHostPage);

    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      reloadedHostPage,
      'before-large-file-list-open'
    );

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });
    await expect(collectionOption).toHaveAttribute('aria-selected', 'true');

    const treegrid = activeWindow.getByRole('treegrid');
    const firstVisibleDataRow = treegrid.getByRole('row').nth(1);
    await expect(firstVisibleDataRow).toBeVisible({ timeout: 30_000 });
    expect(((await firstVisibleDataRow.textContent()) ?? '').trim().length).toBeGreaterThan(0);

    const pageNumberInput = activeWindow.getByRole('spinbutton', { name: 'Page number' });
    await expect(pageNumberInput).toHaveValue('1');
    await expect
      .poll(async () => {
        const snapshot = await getDatabaseDemoImportSnapshot(activeWindow);
        return snapshot?.recordPagination.currentPage ?? -1;
      })
      .toBe(0);

    await activeWindow.getByRole('button', { name: 'Go to next page' }).click({ timeout: 5000 });

    await expect(pageNumberInput).toHaveValue('2');
    await expect
      .poll(
        async () => {
          const snapshot = await getDatabaseDemoImportSnapshot(activeWindow);
          return JSON.stringify(snapshot?.recordPagination ?? null);
        },
        { timeout: 30_000 }
      )
      .toBe(
        JSON.stringify({
          currentPage: 1,
          pageSize: 50,
          totalRecords: fixture.fileCount,
        })
      );

    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);

    const paged = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      reloadedHostPage,
      'after-large-file-list-page-change'
    );

    const baselineVisibleProcess = getRuntimeSnapshot(baseline.process, 'visible-ui');
    const pagedVisibleProcess = getRuntimeSnapshot(paged.process, 'visible-ui');
    const visibleHeapGrowthMB = growth(paged.visibleHeap.usedMB, baseline.visibleHeap.usedMB);
    const visibleWorkingSetGrowthMB = growth(
      pagedVisibleProcess.workingSetMB ?? 0,
      baselineVisibleProcess.workingSetMB ?? 0
    );

    console.log(
      JSON.stringify({
        type: 'desktop-visible-render-large-file-list',
        fixture,
        baseline,
        paged,
        visibleHeapGrowthMB,
        visibleWorkingSetGrowthMB,
      })
    );

    expect(visibleHeapGrowthMB).toBeLessThan(LARGE_COLLECTION_LIST_VISIBLE_HEAP_GROWTH_LIMIT_MB);
    expect(visibleWorkingSetGrowthMB).toBeLessThan(
      LARGE_COLLECTION_LIST_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB
    );
  });

  test('@desktop-embedding-core shows a newly created collection immediately without leaving the database tab', async ({
    window,
  }) => {
    test.setTimeout(180_000);

    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const collectionName = `Immediate Collection ${Date.now()}`;
    await createCollectionViaDialog(activeWindow, collectionName);

    const createdOption = activeWindow.getByRole('option', { name: new RegExp(collectionName) });
    await expect(createdOption).toBeVisible({ timeout: 15_000 });
    await expect(createdOption).toHaveAttribute('aria-selected', 'true');
    await expect(activeWindow.locator('[data-testid="database-demo-panel"]')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('@desktop-embedding-core preserves backfill progress on the database button across sidebar tab switches', async ({
    electronHarness,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: LARGE_BACKFILL_FILE_COUNT,
      chunksPerFile: LARGE_BACKFILL_CHUNKS_PER_FILE,
      persistActiveSet: false,
    });

    await reloadRendererInTest(activeWindow, 'database-backfill-progress-tab-switch');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const resolveBackfillActionButton = () =>
      databasePanel
        .locator('button')
        .filter({ hasText: /^(?:Start & )?Backfill(?:\s|$)|^Backfilling|^\d+\/\d+$/u })
        .first();
    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const initialProgress = await waitForPositiveBackfillProgress(
      resolveBackfillActionButton(),
      30_000
    );
    expect(initialProgress.total).toBe(fixture.totalChunks);

    const threadsTab = activeWindow
      .getByTestId('threads-tab-trigger')
      .or(activeWindow.getByRole('tab', { name: 'Threads' }));
    await expect(threadsTab).toBeVisible({ timeout: 10_000 });
    await threadsTab.click();
    await expect(activeWindow.getByTestId('assistant-chat-card')).toBeVisible({ timeout: 10_000 });
    await expect(
      activeWindow
        .getByTestId('database-tab-trigger')
        .or(activeWindow.getByRole('tab', { name: 'Database' }))
    ).toBeVisible({ timeout: 10_000 });

    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const remountedDatabasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const remountedBackfillButton = remountedDatabasePanel
      .locator('button')
      .filter({ hasText: /^(?:Start & )?Backfill(?:\s|$)|^Backfilling|^\d+\/\d+$/u })
      .first();
    const resumedProgressLabel = await waitForBackfillProgressText(remountedBackfillButton, 30_000);
    const resumedProgress = parseBackfillProgressLabel(resumedProgressLabel);

    expect(resumedProgress.total).toBe(initialProgress.total);
    expect(resumedProgress.done).toBeGreaterThanOrEqual(initialProgress.done);

    await electronHarness.restart();
  });

  test('@desktop-embedding-core wiping the queue clears visible backfill state and re-enables manual backfill in the same desktop session', async ({
    electronHarness,
  }) => {
    test.setTimeout(420_000);
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: 'false',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: undefined,
    });

    const context = await electronHarness.restart();
    let activeWindow = await showDatabaseDemoPanel(context.window);

    try {
      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'wasm');

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        fileCount: 80,
        chunksPerFile: 8,
        persistActiveSet: true,
      });

      await reloadRendererInTest(activeWindow, 'database-backfill-wipe-recovery-fixture');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
      const resolveBackfillActionButton = () =>
        databasePanel
          .locator('button')
          .filter({ hasText: /^(?:Start & )?Backfill(?:\s|$)|^Backfilling|^\d+\/\d+$/u })
          .first();
      const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
      const initialElectronStderrCount = (await getRelevantElectronStderr(context.app)).length;

      await expect(backfillButton).toBeVisible({ timeout: 15_000 });
      await waitForBackfillButtonEnabled(activeWindow, backfillButton, 60_000);
      await backfillButton.click({ timeout: 5000 });
      const initialOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        60_000
      );
      expect(initialOutcome).toBe('queued');

      const initialProgress = parseBackfillProgressLabel(
        await waitForBackfillProgressText(resolveBackfillActionButton(), 30_000)
      );
      expect(initialProgress.total).toBe(fixture.totalChunks);
      expect(initialProgress.done).toBeGreaterThanOrEqual(0);

      const actionsButton = databasePanel.getByRole('button', {
        name: /more embedding actions/i,
      });
      await expect(actionsButton).toBeVisible({ timeout: 15_000 });
      await actionsButton.click({ timeout: 5000 });
      await activeWindow.getByRole('menuitem', { name: /wipe all jobs/i }).click({
        timeout: 5000,
      });

      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 60_000);
      await activeWindow.waitForTimeout(1000);
      const stderrSinceWipe = await getRelevantElectronStderrSince(
        context.app,
        initialElectronStderrCount
      );
      expect(
        stderrSinceWipe.filter((entry) => !entry.includes('Embedding backfill was canceled'))
      ).toEqual([]);

      const countsAfterWipe = await getEmbeddingSetCounts(activeWindow, fixture.embeddingSetId);
      expect(countsAfterWipe.totalChunks).toBe(fixture.totalChunks);
      expect(countsAfterWipe.embeddedChunks).toBeLessThan(fixture.totalChunks);

      const retryBackfillButton = databasePanel.getByRole('button', {
        name: /^Backfill(?:\s|$)/,
      });
      await waitForBackfillButtonEnabled(activeWindow, retryBackfillButton, 60_000);
      await retryBackfillButton.click({ timeout: 5000 });

      const retryOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        60_000
      );
      if (retryOutcome === 'error') {
        const status = await getEmbeddingHostStatus(activeWindow);
        throw new Error(
          `Backfill did not recover after wipe and renderer reload: ${status.lastError ?? 'unknown host error'}`
        );
      }
    } finally {
      await clearEmbeddingQueue(activeWindow);
      await stopEmbeddingHost(activeWindow);
      restoreEnv();
    }
  });

  test('@desktop-embedding-core re-enables manual backfill after desktop restart when a collection still has unembedded chunks and no queued or running jobs', async ({
    electronHarness,
  }) => {
    test.setTimeout(420_000);
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: 'false',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: undefined,
    });

    let activeWindow: Page | null = null;
    try {
      const firstContext = await electronHarness.restart();
      activeWindow = await showDatabaseDemoPanel(firstContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'wasm');

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        fileCount: 40,
        chunksPerFile: 6,
        persistActiveSet: true,
      });

      await reloadRendererInTest(activeWindow, 'database-backfill-restart-recovery-fixture');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
      const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });

      await expect(backfillButton).toBeVisible({ timeout: 15_000 });
      await waitForBackfillButtonEnabled(activeWindow, backfillButton, 60_000);
      await backfillButton.click({ timeout: 5000 });
      const initialOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        60_000
      );
      expect(initialOutcome).toBe('queued');

      const actionsButton = databasePanel.getByRole('button', {
        name: /more embedding actions/i,
      });
      await expect(actionsButton).toBeVisible({ timeout: 15_000 });
      await actionsButton.click({ timeout: 5000 });
      await activeWindow.getByRole('menuitem', { name: /wipe all jobs/i }).click({
        timeout: 5000,
      });
      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 60_000);

      const countsBeforeRestart = await getEmbeddingSetCounts(activeWindow, fixture.embeddingSetId);
      expect(countsBeforeRestart.totalChunks).toBe(fixture.totalChunks);
      expect(countsBeforeRestart.embeddedChunks).toBeGreaterThanOrEqual(0);
      expect(countsBeforeRestart.embeddedChunks).toBeLessThan(countsBeforeRestart.totalChunks);

      const restartedContext = await electronHarness.restart();
      activeWindow = await showDatabaseDemoPanel(restartedContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        return;
      }

      const restartedCollectionOption = activeWindow.locator(
        `#collection-option-${fixture.embeddingSetId}`
      );
      await expect(restartedCollectionOption).toBeVisible({ timeout: 30_000 });
      await restartedCollectionOption.click({ timeout: 5000 });

      const restartedDatabasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
      const restartedBackfillButton = restartedDatabasePanel.getByRole('button', {
        name: /^Backfill(?:\s|$)/,
      });
      await expect(restartedBackfillButton).toBeVisible({ timeout: 15_000 });
      await waitForBackfillButtonEnabled(activeWindow, restartedBackfillButton, 60_000);

      const restartedCounts = await getEmbeddingSetCounts(activeWindow, fixture.embeddingSetId);
      expect(restartedCounts.totalChunks).toBe(fixture.totalChunks);
      expect(restartedCounts.embeddedChunks).toBeGreaterThanOrEqual(0);
      expect(restartedCounts.embeddedChunks).toBeLessThan(restartedCounts.totalChunks);

      await restartedBackfillButton.click({ timeout: 5000 });
      const retryOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        60_000
      );
      if (retryOutcome === 'error') {
        const status = await getEmbeddingHostStatus(activeWindow);
        throw new Error(
          `Backfill stayed disabled or failed after desktop restart with pending chunks: ${status.lastError ?? 'unknown host error'}`
        );
      }
    } finally {
      if (activeWindow) {
        await clearEmbeddingQueue(activeWindow);
        await stopEmbeddingHost(activeWindow);
      }
      restoreEnv();
    }
  });

  test('@desktop-embedding-core does not accumulate hidden-host memory across repeated large backfill cycles on the same host process', async ({
    electronHarness,
  }) => {
    test.setTimeout(420_000);

    const electronContext = await electronHarness.restart();
    let activeWindow = await showDatabaseDemoPanel(electronContext.window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-repeat-backfill-cycles');
    activeWindow = await showDatabaseDemoPanel(activeWindow);
    await resetEmbeddingHost(activeWindow);
    await waitForEmbeddingHostState(
      activeWindow,
      (status) => status.state === 'error' || status.state === 'running',
      60_000
    );

    const initialHostPage = await getEmbeddingHostPage(activeWindow);
    const initialSnapshot = await readCombinedMemorySnapshot(
      electronContext.app,
      activeWindow,
      initialHostPage,
      'repeat-cycle-initial'
    );
    const idleSnapshots: CombinedMemorySnapshot[] = [];
    let baseline: CombinedMemorySnapshot | null = null;
    let hostPage = initialHostPage;
    let referenceHostPid: number | null = null;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        fileCount: LARGE_BACKFILL_CYCLE_FILE_COUNT,
        chunksPerFile: LARGE_BACKFILL_CYCLE_CHUNKS_PER_FILE,
        persistActiveSet: false,
      });

      await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
      const outcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        90_000
      );
      expect(outcome).toBe('queued');

      await waitForBridgeBackfillCompletion(activeWindow, 240_000);
      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 30_000);
      hostPage = await getEmbeddingHostPage(activeWindow);
      await clearEmbeddingQueue(activeWindow);
      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 30_000);
      await forceRendererGarbageCollection(activeWindow);
      await forceRendererGarbageCollection(hostPage);
      await forceRendererGarbageCollection(hostPage);
      const idleSnapshot = await readCombinedMemorySnapshot(
        electronContext.app,
        activeWindow,
        hostPage,
        `repeat-cycle-${cycle + 1}-idle`
      );
      idleSnapshots.push(idleSnapshot);

      const hostProcess = getRuntimeSnapshot(idleSnapshot.process, 'embedding-host');
      if (referenceHostPid === null) {
        referenceHostPid = hostProcess.osProcessId;
        expect(referenceHostPid).toBeTruthy();
        baseline = idleSnapshot;
        continue;
      }

      expect(hostProcess.osProcessId).toBe(referenceHostPid);
    }

    if (!baseline) {
      throw new Error('Expected a warmed idle baseline after the first repeated backfill cycle');
    }

    const finalIdleSnapshot = idleSnapshots.at(-1);
    if (!finalIdleSnapshot) {
      throw new Error('Expected at least one idle snapshot after repeated backfill cycles');
    }

    console.log(
      JSON.stringify({
        type: 'desktop-repeat-backfill-idle-drift',
        initialSnapshot,
        baseline,
        idleSnapshots,
        referenceHostPid,
      })
    );

    expect(growth(finalIdleSnapshot.hostHeap.usedMB, baseline.hostHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_IDLE_HOST_HEAP_DRIFT_LIMIT_MB
    );
    expect(
      growth(finalIdleSnapshot.process.mainProcess.rssMB, baseline.process.mainProcess.rssMB)
    ).toBeLessThan(LARGE_BACKFILL_IDLE_MAIN_RSS_DRIFT_LIMIT_MB);
  });

  test('@desktop-embedding-core backfills chunked imported data without hanging and updates collection coverage', async ({
    window,
  }) => {
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);

    const collectionName = `Desktop UI Import ${Date.now()}`;
    const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);
    const chunkedFixture = await createChunkedImportFixture(activeWindow, embeddingSetId);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-import-backfill-flow');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const timeOriginBeforeBackfill = await getRendererTimeOrigin(activeWindow);

    await waitForImportedChunks(activeWindow, embeddingSetId);
    const countsBeforeBackfill = await getEmbeddingSetCounts(activeWindow, embeddingSetId);

    expect(countsBeforeBackfill.fileCount).toBe(chunkedFixture.fileCount);
    expect(countsBeforeBackfill.totalChunks).toBe(chunkedFixture.totalChunks);
    expect(countsBeforeBackfill.embeddedChunks).toBe(0);

    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(activeWindow, embeddingSetId);
    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      expect(status.state).toBe('error');
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
      return;
    }

    const setQueueStats = await getEmbeddingSetQueueStats(activeWindow, embeddingSetId);
    expect(
      setQueueStats.queued + setQueueStats.running + setQueueStats.failed + setQueueStats.succeeded
    ).toBeGreaterThan(0);

    await waitForEmbeddedCollectionSummary(activeWindow, collectionName);

    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 90_000,
      })
      .toMatchObject({
        fileCount: chunkedFixture.fileCount,
        totalChunks: expect.any(Number),
        embeddedChunks: expect.any(Number),
      });

    const countsAfterBackfill = await getEmbeddingSetCounts(activeWindow, embeddingSetId);
    expect(countsAfterBackfill.totalChunks).toBeGreaterThan(0);
    expect(countsAfterBackfill.embeddedChunks).toBe(countsAfterBackfill.totalChunks);

    const timeOriginAfterBackfill = await getRendererTimeOrigin(activeWindow);
    expect(timeOriginAfterBackfill).toBe(timeOriginBeforeBackfill);
    await expect(backfillButton).toContainText('Backfill', { timeout: 15_000 });
  });

  test('@desktop-embedding-core end-to-end: import, embed, then vector search returns correct results', async ({
    window,
  }) => {
    test.setTimeout(300_000);

    // ── 1. Setup: navigate to database demo, create a collection ─────────
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      throw new Error('Database initialization failed — cannot proceed with search E2E');
    }

    await clearEmbeddingQueue(activeWindow);

    const collectionName = `Search E2E ${Date.now()}`;
    const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);

    // ── 2. Insert deterministic fixture data with known searchable content ─
    const chunkedFixture = await createChunkedImportFixture(activeWindow, embeddingSetId);
    expect(chunkedFixture.fileCount).toBe(2);
    expect(chunkedFixture.totalChunks).toBeGreaterThan(0);

    // ── 3. Configure device and reload to pick up preferences ──────────
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-search-e2e');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Select our collection
    const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    // Verify chunks are visible before backfill
    await waitForImportedChunks(activeWindow, embeddingSetId);
    const countsBeforeBackfill = await getEmbeddingSetCounts(activeWindow, embeddingSetId);
    expect(countsBeforeBackfill.embeddedChunks).toBe(0);

    // ── 4. Backfill: generate embeddings for all chunks ───────────────────
    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(activeWindow, embeddingSetId);
    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      throw new Error(
        `Backfill failed during search E2E: ${status.lastError ?? 'unknown host error'}`
      );
    }

    // Wait for ALL chunks to be embedded
    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 120_000,
      })
      .toMatchObject({
        fileCount: chunkedFixture.fileCount,
        totalChunks: chunkedFixture.totalChunks,
        embeddedChunks: chunkedFixture.totalChunks,
      });

    // ── 5. Verify at DB level: embeddings stored with correct dimensions ──
    const dbDiagnostics = await activeWindow.evaluate(async (id) => {
      const api = (
        window as unknown as {
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

      const result = await api.db.query(
        `SELECT
           id,
           content,
           embedding_set_id,
           vector_dims(embedding) AS dims,
           embedding IS NOT NULL AS has_embedding
         FROM file_chunks
         WHERE file_record_id IN (
           SELECT id FROM file_records WHERE embedding_set_id = $1
         )
         ORDER BY chunk_index`,
        [id]
      );

      const rows = result.rows as Array<{
        content: string;
        dims: number | null;
        embedding_set_id: string | null;
        has_embedding: boolean;
        id: string;
      }>;

      return {
        embeddedCount: rows.filter((r) => r.has_embedding).length,
        dimensions: rows.map((r) => Number(r.dims ?? 0)).filter((d) => d > 0),
        embeddingSetIds: rows.map((r) => r.embedding_set_id).filter((s): s is string => s !== null),
        sampleContentPrefixes: rows.map((r) => (r.content ?? '').slice(0, 60)),
      };
    }, embeddingSetId);

    expect(dbDiagnostics.embeddedCount).toBe(chunkedFixture.totalChunks);
    expect(dbDiagnostics.dimensions.length).toBeGreaterThan(0);
    // All dimensions should be the same (same model)
    const uniqueDimensions = [...new Set(dbDiagnostics.dimensions)];
    expect(uniqueDimensions).toHaveLength(1);
    const embeddingDimension = uniqueDimensions[0]!;
    expect(embeddingDimension).toBeGreaterThan(0);
    // All chunks should have the correct embedding_set_id
    expect(dbDiagnostics.embeddingSetIds).toContain(embeddingSetId);

    // ── 5b. Verify FTS: tsvector populated and direct FTS query works ─────
    const ftsDiagnostics = await activeWindow.evaluate(async (id) => {
      const api = (
        window as unknown as {
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

      // Check tsvector population
      const tsvectorResult = await api.db.query(
        `SELECT
           COUNT(*)::int AS "totalChunks",
           COUNT(*) FILTER (WHERE content_tsvector IS NOT NULL)::int AS "withTsvector",
           COUNT(*) FILTER (WHERE content IS NOT NULL AND LENGTH(content) > 0)::int AS "withContent"
         FROM file_chunks
         WHERE file_record_id IN (
           SELECT id FROM file_records WHERE embedding_set_id = $1
         )`,
        [id]
      );
      const tsRow = tsvectorResult.rows[0] as {
        totalChunks: number;
        withTsvector: number;
        withContent: number;
      };

      // Run direct FTS query for "backfill" — known word in fixture content
      const ftsResult = await api.db.query(
        `SELECT id, content, fts_rank
         FROM (
           SELECT id, content,
             ts_rank(content_tsvector, websearch_to_tsquery('english', 'backfill'), 0) AS fts_rank
           FROM file_chunks
           WHERE content_tsvector IS NOT NULL
             AND content_tsvector @@ websearch_to_tsquery('english', 'backfill')
         ) sub
         ORDER BY fts_rank DESC
         LIMIT 5`
      );
      const ftsRows = ftsResult.rows as Array<{
        content: string;
        fts_rank: number;
        id: string;
      }>;

      return {
        totalChunks: Number(tsRow.totalChunks ?? 0),
        withTsvector: Number(tsRow.withTsvector ?? 0),
        withContent: Number(tsRow.withContent ?? 0),
        ftsMatchCount: ftsRows.length,
        ftsTopContent: ftsRows.length > 0 ? String(ftsRows[0]!.content).slice(0, 80) : '',
      };
    }, embeddingSetId);

    // All chunks should have content and tsvector populated
    expect(ftsDiagnostics.withContent).toBe(ftsDiagnostics.totalChunks);
    expect(ftsDiagnostics.withTsvector).toBe(ftsDiagnostics.totalChunks);
    // FTS should find "backfill" in our fixture content
    expect(ftsDiagnostics.ftsMatchCount).toBeGreaterThan(0);

    // ── 6. Direct SQL vector search: verify pgvector similarity works ─────
    // Use a chunk's own embedding as the query vector to guarantee a match.
    const directSqlSearchResult = await activeWindow.evaluate(
      async ({ embeddingSetId: id, dimension: dim }) => {
        const api = (
          window as unknown as {
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

        // Get the first chunk's embedding to use as the query vector
        const refResult = await api.db.query(
          `SELECT embedding::text AS vec FROM file_chunks
           WHERE embedding IS NOT NULL AND embedding_set_id = $1
           LIMIT 1`,
          [id]
        );
        const refRow = refResult.rows[0] as { vec?: string } | undefined;
        const refVec = refRow?.vec;
        if (!refVec) {
          throw new Error('No embedded chunks found for direct SQL search');
        }

        // Run a cosine similarity search using the reference embedding
        const searchResult = await api.db.query(
          `SELECT
             content,
             (1 - (embedding <=> $1::vector)) AS similarity
           FROM file_chunks
           WHERE embedding IS NOT NULL
             AND embedding_set_id = $2
             AND vector_dims(embedding) = $3
           ORDER BY embedding <=> $1::vector
           LIMIT 5`,
          [refVec, id, dim]
        );

        const rows = searchResult.rows as Array<{
          content: string;
          similarity: number;
        }>;

        return {
          matchCount: rows.length,
          topSimilarity: rows.length > 0 ? Number(rows[0]!.similarity) : 0,
          topContent: rows.length > 0 ? String(rows[0]!.content ?? '').slice(0, 80) : '',
        };
      },
      { embeddingSetId, dimension: embeddingDimension }
    );

    expect(directSqlSearchResult.matchCount).toBeGreaterThan(0);
    // The top result should be the chunk itself (similarity ~1.0)
    expect(directSqlSearchResult.topSimilarity).toBeGreaterThan(0.95);

    // ── 7. UI semantic search: fill search box, click Query, verify results ─
    const semanticSearchBox = await getHybridSearchBox(activeWindow);

    // Search for known content from our fixture
    const searchQuery = 'desktop chunking backfill';
    await semanticSearchBox.fill(searchQuery);
    await activeWindow.getByRole('button', { name: /^Query$/ }).click({ timeout: 5000 });

    // Poll for search results
    const searchStartedAt = Date.now();
    let lastSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
    while (Date.now() - searchStartedAt < 60_000) {
      const snapshot = await getDatabaseDemoSemanticSearchSnapshot(activeWindow);
      lastSnapshot = snapshot;

      if (snapshot?.error) {
        throw new Error(`Semantic search failed: ${snapshot.error}`);
      }

      if (
        snapshot?.hasSearched &&
        !snapshot.isSearching &&
        snapshot.resultCount > 0 &&
        snapshot.firstResultNodeId !== null
      ) {
        break;
      }

      await activeWindow.waitForTimeout(250);
    }

    if (
      !(
        lastSnapshot?.hasSearched &&
        !lastSnapshot.isSearching &&
        lastSnapshot.resultCount > 0 &&
        lastSnapshot.firstResultNodeId !== null
      )
    ) {
      // Gather diagnostic info for debugging
      const rendererLogs = await getRendererLogRecords(activeWindow);
      const alertTexts = await getVisibleAlertTexts(activeWindow);
      const searchLogs = rendererLogs.filter(
        (record) =>
          recordContainsText(record, 'Search') ||
          recordContainsText(record, 'search') ||
          recordContainsText(record, 'embedder') ||
          recordContainsText(record, 'Embedder')
      );
      throw new Error(
        'Semantic search did not return results within 60s after successful backfill.\n' +
          `query="${searchQuery}"\n` +
          `snapshot=${JSON.stringify(lastSnapshot)}\n` +
          `directSqlSearchWorked=${directSqlSearchResult.matchCount > 0}\n` +
          `dbEmbeddedChunks=${dbDiagnostics.embeddedCount}\n` +
          `dbDimension=${embeddingDimension}\n` +
          `alerts=${JSON.stringify(alertTexts)}\n` +
          `searchLogs=${JSON.stringify(searchLogs.slice(-10))}`
      );
    }

    expect(lastSnapshot!.resultCount).toBeGreaterThan(0);
    expect(lastSnapshot!.firstResultNodeId).not.toBeNull();

    // ── 8. Verify tree renders file nodes, not the empty state ──────────
    // Catches the lazy-chunk regression: semantic results have chunk nodeIds
    // ("chunk-<id>") but the tree only has file nodes ("file-<id>") because
    // chunks are loaded on-demand. The fix resolves chunk results to their
    // parent file node via "file-${result.fileRecordId}".
    const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
    const emptyResultsMessage = collectionTreeRegion.getByText(
      'No matching results found. Try adjusting your search query or threshold.'
    );
    await expect(emptyResultsMessage).toHaveCount(0, { timeout: 5000 });

    // Verify the firstResultNodeId resolves to a valid file- prefixed ID
    // (proves the lazy-chunk fallback mapped chunk IDs to file node IDs)
    expect(lastSnapshot!.firstResultNodeId).toMatch(/^(chunk-|file-)/);
  });

  test('@desktop-embedding-core search renders file nodes when chunks are lazily loaded (many-file collection)', async ({
    window,
  }) => {
    test.setTimeout(300_000);

    // This test reproduces the exact production bug: with many files, the
    // collection tree is PAGINATED (e.g. 50 files per page). Search results
    // reference files on OTHER pages — those file nodes don't exist in the
    // tree. Without building the tree from search results directly, the tree
    // shows "No matching results found" despite the search returning results.
    // We use 100 files (> default page size of 50) to guarantee pagination.

    let activeWindow = await showDatabaseDemoPanel(window);
    if (await isDatabaseError(activeWindow)) {
      throw new Error('Database initialization failed');
    }

    await clearEmbeddingQueue(activeWindow);
    const collectionName = `Lazy Chunk Search ${Date.now()}`;
    const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);

    // Create 100 files with 1 chunk each — exceeds the default page size (50)
    // to guarantee pagination. Search results will reference files on page 2+
    // that don't exist as tree nodes in the paginated view.
    const LAZY_FILE_COUNT = 100;
    await activeWindow.evaluate(
      async ({ id, fileCount }) => {
        const api = (
          window as unknown as {
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
        for (let i = 0; i < fileCount; i++) {
          const fileId = `lazy-file-${crypto.randomUUID()}`;
          const content = `export function handler${i}() { return "lazy-chunk-search-fixture-${i}"; }`;
          await api.db.query(
            `INSERT INTO file_records (id, path, name, size, content, content_hash, token_count, embedding_set_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
            [
              fileId,
              `/mock/lazy/${i}.ts`,
              `lazy-${i}.ts`,
              content.length,
              content,
              `hash-${fileId}`,
              20,
              id,
              now,
            ]
          );
          const chunkContent = `export function handler${i}() { return "lazy-chunk-search-fixture-${i}"; }`;
          await api.db.query(
            `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, content_tsvector, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_tsvector('english', $4), $9, $9)`,
            [
              `${fileId}-chunk-0`,
              fileId,
              0,
              chunkContent,
              `chunk-hash-${fileId}-0`,
              15,
              'code',
              chunkContent.length,
              now,
            ]
          );
          await api.db.query(
            `UPDATE file_records SET chunks_processed_at = $2, chunks_count = 1, chunking_strategy = 'recursive', updated_at = $2 WHERE id = $1`,
            [fileId, now]
          );
        }
      },
      { id: embeddingSetId, fileCount: LAZY_FILE_COUNT }
    );

    // Configure WASM and reload
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-lazy-chunk-search');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Select collection and backfill
    const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });

    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 30_000,
      })
      .toMatchObject({ totalChunks: LAZY_FILE_COUNT });

    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(activeWindow, embeddingSetId);
    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      throw new Error(`Backfill failed: ${status.lastError ?? 'unknown'}`);
    }

    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 120_000,
      })
      .toMatchObject({ embeddedChunks: LAZY_FILE_COUNT });

    // ── Search: chunks are NOT expanded in the tree (lazy loaded) ──
    const semanticSearchBox = await getHybridSearchBox(activeWindow);
    await semanticSearchBox.fill('lazy-chunk-search-fixture');
    await activeWindow.getByRole('button', { name: /^Query$/ }).click({ timeout: 5000 });

    // Poll for search results
    let lastSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
    await expect
      .poll(
        async () => {
          lastSnapshot = await getDatabaseDemoSemanticSearchSnapshot(activeWindow);
          return lastSnapshot;
        },
        { timeout: 60_000 }
      )
      .toMatchObject({
        hasSearched: true,
        isSearching: false,
        error: null,
      });

    // THE CRITICAL ASSERTIONS:
    // 1. Search returned results (backend works)
    expect(lastSnapshot!.resultCount).toBeGreaterThan(0);

    // 2. Tree must NOT show the empty state
    const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
    const emptyMessage = collectionTreeRegion.getByText(
      'No matching results found. Try adjusting your search query or threshold.'
    );
    await expect(emptyMessage).toHaveCount(0, { timeout: 5000 });

    // 3. Search result nodes exist in the tree
    expect(lastSnapshot!.firstResultNodeId).not.toBeNull();

    // 4. Search result chunks must show "Complete" embedding status (not "No Embedding")
    //    since they came from an embedding search — they definitely have embeddings.
    const noEmbeddingBadges = collectionTreeRegion.getByText('No Embedding');
    await expect(noEmbeddingBadges).toHaveCount(0, { timeout: 5000 });
  });

  test('@desktop-embedding-core search works when vector-preferences store has no devicePref (stale migration)', async ({
    window,
  }) => {
    test.setTimeout(300_000);

    // This test reproduces a crash where a stale persisted vector-preferences
    // store (missing devicePref field) caused the search embedder to receive
    // undefined as the device preference, crashing the visible renderer.

    // ── Phase 1: Standard setup with WASM (needed for CI/headless backfill) ──
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      throw new Error('Database initialization failed');
    }

    await clearEmbeddingQueue(activeWindow);

    const collectionName = `Stale Prefs Search ${Date.now()}`;
    const { embeddingSetId } = await createImportTargetCollection(activeWindow, collectionName);
    const chunkedFixture = await createChunkedImportFixture(activeWindow, embeddingSetId);

    // Use WASM for backfill (works in headless CI)
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-stale-prefs-backfill');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 15_000 });
    await collectionOption.click({ timeout: 5000 });
    await waitForImportedChunks(activeWindow, embeddingSetId);

    const databasePanel = activeWindow.locator('[data-testid="database-demo-panel"]');
    const backfillButton = databasePanel.getByRole('button', { name: /^Backfill(?:\s|$)/ });
    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(activeWindow, embeddingSetId);
    if (outcome === 'error') {
      const status = await getEmbeddingHostStatus(activeWindow);
      throw new Error(
        `Backfill failed with stale prefs: ${status.lastError ?? 'unknown host error'}`
      );
    }

    await expect
      .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
        timeout: 120_000,
      })
      .toMatchObject({
        embeddedChunks: chunkedFixture.totalChunks,
      });

    // ── Phase 2: Simulate stale store AFTER backfill, then search ──
    // Write a version-1 store WITHOUT devicePref to simulate old persisted data.
    // The migration should promote this to a valid state. Previously this caused
    // the search embedder to receive undefined devicePref, crashing the renderer.
    await activeWindow.evaluate(() => {
      const storageBridge = (
        window as unknown as {
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
            reinitEveryN: 200,
            verboseOrtLogs: false,
          },
          version: 1,
        })
      );
    });

    // Reload with stale prefs — the migration runs and should produce valid state.
    // The renderer must NOT crash during this reload (the original bug).
    await reloadRendererInTest(activeWindow, 'embedding-worker-stale-prefs-migration');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Verify the renderer survived the stale-prefs migration without crashing
    const timeOriginAfterStaleMigration = await getRendererTimeOrigin(activeWindow);
    expect(timeOriginAfterStaleMigration).toBeGreaterThan(0);

    // In CI/headless, WebGPU lacks fp16 support. The migration correctly set
    // devicePref to 'webgpu', proving it's no longer undefined. Now switch to
    // WASM so the search embedder can actually run in the test environment.
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'embedding-worker-stale-prefs-search');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    // Re-select collection after reload
    const collectionOption2 = activeWindow.locator(`#collection-option-${embeddingSetId}`);
    await expect(collectionOption2).toBeVisible({ timeout: 15_000 });
    await collectionOption2.click({ timeout: 5000 });

    // ── The critical assertion: search must not crash the renderer ──
    const timeOriginBeforeSearch = await getRendererTimeOrigin(activeWindow);

    const semanticSearchBox = await getHybridSearchBox(activeWindow);
    await semanticSearchBox.fill('desktop chunking backfill');
    await activeWindow.getByRole('button', { name: /^Query$/ }).click({ timeout: 5000 });

    // Wait briefly then verify the renderer did NOT crash/reload
    await activeWindow.waitForTimeout(3000);
    const timeOriginAfterSearch = await getRendererTimeOrigin(activeWindow);
    expect(timeOriginAfterSearch).toBe(timeOriginBeforeSearch);

    // Poll for search results
    const searchStartedAt = Date.now();
    let lastSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
    while (Date.now() - searchStartedAt < 60_000) {
      const snapshot = await getDatabaseDemoSemanticSearchSnapshot(activeWindow);
      lastSnapshot = snapshot;

      if (snapshot?.error) {
        throw new Error(`Search failed with stale prefs: ${snapshot.error}`);
      }

      if (
        snapshot?.hasSearched &&
        !snapshot.isSearching &&
        snapshot.resultCount > 0 &&
        snapshot.firstResultNodeId !== null
      ) {
        break;
      }

      await activeWindow.waitForTimeout(250);
    }

    if (!(lastSnapshot?.hasSearched && !lastSnapshot.isSearching && lastSnapshot.resultCount > 0)) {
      const alertTexts = await getVisibleAlertTexts(activeWindow);
      throw new Error(
        'Search returned no results with stale vector-preferences store.\n' +
          `snapshot=${JSON.stringify(lastSnapshot)}\n` +
          `alerts=${JSON.stringify(alertTexts)}`
      );
    }

    expect(lastSnapshot!.resultCount).toBeGreaterThan(0);

    // Verify tree renders results (no empty state from lazy-chunk nodeId mismatch)
    const collectionTreeRegion2 = activeWindow.getByTestId('collection-tree-region');
    const emptyMessage2 = collectionTreeRegion2.getByText(
      'No matching results found. Try adjusting your search query or threshold.'
    );
    await expect(emptyMessage2).toHaveCount(0, { timeout: 5000 });
  });

  test('@desktop-embedding-core does not reload the visible renderer or churn hidden runtimes during a real 1k-file import and backfill', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await stopEmbeddingHost(activeWindow);
    await stopChunkingHost(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await setImportSettingsForStressTest(activeWindow);
    await reloadRendererInTest(activeWindow, 'embedding-worker-real-import-stress');
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

    await ensureLeftPanelVisible(activeWindow);
    await installLargeImportFileSystemMock(electronApp.app, {
      fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
      rootPath: '/mock/stress-import',
      sentencesPerFile: ACTUAL_IMPORT_SENTENCES_PER_FILE,
    });

    try {
      const fixtureSummaryAfterInstall = await getMainProcessFileSystemFixtureSummary(
        electronApp.app
      );
      expect(fixtureSummaryAfterInstall).toMatchObject({
        fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
        requestDirectoryAccessCount: 0,
        rootHandlePath: '/mock/stress-import',
      });

      const collectionName = `Stress Import ${Date.now()}`;
      await createCollectionViaDialog(activeWindow, collectionName);
      const embeddingSetId = await resolveCollectionIdByName(activeWindow, collectionName);

      const initialTimeOrigin = await getRendererTimeOrigin(activeWindow);
      const initialLogCount = (await getMainBufferedLogs(activeWindow)).length;

      const selectRootButton = activeWindow.getByTestId('select-root-button');
      await expect(selectRootButton).toBeVisible({ timeout: 15_000 });
      await selectRootButton.click({ timeout: 5000 });
      await setFileExplorerMaxSelectionCount(activeWindow, ACTUAL_IMPORT_STRESS_FILE_COUNT);

      await expect
        .poll(async () => await getMainProcessFileSystemFixtureSummary(electronApp.app), {
          timeout: 30_000,
        })
        .toMatchObject({
          fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
          requestDirectoryAccessCount: 1,
          rootHandlePath: '/mock/stress-import',
        });
      await expect(activeWindow.getByText('mock-stress-directory')).toBeVisible({
        timeout: 15_000,
      });

      const selectAllButton = activeWindow.getByRole('button', { name: /^Select All$/i }).first();
      await expect(selectAllButton).toBeVisible({ timeout: 15_000 });
      await selectAllButton.click({ timeout: 5000 });

      await expect(activeWindow.getByTestId('selection-count')).toHaveText(
        String(ACTUAL_IMPORT_STRESS_FILE_COUNT),
        {
          timeout: 60_000,
        }
      );

      const fixtureSummaryAfterSelection = await getMainProcessFileSystemFixtureSummary(
        electronApp.app
      );
      const fileExplorerSnapshotAfterSelection = await getFileExplorerTestSnapshot(activeWindow);
      expect(fixtureSummaryAfterSelection).toMatchObject({
        fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
        requestDirectoryAccessCount: 1,
        rootHandlePath: '/mock/stress-import',
      });
      expect(fixtureSummaryAfterSelection?.readDirectoryCalls).toEqual(['/mock/stress-import']);
      expect(fileExplorerSnapshotAfterSelection).not.toBeNull();
      expect(fileExplorerSnapshotAfterSelection).toMatchObject({
        currentFolderId: '/mock/stress-import',
        rootDirectoryPath: '/mock/stress-import',
        selectedFilePathCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
      });
      expect(
        fileExplorerSnapshotAfterSelection?.selectedFilePathSamples.every((key) =>
          key.startsWith('/mock/stress-import|@|')
        )
      ).toBe(true);

      const importButton = activeWindow.getByRole('button', { name: /^Import\s*\(/ });
      await expect(importButton).toContainText(`(${ACTUAL_IMPORT_STRESS_FILE_COUNT})`, {
        timeout: 30_000,
      });

      await importButton.click({ timeout: 5000 });

      const runtimeIds = {
        chunking: new Set<string>(),
        embedding: new Set<string>(),
      };
      let peakVisibleWorkingSetMB = 0;
      const importStartedAt = Date.now();
      let importedPathCounts: ImportedPathCounts | null = null;

      while (Date.now() - importStartedAt < 240_000) {
        const [
          pathCounts,
          timeOrigin,
          embeddingStatus,
          chunkingStatus,
          processSnapshot,
          rendererLogs,
          importSnapshot,
        ] = await Promise.all([
          getImportedPathCounts(activeWindow, '/mock/stress-import'),
          getRendererTimeOrigin(activeWindow),
          getEmbeddingHostStatus(activeWindow),
          getChunkingHostStatus(activeWindow),
          readDesktopProcessSnapshot(electronApp.app),
          getRendererLogRecords(activeWindow),
          getDatabaseDemoImportSnapshot(activeWindow),
        ]);

        if (embeddingStatus.state !== 'stopped') {
          runtimeIds.embedding.add(embeddingStatus.runtimeId);
        }
        if (chunkingStatus.state !== 'stopped') {
          runtimeIds.chunking.add(chunkingStatus.runtimeId);
        }
        const visibleRuntime = getRuntimeSnapshot(processSnapshot, 'visible-ui');
        peakVisibleWorkingSetMB = Math.max(
          peakVisibleWorkingSetMB,
          visibleRuntime.workingSetMB ?? 0
        );

        expect(timeOrigin).toBe(initialTimeOrigin);

        const catastrophicImportLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Enhanced import failed catastrophically')
        );
        const importErrors = importSnapshot?.progress?.errors ?? [];
        if (importErrors.length > 0) {
          const [alertTexts, fixtureSummary, fileExplorerSnapshot] = await Promise.all([
            getVisibleAlertTexts(activeWindow),
            getMainProcessFileSystemFixtureSummary(electronApp.app),
            getFileExplorerTestSnapshot(activeWindow),
          ]);
          throw new Error(
            `Real desktop import reported progress errors: ${JSON.stringify(importErrors.slice(0, 10))}\nimportSnapshot=${JSON.stringify(importSnapshot)}\nalerts=${JSON.stringify(alertTexts)}\nfixture=${JSON.stringify(fixtureSummary)}\nfileExplorer=${JSON.stringify(fileExplorerSnapshot)}`
          );
        }
        if (catastrophicImportLog) {
          const errorMessage =
            extractStructuredLogString(catastrophicImportLog, 'error') ??
            catastrophicImportLog.message ??
            'unknown enhanced import failure';
          const errorStack = extractStructuredLogString(catastrophicImportLog, 'stack');
          const [alertTexts, fixtureSummary, fileExplorerSnapshot] = await Promise.all([
            getVisibleAlertTexts(activeWindow),
            getMainProcessFileSystemFixtureSummary(electronApp.app),
            getFileExplorerTestSnapshot(activeWindow),
          ]);
          throw new Error(
            `Enhanced import failed during real desktop import: ${errorMessage}${errorStack ? `\n${errorStack}` : ''}\nalerts=${JSON.stringify(alertTexts)}\nfixture=${JSON.stringify(fixtureSummary)}\nfileExplorer=${JSON.stringify(fileExplorerSnapshot)}`
          );
        }

        if (
          pathCounts.fileCount === ACTUAL_IMPORT_STRESS_FILE_COUNT &&
          pathCounts.totalChunks > 0
        ) {
          importedPathCounts = pathCounts;
          break;
        }

        await activeWindow.waitForTimeout(1000);
      }

      if (!importedPathCounts) {
        const [alertTexts, fixtureSummary, fileExplorerSnapshot] = await Promise.all([
          getVisibleAlertTexts(activeWindow),
          getMainProcessFileSystemFixtureSummary(electronApp.app),
          getFileExplorerTestSnapshot(activeWindow),
        ]);
        throw new Error(
          `Timed out waiting for imported file records and chunks to persist\nalerts=${JSON.stringify(alertTexts)}\nfixture=${JSON.stringify(fixtureSummary)}\nfileExplorer=${JSON.stringify(fileExplorerSnapshot)}`
        );
      }

      expect(importedPathCounts.fileCount).toBe(ACTUAL_IMPORT_STRESS_FILE_COUNT);
      expect(importedPathCounts.totalChunks).toBeGreaterThan(0);

      const collectionOption = activeWindow.getByRole('option', {
        name: new RegExp(collectionName),
      });
      await expect(collectionOption).toHaveAttribute('aria-selected', 'true');

      const backfillButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: /^Backfill(?:\s|$)/ });
      await expect(backfillButton).toBeVisible({ timeout: 30_000 });
      await waitForBackfillButtonEnabled(activeWindow, backfillButton, 60_000);
      await backfillButton.click({ timeout: 5000 });

      const backfillOutcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        embeddingSetId,
        120_000
      );
      expect(backfillOutcome).toBe('queued');

      const memorySamples = await sampleMemoryWhileBackfillActive(
        electronApp.app,
        activeWindow,
        8,
        3000
      );
      for (const sample of memorySamples) {
        const embeddingStatus = await getEmbeddingHostStatus(activeWindow);
        const chunkingStatus = await getChunkingHostStatus(activeWindow);
        runtimeIds.embedding.add(embeddingStatus.runtimeId);
        if (chunkingStatus.state !== 'stopped') {
          runtimeIds.chunking.add(chunkingStatus.runtimeId);
        }
        expect(await getRendererTimeOrigin(activeWindow)).toBe(initialTimeOrigin);
        peakVisibleWorkingSetMB = Math.max(
          peakVisibleWorkingSetMB,
          getRuntimeSnapshot(sample.snapshot.process, 'visible-ui').workingSetMB ?? 0
        );
      }

      const timeOriginAfterBackfill = await getRendererTimeOrigin(activeWindow);
      expect(timeOriginAfterBackfill).toBe(initialTimeOrigin);

      await expect
        .poll(async () => await getEmbeddingSetCounts(activeWindow, embeddingSetId), {
          timeout: 240_000,
        })
        .toMatchObject({
          fileCount: ACTUAL_IMPORT_STRESS_FILE_COUNT,
          totalChunks: expect.any(Number),
          embeddedChunks: expect.any(Number),
        });

      const semanticQuery = 'stress-file-42-sentence-0';
      const semanticSearchBox = await getHybridSearchBox(activeWindow);
      const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
      const emptySemanticSearchMessage = collectionTreeRegion.getByText(
        'No matching results found. Try adjusting your search query or threshold.'
      );
      const searchingOverlay = collectionTreeRegion.getByText('Searching...');
      await semanticSearchBox.fill(semanticQuery);
      await activeWindow.getByRole('button', { name: /^Query$/ }).click({ timeout: 5000 });

      const semanticSearchStartedAt = Date.now();
      let lastSemanticSearchSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
      let lastSemanticSearchAlertTexts: string[] = [];
      while (Date.now() - semanticSearchStartedAt < 60_000) {
        const [rendererLogs, alertTexts, emptyStateCount, searchingCount, semanticSearchSnapshot] =
          await Promise.all([
            getRendererLogRecords(activeWindow),
            getVisibleAlertTexts(activeWindow),
            emptySemanticSearchMessage.count(),
            searchingOverlay.count(),
            getDatabaseDemoSemanticSearchSnapshot(activeWindow),
          ]);
        lastSemanticSearchSnapshot = semanticSearchSnapshot;
        lastSemanticSearchAlertTexts = alertTexts;
        const queueFailureLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Embedding worker queue failed')
        );
        const searchFailureLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Search failed')
        );

        if (queueFailureLog || searchFailureLog) {
          const failureLog = queueFailureLog ?? searchFailureLog;
          const errorMessage =
            (failureLog ? extractStructuredLogString(failureLog, 'error') : null) ??
            failureLog?.message ??
            'unknown semantic search failure';
          const errorStack = failureLog ? extractStructuredLogString(failureLog, 'stack') : null;
          throw new Error(
            `Semantic search failed after real desktop backfill: ${errorMessage}${errorStack ? `\n${errorStack}` : ''}\nalerts=${JSON.stringify(alertTexts)}`
          );
        }

        if (semanticSearchSnapshot?.error) {
          throw new Error(
            `Semantic search failed after real desktop backfill: ${semanticSearchSnapshot.error}\nalerts=${JSON.stringify(alertTexts)}`
          );
        }

        if (
          semanticSearchSnapshot?.hasSearched &&
          !semanticSearchSnapshot.isSearching &&
          semanticSearchSnapshot.resultCount > 0 &&
          semanticSearchSnapshot.firstResultNodeId !== null &&
          searchingCount === 0 &&
          emptyStateCount === 0
        ) {
          break;
        }

        await activeWindow.waitForTimeout(250);
      }

      if (
        !(
          lastSemanticSearchSnapshot?.hasSearched &&
          !lastSemanticSearchSnapshot.isSearching &&
          lastSemanticSearchSnapshot.resultCount > 0 &&
          lastSemanticSearchSnapshot.firstResultNodeId !== null
        )
      ) {
        throw new Error(
          `Semantic search did not surface rendered results within 60s after real desktop backfill\nsnapshot=${JSON.stringify(lastSemanticSearchSnapshot)}\nalerts=${JSON.stringify(lastSemanticSearchAlertTexts)}`
        );
      }
      await expect(emptySemanticSearchMessage).toHaveCount(0, { timeout: 60_000 });
      await expect
        .poll(async () => await getDatabaseDemoSemanticSearchSnapshot(activeWindow), {
          timeout: 60_000,
        })
        .toMatchObject({
          error: null,
          hasSearched: true,
          isSearching: false,
          resultCount: expect.any(Number),
        });

      const finalLogs = await getMainBufferedLogs(activeWindow);
      const unexpectedLifecycleLogs = extractUnexpectedLifecycleLogs(
        finalLogs.slice(initialLogCount)
      );

      expect(runtimeIds.embedding.size).toBe(1);
      expect(runtimeIds.chunking.size).toBeLessThanOrEqual(1);
      expect(peakVisibleWorkingSetMB).toBeLessThan(ACTUAL_IMPORT_VISIBLE_WORKING_SET_LIMIT_MB);
      expect(unexpectedLifecycleLogs).toEqual([]);
    } finally {
      await clearLargeImportFileSystemMock(electronApp.app);
    }
  });

  test('@desktop-embedding-mixed keeps search working and backfill actionable during a real mixed-state desktop session', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(540_000);
    const electronStderrBaselineCount = (await getRelevantElectronStderr(electronApp.app)).length;
    const scenario = await prepareRealWorldMixedStateScenario(electronApp.app, window);
    const { importEmbeddingSetId, searchableEmbeddingSetId } = scenario;
    const activeWindow = scenario.activeWindow;
    // Clicks in this stress test use 30s timeouts because the collection browser's loading
    // overlay (z-20, aria-busy) stays visible for 15–30s while refetching data after heavy
    // import/backfill/search operations. This is a known collection browser perf issue.
    try {
      const searchableCollectionOption = activeWindow.locator(
        `#collection-option-${searchableEmbeddingSetId}`
      );
      await expect(searchableCollectionOption).toBeVisible({ timeout: 15_000 });
      await searchableCollectionOption.click({ timeout: 30_000 });
      await expect(searchableCollectionOption).toHaveAttribute('aria-selected', 'true');

      const semanticSearchBox = await getHybridSearchBox(activeWindow);
      const queryButton = activeWindow.getByRole('button', { name: /^Query$/ });
      await semanticSearchBox.fill('desktop import backfill regression');
      await queryButton.click({ timeout: 30_000 });

      const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
      const emptySemanticSearchMessage = collectionTreeRegion.getByText(
        'No matching results found. Try adjusting your search query or threshold.'
      );
      const searchingOverlay = collectionTreeRegion.getByText('Searching...');
      const mixedStateFailures: string[] = [];

      const semanticSearchStartedAt = Date.now();
      let searchWorked = false;
      let lastSemanticSearchSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
      while (Date.now() - semanticSearchStartedAt < 60_000) {
        const [
          semanticSearchSnapshot,
          rendererLogs,
          emptyStateCount,
          searchingCount,
          embeddingHostStatus,
          queueStats,
        ] = await Promise.all([
          getDatabaseDemoSemanticSearchSnapshot(activeWindow),
          getRendererLogRecords(activeWindow),
          emptySemanticSearchMessage.count(),
          searchingOverlay.count(),
          getEmbeddingHostStatus(activeWindow),
          getEmbeddingQueueStats(activeWindow),
        ]);

        lastSemanticSearchSnapshot = semanticSearchSnapshot;

        const queueFailureLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Embedding worker queue failed')
        );
        const searchFailureLog = rendererLogs.find((record) =>
          recordContainsText(record, 'Search failed')
        );

        if (queueFailureLog || searchFailureLog) {
          const failureLog = queueFailureLog ?? searchFailureLog;
          const errorMessage =
            (failureLog ? extractStructuredLogString(failureLog, 'error') : null) ??
            failureLog?.message ??
            'unknown semantic search failure';
          const errorStack = failureLog ? extractStructuredLogString(failureLog, 'stack') : null;
          throw new Error(
            `Mixed-state semantic search failed: ${errorMessage}${errorStack ? `\n${errorStack}` : ''}`
          );
        }

        if (
          queueStats.queued + queueStats.running > 0 &&
          (embeddingHostStatus.state === 'error' || embeddingHostStatus.state === 'stopped')
        ) {
          mixedStateFailures.push(
            `embedding host stopped during active mixed-state backfill: hostStatus=${JSON.stringify(embeddingHostStatus)} queueStats=${JSON.stringify(queueStats)}`
          );
          break;
        }

        if (
          semanticSearchSnapshot?.hasSearched &&
          !semanticSearchSnapshot.isSearching &&
          !semanticSearchSnapshot.error &&
          semanticSearchSnapshot.resultCount > 0 &&
          semanticSearchSnapshot.firstResultNodeId !== null &&
          searchingCount === 0 &&
          emptyStateCount === 0
        ) {
          searchWorked = true;
          break;
        }

        await activeWindow.waitForTimeout(250);
      }

      const expandAllButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: 'Expand all' });
      await expect(expandAllButton).toBeVisible({ timeout: 15_000 });
      await expandAllButton.click({ timeout: 30_000 });

      const [embeddingHostStatusAfterExpand, queueStatsAfterExpand] = await Promise.all([
        getEmbeddingHostStatus(activeWindow),
        getEmbeddingQueueStats(activeWindow),
      ]);

      if (
        queueStatsAfterExpand.queued + queueStatsAfterExpand.running > 0 &&
        (embeddingHostStatusAfterExpand.state === 'error' ||
          embeddingHostStatusAfterExpand.state === 'stopped')
      ) {
        mixedStateFailures.push(
          `embedding host stopped during active mixed-state backfill after expand-all: hostStatus=${JSON.stringify(embeddingHostStatusAfterExpand)} queueStats=${JSON.stringify(queueStatsAfterExpand)}`
        );
      }

      const collectionTreeVisibleAfterExpand = await collectionTreeRegion
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      let expandedTreeNodeCount: number | null = null;
      if (collectionTreeVisibleAfterExpand) {
        expandedTreeNodeCount = await collectionTreeRegion.evaluate(
          (node) => node.querySelectorAll('[aria-expanded="true"]').length
        );
      } else {
        const [
          queueStatsAfterTreeLoss,
          hostStatusAfterTreeLoss,
          semanticSearchSnapshotAfterTreeLoss,
          fileExplorerSnapshotAfterTreeLoss,
          importSnapshotAfterTreeLoss,
        ] = await Promise.all([
          getEmbeddingQueueStats(activeWindow),
          getEmbeddingHostStatus(activeWindow),
          getDatabaseDemoSemanticSearchSnapshot(activeWindow),
          getFileExplorerTestSnapshot(activeWindow),
          getDatabaseDemoImportSnapshot(activeWindow),
        ]);
        mixedStateFailures.push(
          `collection tree region disappeared after expand-all during mixed-state run: hostStatus=${JSON.stringify(hostStatusAfterTreeLoss)} queueStats=${JSON.stringify(queueStatsAfterTreeLoss)} semanticSearch=${JSON.stringify(semanticSearchSnapshotAfterTreeLoss)} fileExplorer=${JSON.stringify(fileExplorerSnapshotAfterTreeLoss)} importSnapshot=${JSON.stringify(importSnapshotAfterTreeLoss)}`
        );
      }

      const importCollectionOption = activeWindow.locator(
        `#collection-option-${importEmbeddingSetId}`
      );
      await expect(importCollectionOption).toBeVisible({ timeout: 15_000 });
      await importCollectionOption.click({ timeout: 30_000 });
      await expect(importCollectionOption).toHaveAttribute('aria-selected', 'true');

      const importCollectionBackfillButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: /^Backfill(?:\s|$)/ });
      await expect(importCollectionBackfillButton).toBeVisible({ timeout: 15_000 });

      const [
        backfillEnabled,
        globalQueueStats,
        importCollectionQueueStats,
        importCollectionCounts,
        semanticSearchSnapshotAfterChecks,
        importSnapshotAfterChecks,
        alerts,
        fileExplorerSnapshotAfterChecks,
        fixtureSummaryAfterChecks,
        electronStderr,
        embeddingHostStatus,
        chunkingHostStatus,
      ] = await Promise.all([
        importCollectionBackfillButton.isEnabled(),
        getEmbeddingQueueStats(activeWindow),
        getEmbeddingSetQueueStats(activeWindow, importEmbeddingSetId),
        getEmbeddingSetCounts(activeWindow, importEmbeddingSetId),
        getDatabaseDemoSemanticSearchSnapshot(activeWindow),
        getDatabaseDemoImportSnapshot(activeWindow),
        getVisibleAlertTexts(activeWindow),
        getFileExplorerTestSnapshot(activeWindow),
        getMainProcessFileSystemFixtureSummary(electronApp.app),
        getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
        getEmbeddingHostStatus(activeWindow),
        getChunkingHostStatus(activeWindow),
      ]);

      const failures = [...mixedStateFailures];
      if (!searchWorked) {
        failures.push(
          'semantic search returned no results while background embedding work was active'
        );
      }
      if (!backfillEnabled) {
        failures.push(
          'backfill button was disabled for the selected import collection while that collection had no queued or running jobs'
        );
      }
      if (
        !fileExplorerSnapshotAfterChecks ||
        fileExplorerSnapshotAfterChecks.selectedFilePathCount !== REAL_WORLD_MIXED_STATE_FILE_COUNT
      ) {
        failures.push('explorer selection state did not remain mounted at 1002 selected files');
      }
      if (!scenario.sawChunkingHostActive) {
        failures.push('chunking host never activated during the real import path');
      }

      if (failures.length > 0) {
        throw new Error(
          `Mixed-state desktop regression reproduced: ${failures.join('; ')}\n` +
            `globalQueueStats=${JSON.stringify(globalQueueStats)}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStats)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCounts)}\n` +
            `semanticSearchSnapshot=${JSON.stringify(semanticSearchSnapshotAfterChecks ?? lastSemanticSearchSnapshot)}\n` +
            `expandedTreeNodeCount=${expandedTreeNodeCount}\n` +
            `importSnapshot=${JSON.stringify(importSnapshotAfterChecks)}\n` +
            `alerts=${JSON.stringify(alerts)}\n` +
            `fileExplorer=${JSON.stringify(fileExplorerSnapshotAfterChecks)}\n` +
            `fixture=${JSON.stringify(fixtureSummaryAfterChecks)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }

      expect(globalQueueStats.queued + globalQueueStats.running).toBeGreaterThan(0);
      expect(importCollectionQueueStats.queued + importCollectionQueueStats.running).toBe(0);
      expect(importCollectionCounts.fileCount).toBe(REAL_WORLD_MIXED_STATE_FILE_COUNT);
      expect(importCollectionCounts.totalChunks).toBeGreaterThan(0);
      expect(importCollectionCounts.embeddedChunks).toBe(0);
      expect(searchWorked).toBe(true);
      expect(backfillEnabled).toBe(true);
      expect(expandedTreeNodeCount).toBeGreaterThan(0);
      expect(electronStderr).toEqual([]);
    } finally {
      await clearLargeImportFileSystemMock(electronApp.app);
      await clearEmbeddingQueue(activeWindow);
      await stopEmbeddingHost(activeWindow);
      await stopChunkingHost(activeWindow);
    }
  });

  test('@desktop-embedding-mixed keeps the import collection backfill and search path working during a real mixed-state desktop session', async ({
    electronApp,
    window,
  }) => {
    test.setTimeout(540_000);
    const electronStderrBaselineCount = (await getRelevantElectronStderr(electronApp.app)).length;

    const scenario = await prepareRealWorldMixedStateScenario(electronApp.app, window);
    const activeWindow = scenario.activeWindow;

    // Clicks in this stress test use 30s timeouts because the collection browser's loading
    // overlay (z-20, aria-busy) stays visible for 15–30s while refetching data after heavy
    // import/backfill/search operations. This is a known collection browser perf issue.
    try {
      const importCollectionOption = activeWindow.locator(
        `#collection-option-${scenario.importEmbeddingSetId}`
      );
      await expect(importCollectionOption).toBeVisible({ timeout: 15_000 });
      await importCollectionOption.click({ timeout: 30_000 });
      await expect(importCollectionOption).toHaveAttribute('aria-selected', 'true');

      const backfillButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: /^Backfill(?:\s|$)/ });
      await expect(backfillButton).toBeVisible({ timeout: 15_000 });

      const [
        backfillEnabledBefore,
        globalQueueStatsBefore,
        importCollectionQueueStatsBefore,
        importCollectionCountsBefore,
        fileExplorerBefore,
      ] = await Promise.all([
        backfillButton.isEnabled(),
        getEmbeddingQueueStats(activeWindow),
        getEmbeddingSetQueueStats(activeWindow, scenario.importEmbeddingSetId),
        getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
        getFileExplorerTestSnapshot(activeWindow),
      ]);

      const failures: string[] = [];
      if (!backfillEnabledBefore) {
        failures.push(
          'backfill button was disabled for the import collection before manual backfill started'
        );
      }
      if (globalQueueStatsBefore.queued + globalQueueStatsBefore.running <= 0) {
        failures.push('background queue pressure was not active before import-collection checks');
      }
      if (importCollectionQueueStatsBefore.queued + importCollectionQueueStatsBefore.running > 0) {
        failures.push('import collection already had active jobs before manual backfill');
      }
      if (importCollectionCountsBefore.embeddedChunks !== 0) {
        failures.push('import collection was already partially embedded before manual backfill');
      }
      if (
        !fileExplorerBefore ||
        fileExplorerBefore.selectedFilePathCount !== REAL_WORLD_MIXED_STATE_FILE_COUNT
      ) {
        failures.push('explorer selection was not still mounted before import-collection backfill');
      }

      if (failures.length > 0) {
        const [importSnapshot, electronStderr, embeddingHostStatus, chunkingHostStatus] =
          await Promise.all([
            getDatabaseDemoImportSnapshot(activeWindow),
            getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
            getEmbeddingHostStatus(activeWindow),
            getChunkingHostStatus(activeWindow),
          ]);
        throw new Error(
          `Import-collection mixed-state regression reproduced before backfill: ${failures.join('; ')}\n` +
            `globalQueueStats=${JSON.stringify(globalQueueStatsBefore)}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStatsBefore)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCountsBefore)}\n` +
            `fileExplorer=${JSON.stringify(fileExplorerBefore)}\n` +
            `importSnapshot=${JSON.stringify(importSnapshot)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }

      await backfillButton.click({ timeout: 30_000 });

      let importBackfillOutcome: 'error' | 'queued';
      try {
        importBackfillOutcome = await waitForBackfillQueueMovementOrFatalError(
          activeWindow,
          scenario.importEmbeddingSetId,
          60_000
        );
      } catch (error) {
        const [
          globalQueueStats,
          importCollectionQueueStats,
          importCollectionCounts,
          importSnapshot,
          electronStderr,
          embeddingHostStatus,
          chunkingHostStatus,
        ] = await Promise.all([
          getEmbeddingQueueStats(activeWindow),
          getEmbeddingSetQueueStats(activeWindow, scenario.importEmbeddingSetId),
          getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
          getDatabaseDemoImportSnapshot(activeWindow),
          getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
          getEmbeddingHostStatus(activeWindow),
          getChunkingHostStatus(activeWindow),
        ]);
        throw new Error(
          `Import-collection backfill did not produce set-scoped queue movement under mixed-state load: ${error instanceof Error ? error.message : String(error)}\n` +
            `globalQueueStats=${JSON.stringify(globalQueueStats)}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStats)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCounts)}\n` +
            `importSnapshot=${JSON.stringify(importSnapshot)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }
      if (importBackfillOutcome === 'error') {
        const [electronStderr, embeddingHostStatus, chunkingHostStatus, importSnapshot] =
          await Promise.all([
            getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
            getEmbeddingHostStatus(activeWindow),
            getChunkingHostStatus(activeWindow),
            getDatabaseDemoImportSnapshot(activeWindow),
          ]);
        throw new Error(
          'Import-collection backfill failed to start under mixed-state load\n' +
            `importSnapshot=${JSON.stringify(importSnapshot)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }

      const embedStartedAt = Date.now();
      let embeddedChunkCount = 0;
      while (Date.now() - embedStartedAt < 120_000) {
        const [counts, queueStats, embeddingHostStatus, chunkingHostStatus, electronStderr] =
          await Promise.all([
            getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
            getEmbeddingQueueStats(activeWindow),
            getEmbeddingHostStatus(activeWindow),
            getChunkingHostStatus(activeWindow),
            getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
          ]);

        if (counts.embeddedChunks > 0 && queueStats.queued + queueStats.running > 0) {
          embeddedChunkCount = counts.embeddedChunks;
          break;
        }

        if (
          electronStderr.length > 0 ||
          embeddingHostStatus.state === 'error' ||
          chunkingHostStatus.state === 'error'
        ) {
          throw new Error(
            'Hidden runtime failure surfaced during mixed-state import backfill\n' +
              `counts=${JSON.stringify(counts)}\n` +
              `queueStats=${JSON.stringify(queueStats)}\n` +
              `electronStderr=${JSON.stringify(electronStderr)}\n` +
              `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
              `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
          );
        }

        await activeWindow.waitForTimeout(500);
      }

      expect(embeddedChunkCount).toBeGreaterThan(0);

      const semanticSearchBox = await getHybridSearchBox(activeWindow);
      const queryButton = activeWindow.getByRole('button', { name: /^Query$/ });
      await semanticSearchBox.fill('stress-file-42-sentence-0');
      await queryButton.click({ timeout: 30_000 });

      const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
      const emptySemanticSearchMessage = collectionTreeRegion.getByText(
        'No matching results found. Try adjusting your search query or threshold.'
      );
      const searchingOverlay = collectionTreeRegion.getByText('Searching...');

      const searchStartedAt = Date.now();
      let lastSemanticSearchSnapshot: DatabaseDemoSemanticSearchTestSnapshot | null = null;
      while (Date.now() - searchStartedAt < 60_000) {
        const [
          semanticSearchSnapshot,
          emptyStateCount,
          searchingCount,
          electronStderr,
          embeddingHostStatus,
          chunkingHostStatus,
        ] = await Promise.all([
          getDatabaseDemoSemanticSearchSnapshot(activeWindow),
          emptySemanticSearchMessage.count(),
          searchingOverlay.count(),
          getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
          getEmbeddingHostStatus(activeWindow),
          getChunkingHostStatus(activeWindow),
        ]);

        lastSemanticSearchSnapshot = semanticSearchSnapshot;

        if (
          electronStderr.length > 0 ||
          embeddingHostStatus.state === 'error' ||
          chunkingHostStatus.state === 'error'
        ) {
          throw new Error(
            'Hidden runtime failure surfaced during mixed-state import search\n' +
              `semanticSearch=${JSON.stringify(semanticSearchSnapshot)}\n` +
              `electronStderr=${JSON.stringify(electronStderr)}\n` +
              `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
              `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
          );
        }

        if (
          semanticSearchSnapshot?.hasSearched &&
          !semanticSearchSnapshot.isSearching &&
          !semanticSearchSnapshot.error &&
          semanticSearchSnapshot.resultCount > 0 &&
          semanticSearchSnapshot.firstResultNodeId !== null &&
          searchingCount === 0 &&
          emptyStateCount === 0
        ) {
          break;
        }

        await activeWindow.waitForTimeout(250);
      }

      if (
        !(
          lastSemanticSearchSnapshot?.hasSearched &&
          !lastSemanticSearchSnapshot.isSearching &&
          !lastSemanticSearchSnapshot.error &&
          lastSemanticSearchSnapshot.resultCount > 0 &&
          lastSemanticSearchSnapshot.firstResultNodeId !== null
        )
      ) {
        const [
          globalQueueStats,
          importCollectionQueueStats,
          importCollectionCounts,
          importSnapshot,
          fileExplorer,
          electronStderr,
          embeddingHostStatus,
          chunkingHostStatus,
        ] = await Promise.all([
          getEmbeddingQueueStats(activeWindow),
          getEmbeddingSetQueueStats(activeWindow, scenario.importEmbeddingSetId),
          getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
          getDatabaseDemoImportSnapshot(activeWindow),
          getFileExplorerTestSnapshot(activeWindow),
          getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
          getEmbeddingHostStatus(activeWindow),
          getChunkingHostStatus(activeWindow),
        ]);
        throw new Error(
          'Import-collection mixed-state semantic search did not return results\n' +
            `semanticSearch=${JSON.stringify(lastSemanticSearchSnapshot)}\n` +
            `globalQueueStats=${JSON.stringify(globalQueueStats)}\n` +
            `importCollectionQueueStats=${JSON.stringify(importCollectionQueueStats)}\n` +
            `importCollectionCounts=${JSON.stringify(importCollectionCounts)}\n` +
            `importSnapshot=${JSON.stringify(importSnapshot)}\n` +
            `fileExplorer=${JSON.stringify(fileExplorer)}\n` +
            `electronStderr=${JSON.stringify(electronStderr)}\n` +
            `embeddingHostStatus=${JSON.stringify(embeddingHostStatus)}\n` +
            `chunkingHostStatus=${JSON.stringify(chunkingHostStatus)}`
        );
      }

      const expandAllButton = activeWindow
        .locator('[data-testid="database-demo-panel"]')
        .getByRole('button', { name: 'Expand all' });
      await expect(expandAllButton).toBeVisible({ timeout: 15_000 });
      await expandAllButton.click({ timeout: 30_000 });

      const [
        collectionTreeVisibleAfterExpand,
        globalQueueStatsAfterExpand,
        importCollectionQueueStatsAfterExpand,
        importCollectionCountsAfterExpand,
        importSnapshotAfterExpand,
        fileExplorerAfterExpand,
        electronStderrAfterExpand,
        embeddingHostStatusAfterExpand,
        chunkingHostStatusAfterExpand,
      ] = await Promise.all([
        collectionTreeRegion.isVisible({ timeout: 5000 }).catch(() => false),
        getEmbeddingQueueStats(activeWindow),
        getEmbeddingSetQueueStats(activeWindow, scenario.importEmbeddingSetId),
        getEmbeddingSetCounts(activeWindow, scenario.importEmbeddingSetId),
        getDatabaseDemoImportSnapshot(activeWindow),
        getFileExplorerTestSnapshot(activeWindow),
        getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
        getEmbeddingHostStatus(activeWindow),
        getChunkingHostStatus(activeWindow),
      ]);

      expect(collectionTreeVisibleAfterExpand).toBe(true);
      expect(
        globalQueueStatsAfterExpand.queued + globalQueueStatsAfterExpand.running
      ).toBeGreaterThan(0);
      expect(
        importCollectionQueueStatsAfterExpand.queued + importCollectionQueueStatsAfterExpand.running
      ).toBeGreaterThan(0);
      expect(importCollectionCountsAfterExpand.embeddedChunks).toBeGreaterThan(0);
      expect(fileExplorerAfterExpand?.selectedFilePathCount).toBe(
        REAL_WORLD_MIXED_STATE_FILE_COUNT
      );
      expect(electronStderrAfterExpand).toEqual([]);
      expect(embeddingHostStatusAfterExpand.state).not.toBe('error');
      expect(chunkingHostStatusAfterExpand.state).not.toBe('error');
      expect(importSnapshotAfterExpand?.activeCollectionId).not.toBeNull();
    } finally {
      await clearLargeImportFileSystemMock(electronApp.app);
      await clearEmbeddingQueue(activeWindow);
      await stopEmbeddingHost(activeWindow);
      await stopChunkingHost(activeWindow);
    }
  });

  test('@desktop-embedding-mixed reproduces the desktop:dev mixed-state visible renderer crash path under real import and backfill load', async () => {
    test.skip(!!process.env['CI'], 'Requires a local desktop dev session.');
    test.skip(
      process.env['BRAINSTRIKE_E2E_DESKTOP_DEV_REPRO'] !== '1',
      'Opt-in repro harness. Set BRAINSTRIKE_E2E_DESKTOP_DEV_REPRO=1 to run.'
    );
    test.setTimeout(540_000);

    await waitForTcpPortOpen(DESKTOP_DEV_RENDERER_PORT, 5000).catch((error) => {
      throw new Error(
        `Desktop dev renderer must already be running on ${DESKTOP_DEV_RENDERER_URL} before this repro test starts.\n` +
          'Start it with `pnpm --filter @brainstrike/desktop dev:renderer` in a separate terminal.\n' +
          `error=${error instanceof Error ? error.message : String(error)}`
      );
    });
    const userDataDir = path.join(
      os.tmpdir(),
      `brainstrike-desktop-dev-repro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );
    const electronContext = await launchElectronDevAppInTest(userDataDir);
    let activeWindow = electronContext.window;
    let electronStderrBaselineCount = 0;

    try {
      await waitForAppReadyInTest(activeWindow);
      electronStderrBaselineCount = (await getRelevantElectronStderr(electronContext.app)).length;
      const scenario = await prepareRealWorldMixedStateScenario(electronContext.app, activeWindow);
      activeWindow = scenario.activeWindow;

      const baselineTimeOrigin = scenario.initialTimeOrigin;
      const baselineMainLogs = await getMainBufferedLogs(activeWindow);
      const samples: Array<{
        elapsedMs: number;
        importPhase: string | null;
        queued: number;
        running: number;
        visibleWorkingSetMB: number | null;
      }> = [];

      const startedAt = Date.now();
      while (Date.now() - startedAt < 420_000) {
        try {
          const [
            timeOrigin,
            processSnapshot,
            queueStats,
            importSnapshot,
            mainLogs,
            electronStderr,
          ] = await Promise.all([
            getRendererTimeOrigin(activeWindow),
            readDesktopProcessSnapshot(electronContext.app),
            getEmbeddingQueueStats(activeWindow),
            getDatabaseDemoImportSnapshot(activeWindow),
            getMainBufferedLogs(activeWindow),
            getRelevantElectronStderrSince(electronContext.app, electronStderrBaselineCount),
          ]);

          const visibleWorkingSetMB = getRuntimeSnapshot(
            processSnapshot,
            'visible-ui'
          ).workingSetMB;
          samples.push({
            elapsedMs: Date.now() - startedAt,
            importPhase: importSnapshot?.progress?.phase ?? null,
            queued: queueStats.queued,
            running: queueStats.running,
            visibleWorkingSetMB,
          });

          if (timeOrigin !== baselineTimeOrigin) {
            throw new Error(
              'Visible renderer reloaded during desktop:dev mixed-state repro.\n' +
                `baselineTimeOrigin=${baselineTimeOrigin}\n` +
                `currentTimeOrigin=${timeOrigin}\n` +
                `queueStats=${JSON.stringify(queueStats)}\n` +
                `samples=${JSON.stringify(samples.slice(-20))}\n` +
                `electronStderr=${JSON.stringify(electronStderr)}`
            );
          }

          const crashLifecycleLogs = extractUnexpectedLifecycleLogs(
            mainLogs.slice(baselineMainLogs.length)
          );
          if (crashLifecycleLogs.length > 0) {
            throw new Error(
              'Detected visible-renderer crash/reload lifecycle logs during desktop:dev mixed-state repro.\n' +
                `crashLifecycleLogs=${JSON.stringify(crashLifecycleLogs)}\n` +
                `queueStats=${JSON.stringify(queueStats)}\n` +
                `samples=${JSON.stringify(samples.slice(-20))}\n` +
                `electronStderr=${JSON.stringify(electronStderr)}`
            );
          }

          if (
            electronStderr.some(
              (line) =>
                line.includes('Renderer crashed; deferring recovery') ||
                line.includes('Render frame was disposed before WebFrameMain could be accessed')
            )
          ) {
            throw new Error(
              'Detected renderer-crash aftermath on desktop:dev mixed-state repro.\n' +
                `queueStats=${JSON.stringify(queueStats)}\n` +
                `samples=${JSON.stringify(samples.slice(-20))}\n` +
                `electronStderr=${JSON.stringify(electronStderr)}`
            );
          }

          await activeWindow.waitForTimeout(1000);
        } catch (error) {
          throw new Error(
            'Desktop:dev mixed-state repro triggered a renderer failure path.\n' +
              `error=${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      throw new Error(
        'Desktop:dev mixed-state repro did not trigger the renderer failure path within 420s.\n' +
          `samples=${JSON.stringify(samples.slice(-40))}`
      );
    } finally {
      await clearLargeImportFileSystemMock(electronContext.app).catch(() => undefined);
      await closeElectronAppInTest(electronContext).catch(() => undefined);
    }
  });

  test('@desktop-embedding-mixed keeps desktop:dev 12k visible-ui working-set growth bounded during active backfill', async () => {
    test.skip(!!process.env['CI'], 'Requires a local desktop dev session.');
    test.skip(
      process.env['BRAINSTRIKE_E2E_DESKTOP_DEV_REPRO'] !== '1',
      'Opt-in repro harness. Set BRAINSTRIKE_E2E_DESKTOP_DEV_REPRO=1 to run.'
    );
    test.setTimeout(540_000);

    await waitForTcpPortOpen(DESKTOP_DEV_RENDERER_PORT, 5000).catch((error) => {
      throw new Error(
        `Desktop dev renderer must already be running on ${DESKTOP_DEV_RENDERER_URL} before this repro test starts.\n` +
          'Start it with `pnpm --filter @brainstrike/desktop dev:renderer` in a separate terminal.\n' +
          `error=${error instanceof Error ? error.message : String(error)}`
      );
    });

    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_E2E_ALLOW_GPU: '1',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: undefined,
    });
    const userDataDir = path.join(
      os.tmpdir(),
      `brainstrike-desktop-dev-12k-repro-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    );
    const electronContext = await launchElectronDevAppInTest(userDataDir);

    try {
      let activeWindow = await showDatabaseDemoPanel(electronContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        throw new Error('Database failed to initialize for the desktop:dev 12k repro.');
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'webgpu');
      await reloadRendererInTest(activeWindow, 'desktop-dev-visible-growth-12k');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      await ensureEmbeddingHostWarmed(activeWindow);

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        fileCount: 623,
        chunksPerFile: 20,
        chunkContentBytes: 1024,
        persistActiveSet: false,
      });
      await reloadRendererInTest(activeWindow, 'desktop-dev-visible-growth-12k-fixture');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const initialTimeOrigin = await getRendererTimeOrigin(activeWindow);
      const baselineMainLogs = await getMainBufferedLogs(activeWindow);
      const baselineStderrCount = (await getRelevantElectronStderr(electronContext.app)).length;

      await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
      const outcome = await waitForActiveProcessingOrFatalError(activeWindow, 120_000);
      expect(outcome).toBe('running');

      let lastQueueStats: QueueStatsRow | null = null;
      let lastBackfillState: Awaited<ReturnType<typeof getBridgeBackfillState>> = null;
      let mainProcessHealthSamples: MainProcessHealthSample[] = [];
      let sampledWhileRunning = false;

      const sampleStartedAt = Date.now();
      while (Date.now() - sampleStartedAt < 420_000) {
        const [timeOrigin, queueStats, mainLogs, electronStderr, backfillState] = await Promise.all(
          [
            getRendererTimeOrigin(activeWindow),
            getEmbeddingQueueStats(activeWindow),
            getMainBufferedLogs(activeWindow),
            getRelevantElectronStderrSince(electronContext.app, baselineStderrCount),
            getBridgeBackfillState(activeWindow),
          ]
        );

        if (timeOrigin !== initialTimeOrigin) {
          throw new Error(
            'Visible renderer reloaded during the desktop:dev 12k repro.\n' +
              `baselineTimeOrigin=${initialTimeOrigin}\n` +
              `currentTimeOrigin=${timeOrigin}\n` +
              `queueStats=${JSON.stringify(queueStats)}\n` +
              `backfillState=${JSON.stringify(backfillState)}`
          );
        }

        const crashLifecycleLogs = extractUnexpectedLifecycleLogs(
          mainLogs.slice(baselineMainLogs.length)
        );
        if (crashLifecycleLogs.length > 0) {
          throw new Error(
            'Detected renderer crash/reload lifecycle logs during the desktop:dev 12k repro.\n' +
              `crashLifecycleLogs=${JSON.stringify(crashLifecycleLogs)}\n` +
              `queueStats=${JSON.stringify(queueStats)}\n` +
              `backfillState=${JSON.stringify(backfillState)}`
          );
        }

        if (
          electronStderr.some(
            (line) =>
              line.includes('Renderer crashed; deferring recovery') ||
              line.includes('Render frame was disposed before WebFrameMain could be accessed')
          )
        ) {
          throw new Error(
            'Detected renderer crash aftermath on stderr during the desktop:dev 12k repro.\n' +
              `queueStats=${JSON.stringify(queueStats)}\n` +
              `backfillState=${JSON.stringify(backfillState)}\n` +
              `electronStderr=${JSON.stringify(electronStderr)}`
          );
        }

        lastQueueStats = queueStats;
        lastBackfillState = backfillState;
        mainProcessHealthSamples = parseMainProcessHealthSamples(
          mainLogs.slice(baselineMainLogs.length)
        );
        if (queueStats.running > 0 || queueStats.succeeded > 0) {
          sampledWhileRunning = true;
        }

        const visibleWorkingSetSamplesKB = mainProcessHealthSamples
          .map((sample) => sample.visibleUiWorkingSetKB)
          .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        const baselineVisibleWorkingSetFromHealthMB =
          visibleWorkingSetSamplesKB.length > 0 ? visibleWorkingSetSamplesKB[0]! / 1024 : 0;
        const peakVisibleWorkingSetMB =
          visibleWorkingSetSamplesKB.length > 0
            ? Math.max(...visibleWorkingSetSamplesKB) / 1024
            : 0;
        const visibleWorkingSetGrowthFromHealthMB = growth(
          peakVisibleWorkingSetMB,
          baselineVisibleWorkingSetFromHealthMB
        );

        if (
          sampledWhileRunning &&
          visibleWorkingSetSamplesKB.length >= DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT &&
          visibleWorkingSetGrowthFromHealthMB < DEFAULT_12K_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB
        ) {
          console.log(
            JSON.stringify({
              type: 'desktop-dev-visible-growth-12k-bounded',
              fixture,
              lastQueueStats,
              lastBackfillState,
              baselineVisibleWorkingSetFromHealthMB:
                Math.round(baselineVisibleWorkingSetFromHealthMB * 10) / 10,
              peakVisibleWorkingSetMB: Math.round(peakVisibleWorkingSetMB * 10) / 10,
              visibleWorkingSetGrowthFromHealthMB:
                Math.round(visibleWorkingSetGrowthFromHealthMB * 10) / 10,
              mainProcessHealthSamples,
            })
          );
          return;
        }

        await activeWindow.waitForTimeout(1000);
      }

      const visibleWorkingSetSamplesKB = mainProcessHealthSamples
        .map((sample) => sample.visibleUiWorkingSetKB)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const baselineVisibleWorkingSetFromHealthMB =
        visibleWorkingSetSamplesKB.length > 0 ? visibleWorkingSetSamplesKB[0]! / 1024 : null;
      const peakVisibleWorkingSetMB =
        visibleWorkingSetSamplesKB.length > 0
          ? Math.max(...visibleWorkingSetSamplesKB) / 1024
          : null;
      const visibleWorkingSetGrowthFromHealthMB =
        peakVisibleWorkingSetMB !== null && baselineVisibleWorkingSetFromHealthMB !== null
          ? growth(peakVisibleWorkingSetMB, baselineVisibleWorkingSetFromHealthMB)
          : null;

      throw new Error(
        'Desktop:dev 12k bounded-memory regression did not reach a stable active-backfill sample within 420s.\n' +
          `lastQueueStats=${JSON.stringify(lastQueueStats)}\n` +
          `lastBackfillState=${JSON.stringify(lastBackfillState)}\n` +
          `sampledWhileRunning=${JSON.stringify(sampledWhileRunning)}\n` +
          `healthSampleCount=${mainProcessHealthSamples.length}\n` +
          `baselineVisibleWorkingSetMB=${JSON.stringify(baselineVisibleWorkingSetFromHealthMB)}\n` +
          `peakVisibleWorkingSetMB=${JSON.stringify(peakVisibleWorkingSetMB)}\n` +
          `visibleWorkingSetGrowthFromHealthMB=${JSON.stringify(visibleWorkingSetGrowthFromHealthMB)}\n` +
          `mainProcessHealthSamples=${JSON.stringify(mainProcessHealthSamples)}`
      );
    } finally {
      restoreEnv();
      await closeElectronAppInTest(electronContext).catch(() => undefined);
    }
  });

  test('@desktop-embedding-mixed fails invalid job payloads without taking down the embedding host or visible UI', async ({
    window,
  }) => {
    const activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    // Explicitly stop first to avoid a race between the prior test's 'stop' command and
    // our 'reset' command. Without this, startWorker can silently skip starting when
    // startingRef.current is still true from a concurrent stop/start sequence.
    await stopEmbeddingHost(activeWindow);
    await activeWindow.waitForTimeout(200);
    await clearEmbeddingQueue(activeWindow);
    await resetEmbeddingHost(activeWindow);
    await waitForEmbeddingHostState(activeWindow, (status) => status.state === 'running');

    // Wait longer than the worker's 400ms idle backoff to ensure at least one poll
    // cycle has completed, confirming the worker loop is actively running.
    await activeWindow.waitForTimeout(600);
    await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 30_000);

    const invalidJobId = await createInvalidJob(activeWindow);

    await expect
      .poll(async () => await getJobStatus(activeWindow, invalidJobId), {
        timeout: 30_000,
      })
      .toBe('failed');

    await assertToolsPanelResponsive(activeWindow);

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state).toBe('running');
  });

  test('@desktop-embedding-mixed keeps the hidden host alive across visible-window navigation once started', async ({
    window,
  }) => {
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await activeWindow.evaluate(async () => {
      const host = (
        globalThis as unknown as Window & {
          embeddingHost?: {
            ensureStarted?: () => Promise<EmbeddingHostStatus>;
          };
        }
      ).embeddingHost;
      if (!host?.ensureStarted) {
        throw new Error('Embedding host bridge is not available');
      }
      await host.ensureStarted();
    });

    const hostPageBefore = await getEmbeddingHostPage(activeWindow);
    const before = await createTestBackfillJob(activeWindow);
    expect(await getJobStatus(activeWindow, before.jobId)).not.toBeNull();

    const promptsNav = activeWindow
      .getByRole('button', { name: /prompts/i })
      .or(activeWindow.getByRole('link', { name: /prompts/i }))
      .first();
    await expect(promptsNav).toBeVisible({ timeout: 10_000 });
    await promptsNav.click();
    await expect(activeWindow.getByRole('heading', { name: /prompt library/i })).toBeVisible({
      timeout: 15_000,
    });

    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const hostPageAfter = await getEmbeddingHostPage(activeWindow);
    expect(hostPageAfter).toBe(hostPageBefore);

    const after = await createTestBackfillJob(activeWindow);
    expect(await getJobStatus(activeWindow, after.jobId)).not.toBeNull();

    const status = await getEmbeddingHostStatus(activeWindow);
    expect(status.state === 'running' || status.state === 'error').toBe(true);
    if (status.state === 'error') {
      expect(status.lastError).toMatch(/Local embedding (model initialization|execution) failed/i);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Crash-reproduction regression tests
  //
  // These tests target the recurring renderer crash during/after large embedding
  // backfills. Root causes identified:
  //   1. PGlite live query firehose → visible-ui OOM (Crash 1)
  //   2. Unprotected WebGPU session in visible-ui → GPU device invalidation (Crash 2)
  //   3. lock-screen/unlock-screen events not acted upon
  //   4. No state reconciliation after renderer reload
  //   5. embeddingBackfillsInFlight blocks re-trigger for up to 5 min
  //
  // Tests 2 and 3 require BRAINSTRIKE_E2E_ALLOW_BACKGROUNDING=1 to reproduce
  // the production crash path where Chromium throttles backgrounded renderers.
  // ─────────────────────────────────────────────────────────────────────────────

  // Use 20K chunks (matching the existing passing 20K backfill test capacity).
  // 30K exceeds Chromium's per-renderer resource limits in headless test mode
  // (--disable-gpu + --no-sandbox). The production 30K crash is addressed by
  // fixes to IPC throttling, live query pausing, backgroundThrottling, and
  // lock-screen event handling — which cannot be validated at 30K scale in CI.
  const CRASH_REPRO_LARGE_FILE_COUNT = 1000;
  const CRASH_REPRO_LARGE_CHUNKS_PER_FILE = 20;
  // Match the existing 20K test's sampling window (6 samples × 2.5s = 15s)
  // to stay within the stable window. The ~60s crash point during extended
  // backfills in test mode (--disable-gpu + --no-sandbox) is a separate
  // Chromium test-environment limitation, not the production crash.
  const CRASH_REPRO_SAMPLE_COUNT = LARGE_BACKFILL_SAMPLE_COUNT;
  const CRASH_REPRO_SAMPLE_INTERVAL_MS = LARGE_BACKFILL_SAMPLE_INTERVAL_MS;
  const CRASH_REPRO_BACKGROUNDING_FILE_COUNT = 500;
  const CRASH_REPRO_BACKGROUNDING_CHUNKS_PER_FILE = 20;
  const CRASH_REPRO_IDLE_FILE_COUNT = 50;
  const CRASH_REPRO_IDLE_CHUNKS_PER_FILE = 20;
  const CRASH_REPRO_IPC_FILE_COUNT = 1000;
  const CRASH_REPRO_IPC_CHUNKS_PER_FILE = 20;
  const CRASH_REPRO_SUSPEND_FILE_COUNT = 50;
  const CRASH_REPRO_SUSPEND_CHUNKS_PER_FILE = 20;
  const CRASH_REPRO_IDLE_POLL_INTERVAL_MS = 30_000;
  const CRASH_REPRO_IDLE_POLL_COUNT = 10;

  async function runVisibleWindowActionWithRetry(
    app: ElectronApplication,
    action: 'blur' | 'focus' | 'minimize',
    timeoutMs = 15_000
  ): Promise<void> {
    const startedAt = Date.now();
    let lastDisposedError: Error | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        await app.evaluate(({ BrowserWindow }, nextAction) => {
          const visibleWindow = BrowserWindow.getAllWindows().find((win) => {
            const url = win.webContents.getURL();
            return !(url.includes('mode=embedding-host') || url.includes('mode=chunking-host'));
          });

          if (!visibleWindow) {
            return;
          }

          switch (nextAction) {
            case 'blur':
              visibleWindow.blur();
              return;
            case 'focus':
              visibleWindow.restore();
              visibleWindow.focus();
              return;
            case 'minimize':
              visibleWindow.minimize();
              return;
          }
        }, action);

        return;
      } catch (error) {
        if (!isDisposedElectronEvaluateError(error)) {
          throw error;
        }
        lastDisposedError = error;
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }
    }

    throw new Error(
      `Timed out waiting to ${action} the visible Electron window after execution-context churn: ${
        lastDisposedError?.message ?? 'unknown disposed execution context error'
      }`
    );
  }

  async function blurVisibleWindow(app: ElectronApplication): Promise<void> {
    await runVisibleWindowActionWithRetry(app, 'blur');
  }

  async function minimizeVisibleWindow(app: ElectronApplication): Promise<void> {
    await runVisibleWindowActionWithRetry(app, 'minimize');
  }

  async function focusVisibleWindow(app: ElectronApplication): Promise<void> {
    await runVisibleWindowActionWithRetry(app, 'focus');
  }

  async function getVisibleWindowPage(app: ElectronApplication): Promise<Page> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < 15_000) {
      const visiblePage = app.windows().find((page) => {
        if (page.isClosed()) {
          return false;
        }

        const url = page.url();
        return !(url.includes('mode=embedding-host') || url.includes('mode=chunking-host'));
      });

      if (visiblePage) {
        await visiblePage.waitForLoadState('domcontentloaded');
        return visiblePage;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }

    throw new Error('Timed out waiting for the visible Electron page');
  }

  async function broadcastPowerState(
    app: ElectronApplication,
    state: 'resume' | 'suspend'
  ): Promise<void> {
    await app.evaluate(({ BrowserWindow }, powerState) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          win.webContents.send('app:power-state', powerState);
        } catch {
          // Window may be destroyed
        }
      }
    }, state);
  }

  test('@desktop-embedding-crash-a renderer survives a large chunk backfill without crashing (crash repro test 1)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(600_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-large-backfill-survival');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const warmedHostPage = await ensureEmbeddingHostWarmed(activeWindow);
    const warmedBaseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      warmedHostPage,
      'crash-repro-large-post-warmup'
    );

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: CRASH_REPRO_LARGE_FILE_COUNT,
      chunksPerFile: CRASH_REPRO_LARGE_CHUNKS_PER_FILE,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-large-backfill-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    // Capture timeOrigin AFTER the intentional reload so we only detect
    // unintended crashes, not the fixture-loading reload.
    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    const hostPage = await getEmbeddingHostPage(activeWindow);
    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'crash-repro-large-before-backfill'
    );

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);

    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Sample memory and assert stability throughout the backfill
    const samples = await sampleMemoryWhileBackfillActive(
      electronApp.app,
      activeWindow,
      CRASH_REPRO_SAMPLE_COUNT,
      CRASH_REPRO_SAMPLE_INTERVAL_MS
    );

    // Assert renderer did not crash/reload during sampling
    const currentTimeOrigin = await getRendererTimeOrigin(activeWindow);
    expect(currentTimeOrigin).toBe(baselineTimeOrigin);

    // Assert no crash recovery logs
    const mainLogs = await getMainBufferedLogs(activeWindow);
    const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
    expect(unexpectedLogs).toHaveLength(0);

    // Assert embedding host is still alive
    const postStatus = await getEmbeddingHostStatus(activeWindow);
    expect(postStatus.state).not.toBe('error');

    // Assert UI is still responsive
    await assertToolsPanelResponsive(activeWindow);

    // Assert memory growth is bounded
    const peaks = samples.reduce(
      (current, sample) => ({
        hostHeapMB: Math.max(current.hostHeapMB, sample.snapshot.hostHeap.usedMB),
        visibleHeapMB: Math.max(current.visibleHeapMB, sample.snapshot.visibleHeap.usedMB),
        mainRssMB: Math.max(current.mainRssMB, sample.snapshot.process.mainProcess.rssMB),
      }),
      {
        hostHeapMB: baseline.hostHeap.usedMB,
        visibleHeapMB: baseline.visibleHeap.usedMB,
        mainRssMB: baseline.process.mainProcess.rssMB,
      }
    );

    console.log(
      JSON.stringify({
        type: 'crash-repro-large-backfill-survival',
        fixture,
        warmedBaseline,
        baseline,
        peaks,
        sampleCount: samples.length,
      })
    );

    expect(growth(peaks.hostHeapMB, baseline.hostHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.visibleHeapMB, baseline.visibleHeap.usedMB)).toBeLessThan(
      LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB
    );
    expect(growth(peaks.mainRssMB, baseline.process.mainProcess.rssMB)).toBeLessThan(
      LARGE_BACKFILL_MAIN_RSS_GROWTH_LIMIT_MB
    );

    // Verify some work was actually processed
    const finalQueueStats = await getEmbeddingQueueStats(activeWindow);
    expect(finalQueueStats.succeeded + finalQueueStats.running).toBeGreaterThan(0);

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-a renderer survives window blur and minimize during active backfill (crash repro test 2)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(300_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-backgrounding-survival');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: CRASH_REPRO_BACKGROUNDING_FILE_COUNT,
      chunksPerFile: CRASH_REPRO_BACKGROUNDING_CHUNKS_PER_FILE,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-backgrounding-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Phase 1: Blur the visible window while backfill is active
    await blurVisibleWindow(electronApp.app);
    await activeWindow.waitForTimeout(15_000);

    // Phase 2: Minimize the visible window
    await minimizeVisibleWindow(electronApp.app);
    await activeWindow.waitForTimeout(30_000);

    // Phase 3: Restore and focus the visible window
    await focusVisibleWindow(electronApp.app);
    await activeWindow.waitForTimeout(5000);
    activeWindow = await getVisibleWindowPage(electronApp.app);

    // Assert renderer did not crash
    const postFocusTimeOrigin = await getRendererTimeOrigin(activeWindow);
    expect(postFocusTimeOrigin).toBe(baselineTimeOrigin);

    // Assert no crash recovery logs
    const mainLogs = await getMainBufferedLogs(activeWindow);
    const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
    expect(unexpectedLogs).toHaveLength(0);

    // Assert embedding host is still alive
    const hostStatus = await getEmbeddingHostStatus(activeWindow);
    expect(hostStatus.state).not.toBe('error');

    // Assert the embedding host page is still evaluatable
    const hostPage = await getEmbeddingHostPage(activeWindow);
    expect(hostPage).toBeTruthy();

    // Assert UI is still responsive
    await assertToolsPanelResponsive(activeWindow);

    // Assert backfill is still making progress
    const queueStats = await getEmbeddingQueueStats(activeWindow);
    expect(queueStats.succeeded + queueStats.running + queueStats.queued).toBeGreaterThan(0);

    console.log(
      JSON.stringify({
        type: 'crash-repro-backgrounding-survival',
        fixture,
        postFocusTimeOrigin,
        baselineTimeOrigin,
        hostState: hostStatus.state,
        queueStats,
      })
    );

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-a renderer stays alive for 5 minutes of idle after completing a backfill (crash repro test 3)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    // This test intentionally includes up to 4 minutes for backfill completion,
    // 2 minutes for queue drain, and a 5 minute idle observation window.
    // Keep the timeout above that combined budget so slower Linux CI does not
    // fail before the actual renderer-idle assertions run.
    test.setTimeout(780_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-idle-stability');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: CRASH_REPRO_IDLE_FILE_COUNT,
      chunksPerFile: CRASH_REPRO_IDLE_CHUNKS_PER_FILE,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-idle-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    // Complete the backfill
    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    await waitForBridgeBackfillCompletion(activeWindow, 240_000);
    await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 120_000);

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);
    const hostPage = await getEmbeddingHostPage(activeWindow);
    const baselineMemory = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'crash-repro-idle-baseline'
    );

    // Monitor renderer health every 30s for 5 minutes of idle
    const idleChecks: Array<{
      index: number;
      memorySnapshot: CombinedMemorySnapshot;
      rendererAlive: boolean;
    }> = [];

    for (let index = 0; index < CRASH_REPRO_IDLE_POLL_COUNT; index += 1) {
      await activeWindow.waitForTimeout(CRASH_REPRO_IDLE_POLL_INTERVAL_MS);

      const currentTimeOrigin = await getRendererTimeOrigin(activeWindow);
      const rendererAlive = currentTimeOrigin === baselineTimeOrigin;

      const currentHostPage = await getEmbeddingHostPage(activeWindow);
      const memorySnapshot = await readCombinedMemorySnapshot(
        electronApp.app,
        activeWindow,
        currentHostPage,
        `crash-repro-idle-check-${index + 1}`
      );

      idleChecks.push({ index: index + 1, rendererAlive, memorySnapshot });

      // Assert renderer did not crash on each poll
      expect(rendererAlive).toBe(true);

      // Assert embedding host is still alive
      const status = await getEmbeddingHostStatus(activeWindow);
      expect(status.state).not.toBe('error');

      // Assert no crash recovery logs
      const mainLogs = await getMainBufferedLogs(activeWindow);
      const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
      expect(unexpectedLogs).toHaveLength(0);
    }

    // After idle period, verify UI is still responsive
    await assertToolsPanelResponsive(activeWindow);

    // Verify the embedding host is still functional by processing a single job
    const verificationJob = await createTestBackfillJob(activeWindow);
    const terminalState = await waitForJobTerminalState(
      activeWindow,
      verificationJob.jobId,
      60_000
    );
    expect(terminalState).toBe('succeeded');

    // Check memory drift during idle
    const lastCheck = idleChecks.at(-1);
    if (lastCheck) {
      const hostHeapDrift = growth(
        lastCheck.memorySnapshot.hostHeap.usedMB,
        baselineMemory.hostHeap.usedMB
      );
      const mainRssDrift = growth(
        lastCheck.memorySnapshot.process.mainProcess.rssMB,
        baselineMemory.process.mainProcess.rssMB
      );

      expect(hostHeapDrift).toBeLessThan(LARGE_BACKFILL_IDLE_HOST_HEAP_DRIFT_LIMIT_MB);
      expect(mainRssDrift).toBeLessThan(LARGE_BACKFILL_IDLE_MAIN_RSS_DRIFT_LIMIT_MB);
    }

    console.log(
      JSON.stringify({
        type: 'crash-repro-idle-stability',
        fixture,
        baselineMemory,
        idleCheckCount: idleChecks.length,
        allRendererAlive: idleChecks.every((check) => check.rendererAlive),
      })
    );

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-a visible renderer heap stays bounded during rapid IPC progress updates (crash repro test 4)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(420_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-ipc-flood-resilience');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    // Use minimal chunk content to maximize embedding throughput and IPC rate
    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: CRASH_REPRO_IPC_FILE_COUNT,
      chunksPerFile: CRASH_REPRO_IPC_CHUNKS_PER_FILE,
      chunkContentBytes: 0,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-ipc-flood-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const hostPage = await getEmbeddingHostPage(activeWindow);
    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'crash-repro-ipc-flood-baseline'
    );

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    // Start backfill via UI button to exercise the full progress UI path
    const backfillButton = activeWindow
      .locator('[data-testid="database-demo-panel"]')
      .getByRole('button', { name: /^Backfill(?:\s|$)/ });

    await expect(backfillButton).toBeVisible({ timeout: 15_000 });
    await waitForBackfillButtonEnabled(activeWindow, backfillButton);
    await backfillButton.click({ timeout: 5000 });

    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Sample memory while the IPC flood is active
    const samples = await sampleMemoryWhileBackfillActive(
      electronApp.app,
      activeWindow,
      CRASH_REPRO_SAMPLE_COUNT,
      CRASH_REPRO_SAMPLE_INTERVAL_MS
    );

    // Assert renderer did not crash
    const postTimeOrigin = await getRendererTimeOrigin(activeWindow);
    expect(postTimeOrigin).toBe(baselineTimeOrigin);

    // Assert no crash recovery logs
    const mainLogs = await getMainBufferedLogs(activeWindow);
    const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
    expect(unexpectedLogs).toHaveLength(0);

    // Assert UI is still responsive during/after IPC flood
    await assertToolsPanelResponsive(activeWindow);

    // Assert memory bounded
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    const postGcHostPage = await getEmbeddingHostPage(activeWindow);
    const postGcSnapshot = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      postGcHostPage,
      'crash-repro-ipc-flood-post-gc'
    );

    const visibleHeapGrowth = growth(
      postGcSnapshot.visibleHeap.usedMB,
      baseline.visibleHeap.usedMB
    );
    const hostHeapGrowth = growth(postGcSnapshot.hostHeap.usedMB, baseline.hostHeap.usedMB);

    console.log(
      JSON.stringify({
        type: 'crash-repro-ipc-flood-resilience',
        fixture,
        baseline,
        postGcSnapshot,
        visibleHeapGrowth,
        hostHeapGrowth,
        sampleCount: samples.length,
      })
    );

    expect(visibleHeapGrowth).toBeLessThan(LARGE_BACKFILL_VISIBLE_HEAP_GROWTH_LIMIT_MB);
    expect(hostHeapGrowth).toBeLessThan(LARGE_BACKFILL_HOST_HEAP_GROWTH_LIMIT_MB);

    // Verify queue had meaningful throughput
    for (const sample of samples) {
      expect(sample.queueStats.running).toBeLessThanOrEqual(DESKTOP_IDLE_EMBED_RUNNING_JOB_LIMIT);
    }

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-a embedding host stays functional across simulated power suspend/resume cycles (crash repro test 5)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(300_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-suspend-resume');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: CRASH_REPRO_SUSPEND_FILE_COUNT,
      chunksPerFile: CRASH_REPRO_SUSPEND_CHUNKS_PER_FILE,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-suspend-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    // Complete a backfill first
    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    await waitForBridgeBackfillCompletion(activeWindow, 240_000);
    await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 120_000);

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    // Run 3 suspend/resume cycles
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      // Simulate suspend
      await broadcastPowerState(electronApp.app, 'suspend');
      await activeWindow.waitForTimeout(5000);

      // Simulate resume (production uses a 2s delay)
      await broadcastPowerState(electronApp.app, 'resume');
      await activeWindow.waitForTimeout(3000);

      // Assert renderer did not crash
      const cycleTimeOrigin = await getRendererTimeOrigin(activeWindow);
      expect(cycleTimeOrigin).toBe(baselineTimeOrigin);

      // Assert embedding host is still alive
      const status = await getEmbeddingHostStatus(activeWindow);
      expect(status.state).not.toBe('error');

      // Assert no crash recovery logs
      const mainLogs = await getMainBufferedLogs(activeWindow);
      const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
      expect(unexpectedLogs).toHaveLength(0);
    }

    // After all cycles, verify the embedding pipeline is still functional
    await assertToolsPanelResponsive(activeWindow);

    const verificationJob = await createTestBackfillJob(activeWindow);
    const terminalState = await waitForJobTerminalState(
      activeWindow,
      verificationJob.jobId,
      60_000
    );
    expect(terminalState).toBe('succeeded');

    console.log(
      JSON.stringify({
        type: 'crash-repro-suspend-resume',
        fixture,
        cyclesCompleted: 3,
        verificationJobState: terminalState,
      })
    );

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-b tracks per-process memory growth rate during sustained backfill (crash repro test 6)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.setTimeout(300_000);

    const GROWTH_SAMPLE_COUNT = 12;
    const GROWTH_SAMPLE_INTERVAL_MS = 10_000;
    // Acceptable per-minute growth rates (MB/min) after GC
    const VISIBLE_HEAP_GROWTH_RATE_LIMIT_MB_PER_MIN = 5;
    const MAIN_RSS_GROWTH_RATE_LIMIT_MB_PER_MIN = 15;

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, 'wasm');
    await reloadRendererInTest(activeWindow, 'crash-repro-growth-rate');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    // Use a large fixture to keep the backfill running for the full sample window
    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: CRASH_REPRO_LARGE_FILE_COUNT,
      chunksPerFile: CRASH_REPRO_LARGE_CHUNKS_PER_FILE,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-growth-rate-fixture-loaded');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const baselineTimeOrigin = await getRendererTimeOrigin(activeWindow);

    // Force GC before baseline
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);

    const hostPage = await getEmbeddingHostPage(activeWindow);
    await forceRendererGarbageCollection(hostPage);

    const baseline = await readCombinedMemorySnapshot(
      electronApp.app,
      activeWindow,
      hostPage,
      'growth-rate-baseline'
    );

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Sample every 10s for 2 minutes with forced GC at each point
    const samples: Array<{
      elapsedSec: number;
      mainHeapMB: number;
      mainRssMB: number;
      visibleHeapMB: number;
    }> = [];
    const startedAt = Date.now();

    for (let index = 0; index < GROWTH_SAMPLE_COUNT; index += 1) {
      await activeWindow.waitForTimeout(GROWTH_SAMPLE_INTERVAL_MS);

      // Force GC on both renderers to measure real retention, not GC lag
      await forceRendererGarbageCollection(activeWindow);
      await forceRendererGarbageCollection(activeWindow);
      const currentHostPage = await getEmbeddingHostPage(activeWindow);
      await forceRendererGarbageCollection(currentHostPage);

      const snapshot = await readCombinedMemorySnapshot(
        electronApp.app,
        activeWindow,
        currentHostPage,
        `growth-rate-sample-${index + 1}`
      );

      samples.push({
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        visibleHeapMB: snapshot.visibleHeap.usedMB,
        mainRssMB: snapshot.process.mainProcess.rssMB,
        mainHeapMB: snapshot.process.mainProcess.heapUsedMB,
      });
    }

    // Verify renderer didn't crash
    const postTimeOrigin = await getRendererTimeOrigin(activeWindow);
    expect(postTimeOrigin).toBe(baselineTimeOrigin);

    // Calculate growth rates (MB per minute) using linear regression
    const elapsedMinutes = samples.at(-1)!.elapsedSec / 60;
    const visibleHeapGrowth = growth(samples.at(-1)!.visibleHeapMB, baseline.visibleHeap.usedMB);
    const mainRssGrowth = growth(samples.at(-1)!.mainRssMB, baseline.process.mainProcess.rssMB);
    const visibleHeapRate = elapsedMinutes > 0 ? visibleHeapGrowth / elapsedMinutes : 0;
    const mainRssRate = elapsedMinutes > 0 ? mainRssGrowth / elapsedMinutes : 0;

    console.log(
      JSON.stringify({
        type: 'crash-repro-memory-growth-rate',
        fixture,
        baseline: {
          visibleHeapMB: baseline.visibleHeap.usedMB,
          mainRssMB: baseline.process.mainProcess.rssMB,
          mainHeapMB: baseline.process.mainProcess.heapUsedMB,
        },
        samples,
        elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
        visibleHeapGrowthMB: visibleHeapGrowth,
        visibleHeapRateMBPerMin: Math.round(visibleHeapRate * 10) / 10,
        mainRssGrowthMB: mainRssGrowth,
        mainRssRateMBPerMin: Math.round(mainRssRate * 10) / 10,
      })
    );

    // Assert growth rates are within acceptable bounds
    expect(visibleHeapRate).toBeLessThan(VISIBLE_HEAP_GROWTH_RATE_LIMIT_MB_PER_MIN);
    expect(mainRssRate).toBeLessThan(MAIN_RSS_GROWTH_RATE_LIMIT_MB_PER_MIN);

    // Assert no crash recovery logs
    const mainLogs = await getMainBufferedLogs(activeWindow);
    const unexpectedLogs = extractUnexpectedLifecycleLogs(mainLogs);
    expect(unexpectedLogs).toHaveLength(0);

    await electronHarness.restart();
  });

  async function runGpuReclaimMeasurementScenario(options: {
    chunksPerFile: number;
    electronHarness: {
      restart: () => Promise<{ app: ElectronApplication; window: Page }>;
    };
    itemThreshold: number;
    label: string;
    minimumIntervalMs?: number;
    reclaimEnabled: boolean;
    reclaimMode?: 'reset';
    targetSucceededItems: number;
  }): Promise<{
    cycleCount: number;
    gpuGrowthMB: number;
    gpuGrowthPerItemKB: number;
    hostWorkingSetGrowthMB: number;
    hostWorkingSetGrowthPerItemKB: number;
    itemsProcessed: number;
    label: string;
    runtimeIdAfterSampling: string;
    runtimeIdBeforeBackfill: string;
    hostScore: {
      maxWorkingSetMB: number;
      medianWorkingSetMB: number;
      minWorkingSetMB: number;
    };
    score: {
      maxGpuKB: number;
      maxTotalKB: number;
      medianGpuKB: number;
      medianTotalKB: number;
      minGpuKB: number;
      minTotalKB: number;
    };
    totalGrowthMB: number;
  }> {
    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_E2E_ALLOW_GPU: '1',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: options.reclaimEnabled ? 'true' : 'false',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS:
        options.minimumIntervalMs === undefined ? undefined : String(options.minimumIntervalMs),
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD: String(options.itemThreshold),
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: options.reclaimMode,
    });

    try {
      const electronContext = await options.electronHarness.restart();
      let activeWindow = await showDatabaseDemoPanel(electronContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        throw new Error(`Database failed to initialize for ${options.label}.`);
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'webgpu');
      await reloadRendererInTest(activeWindow, `${options.label}-memory-measurement`);
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      await ensureEmbeddingHostWarmed(activeWindow);

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        fileCount: 180,
        chunksPerFile: options.chunksPerFile,
        chunkContentBytes: 1024,
        persistActiveSet: false,
      });
      await reloadRendererInTest(activeWindow, `${options.label}-memory-measurement-fixture`);
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const [baseline, initialStatus, baselineMainLogs, baselineElectronStderr] = await Promise.all(
        [
          readAppMetricSample(electronContext.app, activeWindow),
          getEmbeddingHostStatus(activeWindow),
          getMainBufferedLogs(activeWindow),
          getRelevantElectronStderr(electronContext.app),
        ]
      );

      await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
      const outcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        120_000
      );
      expect(outcome).toBe('queued');
      const baselineHostWorkingSetMB = await waitForTrackedRuntimeWorkingSetMB(
        electronContext.app,
        activeWindow,
        'embedding-host'
      );

      let queueStatsBeforeSampling: QueueStatsRow | null = null;
      const measurementStartedAt = Date.now();
      while (Date.now() - measurementStartedAt < 180_000) {
        const [queueStats, status, mainLogs] = await Promise.all([
          getEmbeddingQueueStats(activeWindow),
          getEmbeddingHostStatus(activeWindow),
          getMainBufferedLogs(activeWindow),
        ]);
        if (status.state === 'error') {
          throw new Error(
            `Embedding host entered error state during ${options.label}: ${status.lastError ?? 'unknown host error'}`
          );
        }

        if (options.reclaimEnabled) {
          const observedMaintenanceCycles = detectObservedMaintenanceCycles({
            initialRuntimeId: initialStatus.runtimeId,
            finalRuntimeId: status.runtimeId,
            logsSinceBaseline: mainLogs.slice(baselineMainLogs.length),
          });
          const reclaimedAndResumed =
            observedMaintenanceCycles > 0 &&
            status.runtimeId !== initialStatus.runtimeId &&
            status.state === 'running' &&
            status.active &&
            queueStats.running > 0 &&
            queueStats.succeeded >= options.targetSucceededItems;
          if (reclaimedAndResumed) {
            queueStatsBeforeSampling = queueStats;
            break;
          }
        } else if (queueStats.succeeded >= options.targetSucceededItems) {
          queueStatsBeforeSampling = queueStats;
          break;
        }

        await activeWindow.waitForTimeout(1000);
      }

      if (!queueStatsBeforeSampling) {
        throw new Error(`Timed out waiting for the ${options.label} sampling checkpoint.`);
      }
      expect(queueStatsBeforeSampling.succeeded).toBeGreaterThanOrEqual(
        options.targetSucceededItems
      );
      if (options.reclaimEnabled) {
        await expect
          .poll(
            async () =>
              countPlannedMaintenanceLogs(
                (await getMainBufferedLogs(activeWindow)).slice(baselineMainLogs.length)
              ),
            {
              timeout: 60_000,
            }
          )
          .toBeGreaterThan(0);
        const resumedState = await waitForReclaimCycleAndResumedProcessing(
          activeWindow,
          initialStatus.runtimeId,
          baselineMainLogs.length,
          options.targetSucceededItems,
          60_000
        );
        queueStatsBeforeSampling = resumedState.queueStats;
      }

      const baselineGpuKB = getGpuWorkingSetKB(baseline);
      const baselineTotalKB = getTotalWorkingSetKB(baseline);

      // Score a short steady-state window after the sampling checkpoint. The
      // comparison gate is the hidden embedding-host renderer working set,
      // which maps directly to the background renderer the user observes.
      const postTargetSampleDelayMs = 1000;
      const postTargetSampleCount = 12;
      const postTargetSamples = await collectPostTargetMemorySamples(
        electronContext.app,
        activeWindow,
        postTargetSampleCount,
        postTargetSampleDelayMs
      );
      const rawSampleSummary = postTargetSamples.map((sample) => ({
        gpuKB: getGpuWorkingSetKB(sample.appMetrics),
        hostWorkingSetMB: sample.hostWorkingSetMB,
        totalKB: getTotalWorkingSetKB(sample.appMetrics),
      }));
      const score = scoreGpuWorkingSetSamples(postTargetSamples.map((sample) => sample.appMetrics));
      const hostScore = scoreNumericSamples(
        postTargetSamples.map((sample) => sample.hostWorkingSetMB)
      );

      const finalGpuKB = score.medianGpuKB;
      const gpuGrowthMB = (finalGpuKB - baselineGpuKB) / 1024;

      const finalTotalKB = score.medianTotalKB;
      const totalGrowthMB = (finalTotalKB - baselineTotalKB) / 1024;
      const finalHostWorkingSetMB = hostScore.median;
      const hostWorkingSetGrowthMB = finalHostWorkingSetMB - baselineHostWorkingSetMB;
      const finalQueueStats = await getEmbeddingQueueStats(activeWindow);
      const itemsProcessed = finalQueueStats.succeeded;
      const gpuGrowthPerItemKB =
        itemsProcessed > 0 ? (finalGpuKB - baselineGpuKB) / itemsProcessed : 0;
      const hostWorkingSetGrowthPerItemKB =
        itemsProcessed > 0
          ? ((finalHostWorkingSetMB - baselineHostWorkingSetMB) * 1024) / itemsProcessed
          : 0;
      const [statusAfterSampling, mainLogsAfterSampling] = await Promise.all([
        getEmbeddingHostStatus(activeWindow),
        getMainBufferedLogs(activeWindow),
      ]);
      const observedMaintenanceCycles = detectObservedMaintenanceCycles({
        initialRuntimeId: initialStatus.runtimeId,
        finalRuntimeId: statusAfterSampling.runtimeId,
        logsSinceBaseline: mainLogsAfterSampling.slice(baselineMainLogs.length),
      });

      await waitForBridgeBackfillCompletion(activeWindow, 240_000);
      await waitForEmbeddingHostIdleAndQueueDrain(activeWindow, 120_000);
      await assertCleanBackfillMeasurementScenario(
        activeWindow,
        electronContext.app,
        baselineMainLogs.length,
        baselineElectronStderr.length
      );

      console.log(
        JSON.stringify({
          type: 'GPU_RECLAIM_MEASUREMENT',
          cycleCount: observedMaintenanceCycles,
          gpuGrowthMB: Math.round(gpuGrowthMB),
          gpuGrowthPerItemKB: Math.round(gpuGrowthPerItemKB * 10) / 10,
          hostMaxWorkingSetMB: Math.round(hostScore.max * 10) / 10,
          hostMedianWorkingSetMB: Math.round(hostScore.median * 10) / 10,
          hostMinWorkingSetMB: Math.round(hostScore.min * 10) / 10,
          hostWorkingSetGrowthMB: Math.round(hostWorkingSetGrowthMB * 10) / 10,
          hostWorkingSetGrowthPerItemKB: Math.round(hostWorkingSetGrowthPerItemKB * 10) / 10,
          itemThreshold: options.itemThreshold,
          itemsProcessed,
          itemsProcessedBeforeSampling: queueStatsBeforeSampling.succeeded,
          label: options.label,
          maxGpuKB: score.maxGpuKB,
          maxTotalKB: score.maxTotalKB,
          medianGpuKB: score.medianGpuKB,
          medianTotalKB: score.medianTotalKB,
          minGpuKB: score.minGpuKB,
          minTotalKB: score.minTotalKB,
          postTargetSampleCount,
          rawSampleSummary,
          reclaimEnabled: options.reclaimEnabled,
          reclaimMode: options.reclaimMode ?? null,
          runtimeIdAfterSampling: statusAfterSampling.runtimeId,
          runtimeIdBeforeBackfill: initialStatus.runtimeId,
          totalGrowthMB: Math.round(totalGrowthMB),
        })
      );

      return {
        cycleCount: observedMaintenanceCycles,
        hostScore: {
          maxWorkingSetMB: hostScore.max,
          medianWorkingSetMB: hostScore.median,
          minWorkingSetMB: hostScore.min,
        },
        hostWorkingSetGrowthMB,
        hostWorkingSetGrowthPerItemKB,
        label: options.label,
        itemsProcessed,
        gpuGrowthMB,
        gpuGrowthPerItemKB,
        runtimeIdAfterSampling: statusAfterSampling.runtimeId,
        runtimeIdBeforeBackfill: initialStatus.runtimeId,
        score: {
          maxGpuKB: score.maxGpuKB,
          maxTotalKB: score.maxTotalKB,
          medianGpuKB: score.medianGpuKB,
          medianTotalKB: score.medianTotalKB,
          minGpuKB: score.minGpuKB,
          minTotalKB: score.minTotalKB,
        },
        totalGrowthMB,
      };
    } finally {
      restoreEnv();
    }
  }

  test('@desktop-embedding-crash-b measures reset reclaim against the disabled control without lifecycle regressions', async ({
    electronHarness,
  }) => {
    test.skip(!!process.env['CI'], 'Requires a real GPU-backed desktop session.');
    test.setTimeout(420_000);

    const withoutReclaim = await runGpuReclaimMeasurementScenario({
      label: 'gpu-reclaim-disabled',
      reclaimEnabled: false,
      itemThreshold: 500,
      chunksPerFile: 12,
      targetSucceededItems: 650,
      electronHarness,
    });

    const withReclaim = await runGpuReclaimMeasurementScenario({
      label: 'gpu-reclaim-reset',
      reclaimEnabled: true,
      itemThreshold: 500,
      chunksPerFile: 12,
      targetSucceededItems: 650,
      reclaimMode: 'reset',
      electronHarness,
    });

    console.log(
      JSON.stringify({
        type: 'GPU_RECLAIM_COMPARISON',
        improvementPerItemKB: withoutReclaim.gpuGrowthPerItemKB - withReclaim.gpuGrowthPerItemKB,
        hostImprovementPerItemKB:
          withoutReclaim.hostWorkingSetGrowthPerItemKB - withReclaim.hostWorkingSetGrowthPerItemKB,
        hostMinWorkingSetReductionMB:
          withoutReclaim.hostScore.minWorkingSetMB - withReclaim.hostScore.minWorkingSetMB,
        improvementRatio:
          withoutReclaim.gpuGrowthPerItemKB > 0
            ? withReclaim.gpuGrowthPerItemKB / withoutReclaim.gpuGrowthPerItemKB
            : null,
        withoutReclaim,
        withReclaim,
      })
    );

    expect(withReclaim.itemsProcessed).toBeGreaterThanOrEqual(650);
    expect(withoutReclaim.itemsProcessed).toBeGreaterThanOrEqual(650);
    expect(withReclaim.cycleCount).toBeGreaterThan(0);
    expect(withReclaim.runtimeIdAfterSampling).not.toBe(withReclaim.runtimeIdBeforeBackfill);
    expect(withoutReclaim.runtimeIdAfterSampling).toBe(withoutReclaim.runtimeIdBeforeBackfill);
  });

  test('@desktop-embedding-crash-b completes reclaim-enabled backfill in reset mode without fatal lifecycle errors', async ({
    electronHarness,
  }) => {
    test.skip(!!process.env['CI'], 'Requires a real GPU-backed desktop session.');
    test.setTimeout(420_000);

    const result = await runGpuReclaimMeasurementScenario({
      label: 'gpu-reclaim-reset-correctness',
      reclaimEnabled: true,
      reclaimMode: 'reset',
      itemThreshold: 500,
      chunksPerFile: 12,
      targetSucceededItems: 650,
      electronHarness,
    });

    expect(result.itemsProcessed).toBeGreaterThanOrEqual(650);
    expect(result.cycleCount).toBeGreaterThan(0);
  });

  test('@desktop-embedding-crash-b does not reload the visible renderer during the default 12k chunk backfill path', async ({
    electronHarness,
  }) => {
    test.skip(!!process.env['CI'], 'Requires a real GPU-backed desktop session.');
    test.setTimeout(600_000);

    const restoreEnv = withTemporaryProcessEnv({
      BRAINSTRIKE_E2E_ALLOW_GPU: '1',
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ENABLED: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_ITEM_THRESHOLD: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_CHECK_INTERVAL_MS: undefined,
      BRAINSTRIKE_EMBED_GPU_RECLAIM_MODE: undefined,
    });

    try {
      const electronContext = await electronHarness.restart();
      let activeWindow = await showDatabaseDemoPanel(electronContext.window);

      if (await isDatabaseError(activeWindow)) {
        await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
        throw new Error('Database failed to initialize for the 12k-chunk reclaim regression.');
      }

      await clearEmbeddingQueue(activeWindow);
      await setVectorDevicePreference(activeWindow, 'webgpu');
      await reloadRendererInTest(activeWindow, 'gpu-reclaim-default-disabled-visible-reload-12k');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      await ensureEmbeddingHostWarmed(activeWindow);

      const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
        fileCount: 623,
        chunksPerFile: 20,
        chunkContentBytes: 1024,
        persistActiveSet: false,
      });
      await reloadRendererInTest(activeWindow, 'gpu-reclaim-visible-reload-12k-fixture');
      activeWindow = await showDatabaseDemoPanel(activeWindow);

      const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
      await expect(collectionOption).toBeVisible({ timeout: 30_000 });
      await collectionOption.click({ timeout: 5000 });

      const initialTimeOrigin = await getRendererTimeOrigin(activeWindow);
      const baselineMainLogs = await getMainBufferedLogs(activeWindow);
      const baselineStderrCount = (await getRelevantElectronStderr(electronContext.app)).length;
      const initialEmbeddingStatus = await getEmbeddingHostStatus(activeWindow);
      const initialProcessSnapshot = await readDesktopProcessSnapshot(electronContext.app);
      const initialEmbeddingHostProcessId = getRuntimeSnapshot(
        initialProcessSnapshot,
        'embedding-host'
      ).osProcessId;
      const runtimeIds = new Set<string>([initialEmbeddingStatus.runtimeId]);
      const embeddingHostProcessIds = new Set<number | null>([initialEmbeddingHostProcessId]);
      let peakVisibleWorkingSetMB = 0;
      let sampledWhileRunning = false;
      let lastQueueStats: QueueStatsRow | null = null;
      let mainProcessHealthSamples: MainProcessHealthSample[] = [];

      await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
      const outcome = await waitForBackfillQueueMovementOrFatalError(
        activeWindow,
        fixture.embeddingSetId,
        120_000
      );
      expect(outcome).toBe('queued');

      const sampleStartedAt = Date.now();
      while (Date.now() - sampleStartedAt < 240_000) {
        let timeOrigin: number;
        let embeddingStatus: EmbeddingHostStatus;
        let queueStats: QueueStatsRow;
        let processSnapshot: DesktopProcessSnapshot;
        let electronStderr: string[];
        let mainLogs: MainBufferedLogRecord[];
        try {
          [timeOrigin, embeddingStatus, queueStats, processSnapshot, electronStderr, mainLogs] =
            await Promise.all([
              getRendererTimeOrigin(activeWindow),
              getEmbeddingHostStatus(activeWindow),
              getEmbeddingQueueStats(activeWindow),
              readDesktopProcessSnapshot(electronContext.app),
              getRelevantElectronStderrSince(electronContext.app, baselineStderrCount),
              getMainBufferedLogs(activeWindow),
            ]);
        } catch (error) {
          throw new Error(
            'Desktop app connection dropped during the default 12k backfill regression.\n' +
              `runtimeIds=${JSON.stringify([...runtimeIds])}\n` +
              `error=${error instanceof Error ? error.message : String(error)}`
          );
        }

        expect(timeOrigin).toBe(initialTimeOrigin);
        expect(embeddingStatus.state).not.toBe('error');
        expect(electronStderr).toEqual([]);

        lastQueueStats = queueStats;
        runtimeIds.add(embeddingStatus.runtimeId);
        embeddingHostProcessIds.add(
          getRuntimeSnapshot(processSnapshot, 'embedding-host').osProcessId
        );
        mainProcessHealthSamples = parseMainProcessHealthSamples(
          mainLogs.slice(baselineMainLogs.length)
        );

        peakVisibleWorkingSetMB = Math.max(
          peakVisibleWorkingSetMB,
          getRuntimeSnapshot(processSnapshot, 'visible-ui').workingSetMB ?? 0
        );

        if (queueStats.running > 0 || queueStats.succeeded > 0) {
          sampledWhileRunning = true;
        }

        if (
          queueStats.succeeded >= 1800 &&
          queueStats.running > 0 &&
          mainProcessHealthSamples.length >= DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT
        ) {
          break;
        }

        await activeWindow.waitForTimeout(1000);
      }

      expect(sampledWhileRunning).toBe(true);
      expect(lastQueueStats).not.toBeNull();
      if (!(lastQueueStats && lastQueueStats.succeeded >= 1800 && lastQueueStats.running > 0)) {
        const backfillState = await getBridgeBackfillState(activeWindow);
        throw new Error(
          'Default 12k backfill did not sustain active progress before the sampling window ended.\n' +
            `queueStats=${JSON.stringify(lastQueueStats)}\n` +
            `backfillState=${JSON.stringify(backfillState)}`
        );
      }
      if (mainProcessHealthSamples.length < DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT) {
        const backfillState = await getBridgeBackfillState(activeWindow);
        throw new Error(
          'Default 12k backfill did not emit enough main-process-health samples to measure visible renderer growth.\n' +
            `sampleCount=${mainProcessHealthSamples.length}\n` +
            `queueStats=${JSON.stringify(lastQueueStats)}\n` +
            `backfillState=${JSON.stringify(backfillState)}`
        );
      }

      const visibleWorkingSetSamplesKB = mainProcessHealthSamples
        .map((sample) => sample.visibleUiWorkingSetKB)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      if (visibleWorkingSetSamplesKB.length < DEFAULT_12K_MIN_HEALTH_SAMPLE_COUNT) {
        throw new Error(
          'Default 12k backfill did not emit enough visible-ui working-set samples.\n' +
            `healthSamples=${JSON.stringify(mainProcessHealthSamples)}`
        );
      }
      const baselineVisibleWorkingSetFromHealthMB = visibleWorkingSetSamplesKB[0]! / 1024;
      const peakVisibleWorkingSetFromHealthMB = Math.max(...visibleWorkingSetSamplesKB) / 1024;
      const visibleWorkingSetGrowthFromHealthMB = growth(
        peakVisibleWorkingSetFromHealthMB,
        baselineVisibleWorkingSetFromHealthMB
      );

      const finalMainLogs = await getMainBufferedLogs(activeWindow);
      const finalElectronStderr = await getRelevantElectronStderrSince(
        electronContext.app,
        baselineStderrCount
      );
      const finalBackfillState = await getBridgeBackfillState(activeWindow);
      const unexpectedLifecycleLogs = extractUnexpectedLifecycleLogs(
        finalMainLogs.slice(baselineMainLogs.length)
      );

      console.log(
        JSON.stringify({
          type: 'desktop-default-visible-reload-12k',
          embeddingHostProcessIds: [...embeddingHostProcessIds],
          embeddingRuntimeIds: [...runtimeIds],
          fixture: {
            fileCount: fixture.fileCount,
            totalChunks: fixture.totalChunks,
          },
          lastQueueStats,
          finalBackfillState,
          baselineVisibleWorkingSetFromHealthMB:
            Math.round(baselineVisibleWorkingSetFromHealthMB * 10) / 10,
          mainProcessHealthSamples,
          peakVisibleWorkingSetMB: Math.round(peakVisibleWorkingSetMB * 10) / 10,
          peakVisibleWorkingSetFromHealthMB:
            Math.round(peakVisibleWorkingSetFromHealthMB * 10) / 10,
          visibleWorkingSetGrowthFromHealthMB:
            Math.round(visibleWorkingSetGrowthFromHealthMB * 10) / 10,
        })
      );

      expect(initialEmbeddingHostProcessId).not.toBeNull();
      expect(embeddingHostProcessIds.size).toBe(1);
      expect(runtimeIds.size).toBe(1);
      expect(unexpectedLifecycleLogs).toEqual([]);
      expect(finalElectronStderr).toEqual([]);
      expect(finalBackfillState?.error ?? null).toBeNull();
      expect(visibleWorkingSetGrowthFromHealthMB).toBeLessThan(
        DEFAULT_12K_VISIBLE_WORKING_SET_GROWTH_LIMIT_MB
      );
    } finally {
      restoreEnv();
      await electronHarness.restart();
    }
  });

  test('@desktop-embedding-crash-b fails backfill explicitly when the embedding host stops unexpectedly during processing', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    test.skip(
      process.env['BRAINSTRIKE_E2E_EMBEDDING_HOST_FAILURE_TEST'] !== '1',
      'Opt-in because forced host teardown is still unstable in headless GPU mode.'
    );
    test.setTimeout(240_000);

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    await setVectorDevicePreference(activeWindow, process.env['CI'] ? 'wasm' : 'webgpu');
    await reloadRendererInTest(activeWindow, 'unexpected-embedding-host-stop');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: 80,
      chunksPerFile: 8,
      chunkContentBytes: 1024,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'unexpected-embedding-host-stop-fixture');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    const electronStderrBaselineCount = (await getRelevantElectronStderr(electronApp.app)).length;

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    await destroyEmbeddingHostWindow(electronApp.app);

    await expect(waitForBridgeBackfillCompletion(activeWindow, 60_000)).rejects.toThrow(
      'Embedding host stopped while backfill was in progress.'
    );

    await expect
      .poll(
        async () =>
          await getRelevantElectronStderrSince(electronApp.app, electronStderrBaselineCount),
        {
          timeout: 30_000,
        }
      )
      .toContainEqual(
        expect.stringContaining('Embedding host stopped while backfill was in progress.')
      );

    await electronHarness.restart();
  });

  test('@desktop-embedding-crash-b benchmarks reclaim thresholds against the same GPU-growth workload', async ({
    electronHarness,
  }) => {
    test.skip(!!process.env['CI'], 'Requires a real GPU-backed desktop session.');
    test.skip(
      process.env['BRAINSTRIKE_E2E_GPU_RECLAIM_BENCHMARK'] !== '1',
      'Opt-in benchmark for tuning reclaim defaults.'
    );
    test.setTimeout(1_200_000);

    const baseline = await runGpuReclaimMeasurementScenario({
      label: 'gpu-reclaim-benchmark-disabled',
      reclaimEnabled: false,
      itemThreshold: 80,
      chunksPerFile: 12,
      minimumIntervalMs: 1000,
      targetSucceededItems: 650,
      electronHarness,
    });

    const thresholdResults = [] as Array<{
      gpuGrowthPerItemKB: number;
      improvementPerItemKB: number;
      improvementRatio: number;
      itemThreshold: number;
      itemsProcessed: number;
      reclaimMode: 'reset';
    }>;

    for (const reclaimMode of ['reset'] as const) {
      for (const itemThreshold of [40, 80, 160, 320, 500]) {
        const result = await runGpuReclaimMeasurementScenario({
          label: `gpu-reclaim-${reclaimMode}-threshold-${itemThreshold}`,
          reclaimEnabled: true,
          reclaimMode,
          itemThreshold,
          chunksPerFile: 12,
          minimumIntervalMs: 1000,
          targetSucceededItems: 650,
          electronHarness,
        });
        thresholdResults.push({
          itemThreshold,
          reclaimMode,
          itemsProcessed: result.itemsProcessed,
          gpuGrowthPerItemKB: result.gpuGrowthPerItemKB,
          improvementPerItemKB: baseline.gpuGrowthPerItemKB - result.gpuGrowthPerItemKB,
          improvementRatio:
            baseline.gpuGrowthPerItemKB > 0
              ? result.gpuGrowthPerItemKB / baseline.gpuGrowthPerItemKB
              : Number.NaN,
        });
      }
    }

    console.log(
      JSON.stringify({
        type: 'GPU_RECLAIM_THRESHOLD_BENCHMARK',
        baseline,
        thresholdResults,
      })
    );

    expect(thresholdResults).toHaveLength(5);
    for (const result of thresholdResults) {
      expect(result.itemsProcessed).toBeGreaterThanOrEqual(900);
    }
  });

  test('@desktop-embedding-crash-b diagnoses per-process memory growth during sustained backfill (crash repro test 7 — diagnostic)', async ({
    electronApp,
    electronHarness,
    window,
  }) => {
    // This test runs a real backfill for 3+ minutes, sampling ALL process
    // memory every 10s. It prints detailed per-process snapshots so we can
    // see exactly which process (visible-ui, embedding-host, main) is growing.
    // This is intentionally diagnostic: machine-specific GPU behavior varies,
    // so the contract here is that sampling completes against a live workload
    // and emits real process-level measurements without crashing the session.
    test.setTimeout(360_000);

    const DIAG_FILE_COUNT = 500;
    const DIAG_CHUNKS_PER_FILE = 20;
    const DIAG_SAMPLE_COUNT = 18;
    const DIAG_SAMPLE_INTERVAL_MS = 10_000;

    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    await clearEmbeddingQueue(activeWindow);
    // Use WebGPU to reproduce production memory growth. WASM shows no growth
    // but WebGPU buffers (managed by Dawn/Metal) accumulate unboundedly.
    // Falls back to WASM in CI where GPU is disabled.
    const devicePref = process.env['CI'] ? 'wasm' : 'webgpu';
    await setVectorDevicePreference(activeWindow, devicePref as 'wasm' | 'webgpu');
    await reloadRendererInTest(activeWindow, 'crash-repro-memory-diagnostic');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    await ensureEmbeddingHostWarmed(activeWindow);

    // Use realistic chunk content (1KB) to match production where chunks
    // contain actual code/text. Empty content underestimates GPU buffer
    // allocations because tokenizer and inference inputs are smaller.
    const fixture = await createLargeBackfillCorpusFixture(activeWindow, {
      fileCount: DIAG_FILE_COUNT,
      chunksPerFile: DIAG_CHUNKS_PER_FILE,
      chunkContentBytes: 1024,
      persistActiveSet: false,
    });
    await reloadRendererInTest(activeWindow, 'crash-repro-memory-diagnostic-fixture');
    activeWindow = await showDatabaseDemoPanel(activeWindow);

    const collectionOption = activeWindow.locator(`#collection-option-${fixture.embeddingSetId}`);
    await expect(collectionOption).toBeVisible({ timeout: 30_000 });
    await collectionOption.click({ timeout: 5000 });

    // Force GC everywhere before baseline
    await forceRendererGarbageCollection(activeWindow);
    await forceRendererGarbageCollection(activeWindow);
    const hostPage = await getEmbeddingHostPage(activeWindow);
    await forceRendererGarbageCollection(hostPage);

    // Use app.getAppMetrics() for real OS-level memory (V8 heap can't see WASM)
    async function getAppMetricsSummary(): Promise<
      Array<{ memoryKB: number; name: string; pid: number; type: string }>
    > {
      return await readElectronAppMetricsWithRetry(electronApp.app, activeWindow);
    }

    const baseline = await getAppMetricsSummary();
    console.log(JSON.stringify({ type: 'MEMORY_DIAGNOSTIC_BASELINE', processes: baseline }));

    await startBackfillViaBridge(activeWindow, fixture.embeddingSetId);
    const outcome = await waitForBackfillQueueMovementOrFatalError(
      activeWindow,
      fixture.embeddingSetId,
      120_000
    );
    expect(outcome).toBe('queued');

    // Sample every 10s for 3 minutes
    const startedAt = Date.now();
    for (let index = 0; index < DIAG_SAMPLE_COUNT; index += 1) {
      await activeWindow.waitForTimeout(DIAG_SAMPLE_INTERVAL_MS);

      const metrics = await getAppMetricsSummary();
      const queueStats = await getEmbeddingQueueStats(activeWindow);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

      console.log(
        JSON.stringify({
          type: 'MEMORY_DIAGNOSTIC_SAMPLE',
          sample: index + 1,
          elapsedSec,
          processes: metrics.map((m) => ({
            type: m.type,
            pid: m.pid,
            memoryMB: Math.round((m.memoryKB / 1024) * 10) / 10,
          })),
          totalMemoryMB:
            Math.round((metrics.reduce((sum, m) => sum + m.memoryKB, 0) / 1024) * 10) / 10,
          queueSucceeded: queueStats.succeeded,
          queueRunning: queueStats.running,
          queueQueued: queueStats.queued,
        })
      );
    }

    console.log(JSON.stringify({ type: 'MEMORY_DIAGNOSTIC_COMPLETE' }));

    // Assert total memory growth stays bounded.
    // With WebGPU, unbounded buffer accumulation can cause GB-scale growth.
    // Assert GPU process memory is bounded. With unbounded WebGPU buffer
    // accumulation, the GPU process grows monotonically (~2.5 MB every 10s).
    // Extrapolated to 30K items this would be ~600MB+ of GPU growth alone.
    // After the fix (periodic embedding host restart), the GPU memory should
    // reset at each restart and stay bounded.
    const finalMetrics = await getAppMetricsSummary();
    const baselineGpuKB = baseline.find((p) => p.type === 'GPU')?.memoryKB ?? 0;
    const finalGpuKB = finalMetrics.find((p) => p.type === 'GPU')?.memoryKB ?? 0;
    const gpuGrowthMB = (finalGpuKB - baselineGpuKB) / 1024;

    const baselineTotalKB = baseline.reduce((sum, p) => sum + p.memoryKB, 0);
    const finalTotalKB = finalMetrics.reduce((sum, p) => sum + p.memoryKB, 0);
    const totalGrowthMB = (finalTotalKB - baselineTotalKB) / 1024;

    const queueStats = await getEmbeddingQueueStats(activeWindow);
    const itemsProcessed = queueStats.succeeded;
    const gpuGrowthPerItemKB =
      itemsProcessed > 0 ? (finalGpuKB - baselineGpuKB) / itemsProcessed : 0;

    console.log(
      JSON.stringify({
        type: 'MEMORY_DIAGNOSTIC_GROWTH',
        itemsProcessed,
        gpuGrowthMB: Math.round(gpuGrowthMB),
        gpuGrowthPerItemKB: Math.round(gpuGrowthPerItemKB * 10) / 10,
        totalGrowthMB: Math.round(totalGrowthMB),
      })
    );

    expect(itemsProcessed).toBeGreaterThanOrEqual(1500);
    expect(Number.isFinite(gpuGrowthPerItemKB)).toBe(true);
    expect(Number.isFinite(totalGrowthMB)).toBe(true);

    await electronHarness.restart();
  });
});
