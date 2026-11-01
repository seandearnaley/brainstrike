import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FILE_EXPLORER_STORAGE_VERSION } from '@brainstrike/file-explorer/testing';
import { DEFAULT_STATE, type SerializedState } from '@brainstrike/types';
import type { Page } from 'playwright';
import { expect, test } from './fixtures/electron-fixture';
import { seedWorkspaceFolders } from './utils/seed-root';

interface BufferedLogRecord {
  readonly args: readonly unknown[];
  readonly bindings: Record<string, unknown>;
  readonly level: string;
  readonly message?: string;
  readonly scope?: string;
  readonly timestamp: number;
}

interface PersistedEnvelope<TState> {
  readonly state: TState;
  readonly version: number;
}

/**
 * Fixed RootId for the seeded state (storage v5): currentFolderId, folderStates
 * keys, and selection composite keys all carry this UUID, never the path. The
 * host's root record is seeded with the same id, so its restore resolves the
 * restored folder to this exact id after restart.
 */
const RESTORED_ROOT_ID = 'e2e-root-00000000-0000-4000-8000-000000000002';
const RESTORED_FILE_NAME = 'mock-file1.txt';

/** The restored folder: the harness's real disposable workspace, holding one file. */
interface RestoredFolder {
  readonly compositeKey: string;
  readonly filePath: string;
  /** Display name of the restored root (handle.name) — NOT its identity. */
  readonly name: string;
  readonly path: string;
  readonly tabId: string;
}

function restoredFolder(folderPath: string): RestoredFolder {
  const filePath = path.join(folderPath, RESTORED_FILE_NAME);
  const compositeKey = `${RESTORED_ROOT_ID}|@|${filePath}`;
  return {
    compositeKey,
    filePath,
    name: path.basename(folderPath),
    path: folderPath,
    tabId: `${RESTORED_ROOT_ID}:${compositeKey}`,
  };
}

function createPersistedFileExplorerState(
  folder: RestoredFolder
): PersistedEnvelope<SerializedState> {
  return {
    state: {
      activeRootIds: [RESTORED_ROOT_ID],
      currentFolderId: RESTORED_ROOT_ID,
      devInlineFixtureEnabled: DEFAULT_STATE.devInlineFixtureEnabled,
      excludeFilters: [...DEFAULT_STATE.excludeFilters],
      expandedDirectoryPaths: [],
      folderAccessOrder: [RESTORED_ROOT_ID],
      folderStates: {
        [RESTORED_ROOT_ID]: {
          excludeFilters: [...DEFAULT_STATE.excludeFilters],
          expandedDirectoryPaths: [],
          folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
          includeFilters: [...DEFAULT_STATE.includeFilters],
          includeProjectTree: DEFAULT_STATE.includeProjectTree,
          lastAccessed: Date.now(),
          lastActiveTab: DEFAULT_STATE.lastActiveTab,
          maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
          selectedFilePaths: [],
          useRegex: DEFAULT_STATE.useRegex,
          viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
        },
      },
      folderSummaryThreshold: DEFAULT_STATE.folderSummaryThreshold,
      includeFilters: [...DEFAULT_STATE.includeFilters],
      includeProjectTree: DEFAULT_STATE.includeProjectTree,
      isFiltersExpanded: DEFAULT_STATE.isFiltersExpanded,
      lastActiveTab: DEFAULT_STATE.lastActiveTab,
      maxSelectionCount: DEFAULT_STATE.maxSelectionCount,
      quickFilter: DEFAULT_STATE.quickFilter,
      rootDescriptors: {
        [RESTORED_ROOT_ID]: {
          displayName: folder.name,
          path: folder.path,
          rootId: RESTORED_ROOT_ID,
        },
      },
      selectedFilePaths: [],
      selectionModel: {
        explicitPaths: [],
        materializedAt: DEFAULT_STATE.selectionModel.materializedAt,
        materializedPaths: null,
        mode: DEFAULT_STATE.selectionModel.mode,
        queryDescriptor: DEFAULT_STATE.selectionModel.queryDescriptor,
      },
      useRegex: DEFAULT_STATE.useRegex,
      viewFilterPresetId: DEFAULT_STATE.viewFilterPresetId,
    },
    // Storage v5: older versions are discarded by the migration guard.
    version: FILE_EXPLORER_STORAGE_VERSION,
  };
}

function createPersistedTabState(folder: RestoredFolder): PersistedEnvelope<{
  activeTabId: string;
  tabs: Array<{ compositeKey: string; id: string; path: string }>;
}> {
  return {
    state: {
      activeTabId: folder.tabId,
      tabs: [
        {
          compositeKey: folder.compositeKey,
          id: folder.tabId,
          path: folder.filePath,
        },
      ],
    },
    version: 1,
  };
}

