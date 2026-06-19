import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { getRendererLogRecords } from './embedding-worker-renderer.shared';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/**
 * LIVE REPRODUCTION (issue: "added a new root mid-session and the indexer did
 * not pick up the new files").
 *
 * Boots a workspace with ONE root (root #1) seeded in the desktop rootsList,
 * lets the REAL background-indexing pipeline import it, then adds a SECOND root
 * (root #2) MID-SESSION through the REAL "Add Folder to Workspace" button. The
 * native OS picker is replaced by BRAINSTRIKE_E2E_REAL_ROOT_PATH (a real
 * on-disk directory the real adapter still stats), so nothing in the code path
 * under test — addRootDirectory -> fs:addRoot -> registerRoot -> reconcileRoots
 * -> resolveDbRootId -> sync loop — is mocked.
 *
 * Both roots are real directories with real files, so "0 file_records for
 * root #2" can only mean the new root was dropped, never "the folder was empty".
 *
 * The __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ snapshot triangulates the failure:
 *   - expectedCounts: does the indexer SEE root #2's files? (discovery)
 *   - roots:          did reconcileRoots INSERT a row for root #2? (registration)
 *   - fileRecordsByRoot (root_id): did the sync IMPORT root #2's files? (sync)
 */

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
  roots?: Record<string, unknown>[];
  syncStatus?: { lastError?: string | null; state?: string };
}

function makeRootDir(label: string, fileCount: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `brainstrike-midsession-${label}-`));
  mkdirSync(path.join(dir, 'nested'), { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    const sub = i % 3 === 0 ? 'nested' : '.';
    // Non-trivial content so chunking + embedding takes real work (sustains
    // DB/pipeline load while a second root is added mid-flight).
    const body = Array.from(
      { length: 40 },
      (_, line) =>
        `export const ${label}_${i}_${line} = ${line}; // indexable line ${line} for ${label}`
    ).join('\n');
    writeFileSync(path.join(dir, sub, `${label}-${i}.ts`), `${body}\n`);
  }
  return dir;
}

// Created at module load so BRAINSTRIKE_E2E_REAL_ROOT_PATH is set BEFORE the
// electron harness launches the app (it reads process.env at launch time).
// root #1 stays actively indexing when root #2 is added — the realistic
// "added a folder while the indexer was busy" condition (real-stack smoke that
// the fix keeps mid-session adds working end to end).
const ROOT_ONE_FILE_COUNT = 150;
const ROOT_ONE_DIR = makeRootDir('root1', ROOT_ONE_FILE_COUNT);
const ROOT_TWO_DIR = makeRootDir('root2', 3);
// The "Add Folder" pick returns this real directory instead of an OS dialog.
process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = ROOT_TWO_DIR;

const ADD_FOLDER_LABEL = 'Add Folder to Workspace';

async function readSnapshot(page: Page): Promise<WorkspaceIndexDebugSnapshot> {
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

async function waitForDebugApi(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      typeof (globalThis as typeof globalThis & { __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: unknown })
        .__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__ === 'object',
    undefined,
    { timeout: 60_000 }
  );
}

function fileCountForRootPath(snapshot: WorkspaceIndexDebugSnapshot, rootDir: string): number {
  // roots rows map path -> id; file_records group by root_id. Join them so we
  // can ask "how many file_records does the root at <path> have?".
  const rootRow = (snapshot.roots ?? []).find((row) => row['path'] === rootDir);
  const rootId = rootRow?.['id'];
  if (typeof rootId !== 'string') {
    return 0;
  }
  const fileRow = snapshot.fileRecordsByRoot.find((row) => row['root_id'] === rootId);
  const count = fileRow?.['file_count'];
  return typeof count === 'number' ? count : 0;
}

function expectedFilesForRootPath(snapshot: WorkspaceIndexDebugSnapshot, rootDir: string): number {
  return snapshot.expectedCounts.find((row) => row.rootPath === rootDir)?.expectedFileCount ?? 0;
}

