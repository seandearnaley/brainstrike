import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { readHostRootRecords } from './utils/agent-host-log';
import { seedPausedWorkspace } from './utils/foreground-latency-bench';
import {
  closeIndexingPopover,
  configureNativeIndex,
  type NativeRootSummary,
  openResumeControl,
  readNativeIndexSummary,
  waitForReadyIndex,
} from './utils/native-index-build';

/**
 * A folder added through "Add Folder to Workspace" while the native Workspace
 * Index is still importing another folder must be indexed too (BST-1955).
 *
 * Root #1 is seeded with enough real files that its vectors are still being
 * written when root #2 is added through the real button. The OS picker is
 * replaced by BRAINSTRIKE_E2E_REAL_ROOT_PATH, a real directory the adapter
 * still stats, so nothing between the click and the native index is mocked.
 * Both roots hold real files, so a missing root #2 can only mean the new root
 * was dropped. Counts and scan receipts come from the renderer's `indexSearch`
 * capability, the observation the app itself reads. Adding the folder reopens
 * the sources while root #1's scan is still running, which once failed the
 * utility's retirement and left the new configuration unactivated.
 */

const ROOT_ONE_FILE_COUNT = 150;
const ROOT_TWO_FILE_COUNT = 3;
const ROOT_ONE_ID = 'mid-session-root-1';

let workspaceDir = '';
let rootOneDir = '';
let rootTwoDir = '';

function writeRoot(dir: string, label: string, fileCount: number): void {
  mkdirSync(path.join(dir, 'nested'), { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    const folder = index % 3 === 0 ? 'nested' : '.';
    // Real content, so chunking and embedding keep root #1 busy.
    const body = Array.from(
      { length: 40 },
      (_, line) =>
        `export const ${label}_${index}_${line} = ${line}; // indexable line ${line} for ${label}`
    ).join('\n');
    writeFileSync(path.join(dir, folder, `${label}-${index}.ts`), `${body}\n`);
  }
}

test.beforeAll(() => {
  // The host records the picked folder's real path (macOS tmpdir is a symlink).
  workspaceDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'brainstrike-midsession-')));
  rootOneDir = path.join(workspaceDir, 'root1');
  rootTwoDir = path.join(workspaceDir, 'root2');
  writeRoot(rootOneDir, 'root1', ROOT_ONE_FILE_COUNT);
  writeRoot(rootTwoDir, 'root2', ROOT_TWO_FILE_COUNT);
});

test.afterAll(() => {
  rmSync(workspaceDir, { force: true, recursive: true });
});

/** The host's durable id for a mounted folder; absent until the add is accepted. */
async function rootIdOf(page: Page, rootPath: string): Promise<string | undefined> {
  const userData = await page.evaluate(() => window.electronAPI!.getUserDataPath());
  return (await readHostRootRecords(userData)).find((root) => root.path === rootPath)?.id;
}

async function readRoots(page: Page): Promise<Record<string, NativeRootSummary>> {
  const summary = await readNativeIndexSummary(page);
  return Object.fromEntries(summary.roots.map((root) => [root.rootId, root]));
}

test.describe('Mid-session add root indexing', () => {
  test('@desktop-mid-session-add-root @desktop-embedding-native-backfill indexes a root added while another is importing', async ({
    electronApp,
    window: page,
  }) => {
    test.setTimeout(8 * 60 * 1000);
    await seedPausedWorkspace(
      page,
      [{ path: rootOneDir, rootId: ROOT_ONE_ID }],
      'wasm',
      'mid-session-add-root-seeded'
    );
    await configureNativeIndex(page, 'wasm');
    await waitForReadyIndex(page, 300_000);
    const resume = await openResumeControl(page);
    await resume.click();
    await closeIndexingPopover(page);

    // Root #1 has published files but still owes vectors, so root #2 arrives under load.
    await expect
      .poll(async () => (await readRoots(page))[ROOT_ONE_ID]?.indexedFiles ?? 0, {
        timeout: 240_000,
      })
      .toBeGreaterThan(0);
    const rootOneAtAdd = (await readRoots(page))[ROOT_ONE_ID];
    expect(
      rootOneAtAdd && (!rootOneAtAdd.scanComplete || rootOneAtAdd.missingVectors > 0),
      `root #1 was still importing when root #2 was added: ${JSON.stringify(rootOneAtAdd)}`
    ).toBe(true);

    await electronApp.app.evaluate((_electron, next) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = next;
    }, rootTwoDir);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect
      .poll(async () => await rootIdOf(page, rootTwoDir), { timeout: 60_000 })
      .toBeTruthy();
    const rootTwoId = (await rootIdOf(page, rootTwoDir)) ?? '';

    await expect
      .poll(async () => await readNativeIndexSummary(page), { timeout: 240_000 })
      .toMatchObject({
        missingVectors: 0,
        scanComplete: true,
        status: 'ready',
        vectorCoverageComplete: true,
      });
    expect(await readRoots(page)).toMatchObject({
      [ROOT_ONE_ID]: { indexedFiles: ROOT_ONE_FILE_COUNT, missingVectors: 0, scanComplete: true },
      [rootTwoId]: { indexedFiles: ROOT_TWO_FILE_COUNT, missingVectors: 0, scanComplete: true },
    });
    await expect(page.getByTestId('indexing-status-trigger')).not.toContainText('Blocked');

    // Root #2's content is searchable, not just counted.
    const hits = await page.evaluate(
      async ({ rootId }) => {
        const capability = (
          globalThis as typeof globalThis & {
            readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
          }
        ).__brainstrikeTestHooks__?.indexSearch;
        const result = await capability?.search({
          limit: 10,
          mode: 'bm25',
          rootIds: [rootId],
          text: 'root2_0_1',
        });
        return result?.hits.map((hit) => hit.relativePath) ?? [];
      },
      { rootId: rootTwoId }
    );
    expect(hits).toContain('nested/root2-0.ts');
  });
});