async function seedRestoredStartupState(page: Page, folder: RestoredFolder): Promise<void> {
  await writeFile(folder.filePath, 'Restored file content\n');
  const fileExplorerState = createPersistedFileExplorerState(folder);
  const tabState = createPersistedTabState(folder);

  await page.evaluate(
    ({ nextFileExplorerState, nextTabState }) => {
      localStorage.setItem('brainstrike:tab-manager.v1', JSON.stringify(nextTabState));

      localStorage.setItem(
        'brainstrike:file-explorer-storage-v5',
        JSON.stringify(nextFileExplorerState)
      );
    },
    { nextFileExplorerState: fileExplorerState, nextTabState: tabState }
  );
  // The host's open folders: the seeded record carries the fixed RootId, so the renderer's
  // restore on boot resolves the restored folder to this exact id.
  await seedWorkspaceFolders(page, { roots: [{ path: folder.path, rootId: RESTORED_ROOT_ID }] });
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

function recordContainsText(record: BufferedLogRecord, text: string): boolean {
  if (typeof record.message === 'string' && record.message.includes(text)) {
    return true;
  }

  return record.args.some((arg) => typeof arg === 'string' && arg.includes(text));
}

function isObjectWithNumber(
  value: unknown,
  key: string
): value is Record<string, number | string | boolean | null> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate[key] === 'number';
}