async function pollUntil(
  page: Page,
  predicate: (snapshot: WorkspaceIndexDebugSnapshot) => boolean,
  timeoutMs: number,
  label: string
): Promise<WorkspaceIndexDebugSnapshot> {
  const startedAt = Date.now();
  let last: WorkspaceIndexDebugSnapshot | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    last = await readSnapshot(page);
    if (predicate(last)) {
      return last;
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(
    `Timed out (${timeoutMs}ms) waiting for ${label}. Last snapshot: ${JSON.stringify(last, null, 2)}`
  );
}

test.describe('Mid-session add root indexing', () => {
  test('@desktop-mid-session-add-root indexes a root added after the workspace is running', async ({
    window: page,
  }) => {
    test.setTimeout(8 * 60 * 1000);

    // 1) Seed an already-running workspace with root #1 (boot/restore path).
    await page.evaluate(
      async ({ rootOne }) => {
        const storage = (
          globalThis as typeof globalThis & {
            electronAPI?: { storage?: { setItem?: (k: string, v: string) => Promise<void> } };
          }
        ).electronAPI?.storage;
        if (!storage?.setItem) {
          throw new Error('electronAPI.storage.setItem is unavailable');
        }
        await storage.setItem('lastFolderPath', rootOne);
        await storage.setItem(
          'rootsList',
          JSON.stringify([
            { addedAt: 1_800_000_000_000, path: rootOne, rootId: 'mid-session-root-1' },
          ])
        );
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
      { rootOne: ROOT_ONE_DIR }
    );

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'mid-session-add-root-seeded');
    await waitForDebugApi(page);

    await page.evaluate(async () => {
      const api = (
        globalThis as typeof globalThis & {
          __BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__?: {
            configure: (o: { policyPreset: 'full-root' }) => void;
            triggerFullSync: () => void;
          };
        }
      ).__BRAINSTRIKE_WORKSPACE_INDEX_DEBUG__;
      if (!api) {
        throw new Error('Workspace Index debug API unavailable after seeding reload');
      }
      api.configure({ policyPreset: 'full-root' });
      api.triggerFullSync();
    });

    // 2) Wait until root #1 has STARTED importing but is NOT yet done (it has
    //    200 files) — so root #2 is added while the pipeline is under load.
    const afterRootOne = await pollUntil(
      page,
      (snap) => fileCountForRootPath(snap, ROOT_ONE_DIR) >= 5,
      4 * 60 * 1000,
      'root #1 to begin importing under load'
    );
    expect(fileCountForRootPath(afterRootOne, ROOT_ONE_DIR)).toBeGreaterThanOrEqual(5);
    // eslint-disable-next-line no-console
    console.log(
      `[repro] root #1 mid-flight file_count=${fileCountForRootPath(afterRootOne, ROOT_ONE_DIR)} (of ${ROOT_ONE_FILE_COUNT}) — adding root #2 now`
    );

    // 3) Add root #2 MID-SESSION via the REAL Add Folder button.
    const addFolderButton = page.getByRole('button', { name: ADD_FOLDER_LABEL });
    await expect(addFolderButton).toBeVisible({ timeout: 30_000 });
    await addFolderButton.click();

    // 4) The indexer must IMPORT root #2's files. This is the assertion that
    //    reproduces the bug: if the new root is dropped, file_count stays 0.
    let reproSnapshot: WorkspaceIndexDebugSnapshot | null = null;
    try {
      reproSnapshot = await pollUntil(
        page,
        (snap) => fileCountForRootPath(snap, ROOT_TWO_DIR) >= 3,
        3 * 60 * 1000,
        'root #2 (mid-session add) to import its files'
      );
    } catch (error) {
      // Capture the decisive triangulation + renderer warnings before failing.
      const snap = await readSnapshot(page);
      const logs = (await getRendererLogRecords(page))
        .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
        .filter((line) =>
          /no mapped db root id|Mid-session root registration failed|Root reconciliation failed|coverage|unresolved/i.test(
            line
          )
        );
      throw new Error(
        [
          (error as Error).message,
          '',
          `root #2 path: ${ROOT_TWO_DIR}`,
          `root #2 expectedFileCount (discovery): ${expectedFilesForRootPath(snap, ROOT_TWO_DIR)}`,
          `root #2 has a roots-table row: ${Boolean(
            (snap.roots ?? []).find((r) => r['path'] === ROOT_TWO_DIR)
          )}`,
          `root #2 file_records: ${fileCountForRootPath(snap, ROOT_TWO_DIR)}`,
          `root #1 file_records (control): ${fileCountForRootPath(snap, ROOT_ONE_DIR)}`,
          `syncStatus: ${JSON.stringify(snap.syncStatus)}`,
          '',
          'relevant renderer logs:',
          ...(logs.length > 0 ? logs : ['(none captured)']),
        ].join('\n')
      );
    }

    expect(fileCountForRootPath(reproSnapshot, ROOT_TWO_DIR)).toBeGreaterThanOrEqual(3);
  });
});
