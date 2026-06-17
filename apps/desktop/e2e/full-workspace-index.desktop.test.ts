import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getMainBufferedLogs, getRendererLogRecords } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

interface WorkspaceIndexExpectedCount {
  expectedFileCount: number;
  rootPath: string;
}

interface WorkspaceIndexDebugSnapshot {
  accessIssues?: Array<{ reason: string; source: string }>;
  chunkStatsByRoot: Record<string, unknown>[];
  expectedCounts: WorkspaceIndexExpectedCount[];
  fileRecordsByRoot: Record<string, unknown>[];
  jobQueue: Record<string, unknown>[];
  selectedDevicePreference?: {
    devicePref?: string;
    devicePrefConfigured?: boolean;
  };
  syncStatus?: {
    lastError?: string | null;
    state?: string;
  };
}

const ROOTS_ENV = 'BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_ROOTS';
const SINGLE_ROOT_ENV = 'BRAINSTRIKE_E2E_REAL_ROOT_PATH';
const DEVICE_ENV = 'BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_DEVICE';
const DEFAULT_TIMEOUT_MS = 90 * 60 * 1000;
const POLL_MS = 5000;
const NO_PROGRESS_TIMEOUT_MS = 120_000;

function parseConfiguredRoots(): string[] {
  const rawRoots = process.env[ROOTS_ENV]?.trim() || process.env[SINGLE_ROOT_ENV]?.trim() || '';
  if (!rawRoots) {
    return [];
  }
  return rawRoots
    .split(path.delimiter)
    .map((rootPath) => path.resolve(rootPath.trim()))
    .filter((rootPath) => rootPath.length > 0);
}

function readNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function sumRows(rows: Record<string, unknown>[], key: string): number {
  return rows.reduce((total, row) => total + readNumber(row, key), 0);
}

function hasBlockingQueueWork(snapshot: WorkspaceIndexDebugSnapshot): boolean {
  return snapshot.jobQueue.some((row) => {
    const state = String(row['state'] ?? '');
    return state === 'queued' || state === 'running' || state === 'failed';
  });
}

function assertSnapshotIsHealthy(
  snapshot: WorkspaceIndexDebugSnapshot,
  requiredDevice: string
): void {
  if (snapshot.accessIssues && snapshot.accessIssues.length > 0) {
    throw new Error(
      `Workspace Index debug access issues: ${JSON.stringify(snapshot.accessIssues)}`
    );
  }
  const state = snapshot.syncStatus?.state;
  if (state === 'blocked' || state === 'error') {
    throw new Error(
      `Workspace Index entered ${state}: ${snapshot.syncStatus?.lastError ?? 'unknown error'}`
    );
  }
  const selectedDevice = snapshot.selectedDevicePreference?.devicePref;
  if (selectedDevice && selectedDevice !== requiredDevice) {
    throw new Error(
      `Workspace Index device mismatch: expected ${requiredDevice}, selected ${selectedDevice}`
    );
  }
}

function isTerminalSnapshot(snapshot: WorkspaceIndexDebugSnapshot): boolean {
  const expectedFileCount = snapshot.expectedCounts.reduce(
    (total, root) => total + root.expectedFileCount,
    0
  );
  const fileRecordCount = sumRows(snapshot.fileRecordsByRoot, 'file_count');
  const chunkedFileCount = sumRows(snapshot.fileRecordsByRoot, 'chunked_file_count');
  const chunkCount = sumRows(snapshot.chunkStatsByRoot, 'chunk_count');
  const embeddedChunkCount = sumRows(snapshot.chunkStatsByRoot, 'embedded_chunk_count');
  return (
    expectedFileCount > 0 &&
    fileRecordCount === expectedFileCount &&
    chunkedFileCount === expectedFileCount &&
    chunkCount > 0 &&
    embeddedChunkCount === chunkCount &&
    !hasBlockingQueueWork(snapshot)
  );
}

async function readWorkspaceIndexSnapshot(page: {
  evaluate: <T>(pageFunction: () => Promise<T>) => Promise<T>;
}): Promise<WorkspaceIndexDebugSnapshot> {
  return await page.evaluate(async () => {
    const api = (
      globalThis as typeof globalThis & {
        __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
          snapshot: () => Promise<WorkspaceIndexDebugSnapshot>;
        };
      }
    ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;
    if (!api) {
      throw new Error('window.__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ is unavailable');
    }
    return await api.snapshot();
  });
}