test.describe('Startup Restore Regression', () => {
  test('restores folder and active tab without startup churn signatures', async ({
    electronHarness,
    window,
  }) => {
    const folder = restoredFolder(electronHarness.getWorkspaceRoot());
    await seedRestoredStartupState(window, folder);
    const restartedContext = await electronHarness.restart();
    const restartedWindow = restartedContext.window;
    await expect(
      restartedWindow.getByRole('tab', { name: new RegExp(RESTORED_FILE_NAME, 'iu') })
    ).toBeVisible({ timeout: 15_000 });

    await restartedWindow.waitForTimeout(1000);

    const records = await getRendererLogRecords(restartedWindow);
    const directPathReadLogs = records.filter((record) =>
      recordContainsText(record, 'Using direct path read for file not in tree')
    );
    const lookupRetryLogs = records.filter((record) =>
      recordContainsText(record, 'Initial lookup failed, retrying')
    );
    const loadRootRestartLogs = records.filter((record) =>
      recordContainsText(record, 'loadRoot running - will reinitialize worker')
    );
    const loadRootCompletedLogs = records.filter((record) =>
      recordContainsText(record, 'loadRoot completed - handle map built')
    );
    const handleMapBuildLogs = records.filter((record) =>
      recordContainsText(record, 'buildHandleMap complete')
    );
    // Inits of the restored root, keyed by its id or (the churn BST-1957 fixed)
    // its path. The worker's empty mount reset (folderId '') is excluded: it is
    // the one legitimate no-root init (use-lazy-file-tree-no-root-reset.test.ts).
    const workerTreeInitializedLogs = records.filter((record) => {
      if (!recordContainsText(record, 'tree initialized')) {
        return false;
      }
      const details = record.args[1];
      const folderId =
        typeof details === 'object' && details !== null
          ? (details as { folderId?: unknown }).folderId
          : undefined;
      return folderId === RESTORED_ROOT_ID || folderId === folder.path;
    });
    const noOpWarmCacheLogs = records.filter((record) => {
      if (!recordContainsText(record, 'Warm cache effect: preloading folders')) {
        return false;
      }

      const details = record.args[0];
      return isObjectWithNumber(details, 'foldersToPreload') && details['foldersToPreload'] === 0;
    });
    const fileTreeMissingLogs = records.filter((record) =>
      recordContainsText(record, 'File missing from file tree after deferred retries')
    );
    const tokenCacheWorkerStartupLogs = records.filter((record) =>
      recordContainsText(record, 'TokenCacheProvider: creating worker pool')
    );
    const chunkingWorkerStartupLogs = records.filter((record) =>
      recordContainsText(record, 'Initializing chunking worker')
    );
    const tokenCacheWorkerFailureLogs = records.filter((record) =>
      recordContainsText(record, 'Token cache worker warmup failed after')
    );
    const tokenCacheWorkerCreateFailureLogs = records.filter((record) =>
      recordContainsText(record, 'TokenCacheProvider: failed to create worker pool')
    );
    const tokenCacheWorkerTerminationLogs = records.filter((record) =>
      recordContainsText(record, 'Token cache worker pool has been terminated')
    );
    const strictTokenCountingFailureLogs = records.filter((record) =>
      recordContainsText(record, 'Strict token counting failed')
    );
    const tokenCountingFailureLogs = records.filter((record) =>
      recordContainsText(record, 'Failed to count tokens')
    );
    const backgroundIndexerFailureLogs = records.filter((record) =>
      recordContainsText(record, 'Background token indexer entered failed state')
    );
    const chunkingWorkerFailureLogs = records.filter((record) =>
      recordContainsText(record, 'Chunking worker entered terminal failure state')
    );
    const sharedIndexSkipLogs = records.filter((record) =>
      recordContainsText(record, 'Skipping cache rebuild - using FileTreeIndex')
    );
    const restorationPrereqSkipLogs = records.filter((record) =>
      recordContainsText(record, '[Restoration Effect] Skipped - prerequisites not met')
    );
    const activeTabEffectLogs = records.filter((record) =>
      recordContainsText(record, 'Active tab effect triggered')
    );
    const activeTabBailLogs = records.filter((record) =>
      recordContainsText(record, 'Bailing: no activeTabId')
    );
    const selectionEffectLogs = records.filter((record) =>
      recordContainsText(record, 'Selection effect triggered')
    );
    const selectionEffectEarlyExitLogs = records.filter((record) =>
      recordContainsText(record, 'Selection effect exiting early')
    );
    const warmCacheSkipLogs = records.filter((record) =>
      recordContainsText(record, 'Warm cache effect skipped')
    );
    const tokenCacheRenderLogs = records.filter((record) =>
      recordContainsText(record, 'TokenCacheProvider render')
    );
    const tokenCacheReadinessLogs = records.filter((record) =>
      recordContainsText(record, 'TokenCacheProvider: readiness check')
    );
    const noHandleCacheLogs = records.filter((record) =>
      recordContainsText(record, 'Skipping restore check - no handle cache methods')
    );
    const sharedIndexLookupLogs = records.filter((record) =>
      recordContainsText(record, 'Shared file content lookups using FileTreeIndex')
    );
    const restorationWaitingLogs = records.filter((record) =>
      recordContainsText(record, '[Restoration Effect] Waiting for prerequisites')
    );
    const selectionWaitingLogs = records.filter((record) =>
      recordContainsText(record, 'Selection effect waiting for index prerequisites')
    );
    const warmCacheWaitingLogs = records.filter((record) =>
      recordContainsText(record, 'Warm cache effect waiting for prerequisites')
    );
    const tokenCachePersistenceLogs = records.filter((record) =>
      recordContainsText(record, 'TokenCacheProvider: persistence mode changed')
    );
    const fileContentWorkerNotReadyLogs = records.filter((record) =>
      recordContainsText(record, 'Worker not initialized, skipping file content loading')
    );
    const immediatePersistenceLogs = records.filter((record) =>
      recordContainsText(record, 'using immediate persistence')
    );
    const electronWorkerDisabledLogs = records.filter((record) =>
      recordContainsText(record, 'Web Worker disabled due to Electron environment')
    );
    const persistenceWorkerErrorLogs = records.filter((record) =>
      recordContainsText(record, 'Worker error occurred')
    );
    const persistenceWorkerGetFailureLogs = records.filter((record) =>
      recordContainsText(record, 'Worker getItem failed')
    );
    const persistenceWorkerSetFailureLogs = records.filter((record) =>
      recordContainsText(record, 'Worker setItem failed')
    );

    expect(directPathReadLogs).toHaveLength(0);
    expect(lookupRetryLogs).toHaveLength(0);
    expect(loadRootRestartLogs.length).toBeLessThanOrEqual(1);
    expect(loadRootCompletedLogs.length).toBeLessThanOrEqual(1);
    expect(handleMapBuildLogs.length).toBeLessThanOrEqual(1);
    expect(workerTreeInitializedLogs.length).toBeLessThanOrEqual(1);
    expect(noOpWarmCacheLogs).toHaveLength(0);
    expect(fileTreeMissingLogs).toHaveLength(0);
    expect(tokenCacheWorkerStartupLogs.length).toBeLessThanOrEqual(1);
    expect(chunkingWorkerStartupLogs).toHaveLength(0);
    expect(tokenCacheWorkerFailureLogs).toHaveLength(0);
    expect(tokenCacheWorkerCreateFailureLogs).toHaveLength(0);
    expect(tokenCacheWorkerTerminationLogs).toHaveLength(0);
    expect(strictTokenCountingFailureLogs).toHaveLength(0);
    expect(tokenCountingFailureLogs).toHaveLength(0);
    expect(backgroundIndexerFailureLogs).toHaveLength(0);
    expect(chunkingWorkerFailureLogs).toHaveLength(0);
    expect(sharedIndexSkipLogs).toHaveLength(0);
    expect(restorationPrereqSkipLogs).toHaveLength(0);
    expect(activeTabEffectLogs).toHaveLength(0);
    expect(activeTabBailLogs).toHaveLength(0);
    expect(selectionEffectLogs).toHaveLength(0);
    expect(selectionEffectEarlyExitLogs).toHaveLength(0);
    expect(warmCacheSkipLogs).toHaveLength(0);
    expect(tokenCacheRenderLogs).toHaveLength(0);
    expect(tokenCacheReadinessLogs).toHaveLength(0);
    expect(noHandleCacheLogs).toHaveLength(0);
    expect(sharedIndexLookupLogs).toHaveLength(0);
    expect(restorationWaitingLogs).toHaveLength(0);
    expect(selectionWaitingLogs).toHaveLength(0);
    expect(warmCacheWaitingLogs).toHaveLength(0);
    expect(tokenCachePersistenceLogs).toHaveLength(0);
    expect(fileContentWorkerNotReadyLogs).toHaveLength(0);
    expect(immediatePersistenceLogs).toHaveLength(0);
    expect(electronWorkerDisabledLogs).toHaveLength(0);
    expect(persistenceWorkerErrorLogs).toHaveLength(0);
    expect(persistenceWorkerGetFailureLogs).toHaveLength(0);
    expect(persistenceWorkerSetFailureLogs).toHaveLength(0);
  });
});
