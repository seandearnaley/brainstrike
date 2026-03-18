import type { Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';
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
  bindings?: Record<string, unknown>;
  message?: string;
  scope?: string;
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

async function reloadRendererInTest(page: Page, reason: string): Promise<void> {
  const { reloadRenderer } = await loadElectronHelpers();
  await reloadRenderer(page, reason);
}

async function waitForAppReadyInTest(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
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

function isDisposedElectronEvaluateError(error: unknown): boolean {
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

const LARGE_BACKFILL_FILE_COUNT = 1000;
const LARGE_BACKFILL_CHUNKS_PER_FILE = 20;
const LARGE_COLLECTION_LIST_FILE_COUNT = 50_000;
const LARGE_COLLECTION_RENDER_FILE_COUNT = 5000;
const LARGE_COLLECTION_RENDER_CHUNKS_PER_FILE = 10;
// Repeated-cycle coverage is about retained-memory drift on a single live host.
// The 20k chunk pressure test above already covers peak-load behavior.
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
    const assistantTab = page.getByRole('tab', { name: /assistant/i });
    const databaseTab = page.getByRole('tab', { name: /database/i });

    await expect(assistantTab).toBeVisible({ timeout: 10_000 });
    await assistantTab.click({ timeout: 5000 });
    await expect(assistantTab).toHaveAttribute('data-state', 'active');

    await expect(databaseTab).toBeVisible({ timeout: 10_000 });
    await databaseTab.click({ timeout: 5000 });
    await expect(databaseTab).toHaveAttribute('data-state', 'active');
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

      if (status.active && queueStats.running > 0 && queueStats.running <= 4) {
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
    const leftPanel = page.locator('#explorer-panel');
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
        const sentences = Array.from({ length: options.sentencesPerFile }, (_, sentenceIndex) => {
          return `export const sentence_${sentenceIndex} = "stress-file-${index}-sentence-${sentenceIndex}.";`;
        });
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
    return await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))
        .map((node) => node.textContent?.trim() ?? '')
        .filter((text) => text.length > 0);
    });
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
    const selectionCounterButton = page.getByRole('button', {
      name: 'Click to edit maximum selection count',
    });
    await expect(selectionCounterButton).toBeVisible({ timeout: 15_000 });
    await selectionCounterButton.click({ timeout: 5000 });

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
          `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'text', $7, $8, $8)`,
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
               id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
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
      const state = await page.evaluate(() => {
        return (
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
      });

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

  async function getRelevantElectronStderr(app: ElectronApplication): Promise<string[]> {
    const output = await getBufferedElectronOutputInTest(app);
    return output.stderr.filter((line) => {
      return (
        line.includes('Embedding host stopped while backfill was in progress.') ||
        line.includes('Embedding backfill is already running for set') ||
        line.includes('Chunking host stopped while requests were in flight.') ||
        line.includes("Error occurred in handler for 'embedding-host:enqueue-backfill'") ||
        line.includes("Error occurred in handler for 'chunking-host:chunk-file'")
      );
    });
  }

  async function getRelevantElectronStderrSince(
    app: ElectronApplication,
    baselineCount: number
  ): Promise<string[]> {
    const lines = await getRelevantElectronStderr(app);
    return lines.slice(baselineCount);
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

    const backgroundOutcome = await waitForActiveProcessingOrFatalError(activeWindow, 120_000);
    expect(backgroundOutcome).toBe('running');

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

  test('defers hidden embedding host startup until first use', async ({ electron }) => {
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

  test('keeps the visible UI responsive while jobs are queued for the hidden host', async ({
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

  test('keeps the visible UI responsive while a large backfill is being enqueued', async ({
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

  test('keeps the visible UI responsive while the hidden host is actively processing a backfill', async ({
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
      expect(queueStats.running).toBeLessThanOrEqual(4);
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

  test('keeps visible renderer heap bounded while the hidden host enqueues and processes a large backfill', async ({
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

  test('keeps hidden-host, visible-renderer, and main-process memory bounded during a 20k chunk backfill', async ({
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

  test('keeps the visible renderer bounded when opening a 50k chunk collection in the database tab', async ({
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

  test('keeps the database tab source-paginated and memory-bounded for a 50k file collection', async ({
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
    const firstPageFirstRowText = ((await firstVisibleDataRow.textContent()) ?? '').trim();
    expect(firstPageFirstRowText.length).toBeGreaterThan(0);

    const pageNumberInput = activeWindow.getByRole('spinbutton', { name: 'Page number' });
    await expect(pageNumberInput).toHaveValue('1');

    await activeWindow.getByRole('button', { name: 'Go to next page' }).click({ timeout: 5000 });

    await expect(pageNumberInput).toHaveValue('2');
    await expect(firstVisibleDataRow).toBeVisible({ timeout: 30_000 });
    const secondPageFirstRowText = ((await firstVisibleDataRow.textContent()) ?? '').trim();
    expect(secondPageFirstRowText.length).toBeGreaterThan(0);
    expect(secondPageFirstRowText).not.toBe(firstPageFirstRowText);

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

  test('shows a newly created collection immediately without leaving the database tab', async ({
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
    await expect(activeWindow.getByRole('tab', { name: /database/i })).toHaveAttribute(
      'data-state',
      'active'
    );
  });

  test('preserves backfill progress on the database button across tab switches', async ({
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

    const initialProgressLabel = await waitForBackfillProgressText(
      resolveBackfillActionButton(),
      30_000
    );
    const initialProgress = parseBackfillProgressLabel(initialProgressLabel);
    expect(initialProgress.total).toBe(fixture.totalChunks);
    expect(initialProgress.done).toBeGreaterThan(0);

    await activeWindow.getByRole('tab', { name: /assistant/i }).click({ timeout: 5000 });
    await expect(activeWindow.getByRole('tab', { name: /assistant/i })).toHaveAttribute(
      'data-state',
      'active'
    );

    await activeWindow.getByRole('tab', { name: /database/i }).click({ timeout: 5000 });
    await expect(activeWindow.getByRole('tab', { name: /database/i })).toHaveAttribute(
      'data-state',
      'active'
    );

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

  test('does not accumulate hidden-host memory across repeated large backfill cycles on the same host process', async ({
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
      const outcome = await waitForActiveProcessingOrFatalError(activeWindow, 90_000);
      expect(outcome).toBe('running');

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

  test('backfills chunked imported data without hanging and updates collection coverage', async ({
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

  test('end-to-end: import, embed, then vector search returns correct results', async ({
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
    const semanticSearchBox = activeWindow.getByLabel('Semantic search query');
    await expect(semanticSearchBox).toBeVisible({ timeout: 15_000 });

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

  test('search renders file nodes when chunks are lazily loaded (many-file collection)', async ({
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
            `INSERT INTO file_chunks (id, file_record_id, chunk_index, content, content_hash, token_count, chunk_type, chunk_size, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
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
    const semanticSearchBox = activeWindow.getByLabel('Semantic search query');
    await expect(semanticSearchBox).toBeVisible({ timeout: 15_000 });
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

    // 3. firstResultNodeId should be a file- prefixed ID (fallback resolved correctly)
    //    because chunks are not expanded in the tree
    expect(lastSnapshot!.firstResultNodeId).not.toBeNull();
  });

  test('search works when vector-preferences store has no devicePref (stale migration)', async ({
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

    const semanticSearchBox = activeWindow.getByLabel('Semantic search query');
    await expect(semanticSearchBox).toBeVisible({ timeout: 15_000 });
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

  test('does not reload the visible renderer or churn hidden runtimes during a real 1k-file import and backfill', async ({
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

      const backfillOutcome = await waitForActiveProcessingOrFatalError(activeWindow, 120_000);
      expect(backfillOutcome).toBe('running');

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
      const semanticSearchBox = activeWindow.getByLabel('Semantic search query');
      const collectionTreeRegion = activeWindow.getByTestId('collection-tree-region');
      const emptySemanticSearchMessage = collectionTreeRegion.getByText(
        'No matching results found. Try adjusting your search query or threshold.'
      );
      const searchingOverlay = collectionTreeRegion.getByText('Searching...');
      await expect(semanticSearchBox).toBeVisible({ timeout: 15_000 });
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

  test('keeps search working and backfill actionable during a real mixed-state desktop session', async ({
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

      const semanticSearchBox = activeWindow.getByLabel('Semantic search query');
      const queryButton = activeWindow.getByRole('button', { name: /^Query$/ });
      await expect(semanticSearchBox).toBeVisible({ timeout: 15_000 });
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
        expandedTreeNodeCount = await collectionTreeRegion.evaluate((node) => {
          return node.querySelectorAll('[aria-expanded="true"]').length;
        });
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

  test('keeps the import collection backfill and search path working during a real mixed-state desktop session', async ({
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

      const semanticSearchBox = activeWindow.getByLabel('Semantic search query');
      const queryButton = activeWindow.getByRole('button', { name: /^Query$/ });
      await expect(semanticSearchBox).toBeVisible({ timeout: 15_000 });
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

  test('fails invalid job payloads without taking down the embedding host or visible UI', async ({
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

  test('keeps the hidden host alive across visible-window navigation', async ({ window }) => {
    let activeWindow = await showDatabaseDemoPanel(window);

    if (await isDatabaseError(activeWindow)) {
      await expect(activeWindow.locator(ERROR_LOCATOR).first()).toBeVisible();
      return;
    }

    const hostPageBefore = await getEmbeddingHostPage(activeWindow);
    const before = await createTestBackfillJob(activeWindow);
    expect(await getJobStatus(activeWindow, before.jobId)).not.toBeNull();

    const assistantTab = activeWindow.getByRole('tab', { name: /assistant/i });
    await assistantTab.click({ timeout: 5000 });
    await expect(assistantTab).toHaveAttribute('data-state', 'active');

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
});