test.describe('Full Workspace Index run', () => {
  test.skip(
    parseConfiguredRoots().length === 0,
    `Set ${ROOTS_ENV} or ${SINGLE_ROOT_ENV} to run the real full-root Workspace Index verifier.`
  );

  test('@desktop-full-workspace-index completes all configured roots', async ({
    window: page,
  }, testInfo) => {
    test.setTimeout(
      Number(process.env['BRAINSTRIKE_E2E_FULL_WORKSPACE_INDEX_TIMEOUT_MS']) || DEFAULT_TIMEOUT_MS
    );
    const startedAt = Date.now();

    const roots = parseConfiguredRoots();
    expect(roots.length).toBeGreaterThan(0);
    const firstRoot = roots[0];
    if (!firstRoot) {
      throw new Error('Full Workspace Index verifier has no configured roots.');
    }
    const requiredDevice = process.env[DEVICE_ENV]?.trim() || 'webgpu';
    const rootsList = roots.map((rootPath, index) => ({
      addedAt: 1_800_000_000_000 + index,
      path: rootPath,
      rootId: `workspace-index-e2e-root-${index + 1}`,
    }));

    await page.evaluate(
      async ({ firstRoot, persistedRoots }) => {
        const storage = (
          globalThis as typeof globalThis & {
            electronAPI?: {
              storage?: {
                setItem?: (key: string, value: string) => Promise<void>;
              };
            };
          }
        ).electronAPI?.storage;
        if (!storage?.setItem) {
          throw new Error('electronAPI.storage.setItem is unavailable');
        }
        await storage.setItem('lastFolderPath', firstRoot);
        await storage.setItem('rootsList', JSON.stringify(persistedRoots));
        localStorage.setItem(
          'background-indexing-preferences.v1',
          JSON.stringify({
            state: {
              enabled: true,
              indexingPolicyPreset: 'full-root',
              managedCollectionId: null,
              mode: 'root-folder-cache',
              paused: false,
            },
            version: 4,
          })
        );
        localStorage.setItem(
          'vector-preferences.v1',
          JSON.stringify({
            state: {
              devicePref: 'webgpu',
              devicePrefConfigured: true,
              reinitEveryN: 200,
              verboseOrtLogs: false,
            },
            version: 3,
          })
        );
      },
      { firstRoot, persistedRoots: rootsList }
    );

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'full-workspace-index-roots-seeded');

    await page.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
            configure: (options: { policyPreset: 'full-root' }) => void;
            triggerFullSync: () => void;
          };
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;
      if (!api) {
        throw new Error('Workspace Index debug API is unavailable after root seeding reload');
      }
      api.configure({ policyPreset: 'full-root' });
      api.triggerFullSync();
    });

    const snapshots: WorkspaceIndexDebugSnapshot[] = [];
    let lastProgressAt = Date.now();
    let lastProgressValue = -1;
    let stableTerminalPolls = 0;

    while (Date.now() - startedAt < testInfo.timeout - POLL_MS) {
      const snapshot = await readWorkspaceIndexSnapshot(page);
      snapshots.push(snapshot);
      assertSnapshotIsHealthy(snapshot, requiredDevice);

      const progressValue =
        sumRows(snapshot.fileRecordsByRoot, 'file_count') +
        sumRows(snapshot.fileRecordsByRoot, 'chunked_file_count') +
        sumRows(snapshot.chunkStatsByRoot, 'embedded_chunk_count');
      if (progressValue > lastProgressValue) {
        lastProgressValue = progressValue;
        lastProgressAt = Date.now();
      } else if (
        Date.now() - lastProgressAt > NO_PROGRESS_TIMEOUT_MS &&
        !isTerminalSnapshot(snapshot)
      ) {
        throw new Error(`Workspace Index made no progress for ${NO_PROGRESS_TIMEOUT_MS}ms`);
      }

      if (isTerminalSnapshot(snapshot)) {
        stableTerminalPolls += 1;
        if (stableTerminalPolls >= 2) {
          break;
        }
      } else {
        stableTerminalPolls = 0;
      }

      const logs = [...(await getRendererLogRecords(page)), ...(await getMainBufferedLogs(page))];
      const logText = JSON.stringify(logs);
      if (
        /DB host request timed out|Local embedding execution failed|uncaught|unhandled/i.test(
          logText
        )
      ) {
        throw new Error('Workspace Index fatal log pattern detected during full run');
      }

      await page.waitForTimeout(POLL_MS);
    }

    const finalSnapshot = snapshots.at(-1);
    if (!(finalSnapshot && isTerminalSnapshot(finalSnapshot))) {
      throw new Error('Workspace Index did not reach terminal full-run completion');
    }

    await writeFile(
      testInfo.outputPath('full-workspace-index-evidence.json'),
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          requiredDevice,
          roots,
          snapshots,
        },
        null,
        2
      ),
      'utf8'
    );
  });
});
