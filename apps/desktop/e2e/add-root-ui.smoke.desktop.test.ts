/**
 * Fast @smoke guard for the "Add Folder to Workspace" UI flow.
 *
 * This intentionally does NOT drive the background indexing / embedding
 * pipeline (that lives in the heavier @desktop-mid-session-add-root
 * regression). It pins the two UI regressions that shipped and were only
 * caught by the non-PR regression suite:
 *
 *   1. The Add Folder button was covered by the toolbar's right cluster and
 *      intercepted pointer events — the real click never landed.
 *   2. A newly added root section rendered "No files in this folder" (or a
 *      swallowed scan error) instead of its files.
 *
 * The OS picker is replaced by BRAINSTRIKE_E2E_REAL_ROOT_PATH (a real on-disk
 * directory the real adapter still stats), so the add path under test is not
 * mocked. Background indexing is seeded off so the run stays smoke-fast.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures/electron-fixture';
import { loadElectronHelpers } from './utils/load-electron-helpers';

function makeRootDir(label: string, fileCount: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `brainstrike-addroot-smoke-${label}-`));
  for (let i = 0; i < fileCount; i += 1) {
    writeFileSync(path.join(dir, `${label}-${i}.ts`), `export const v${i} = ${i};\n`);
  }
  return dir;
}

let ROOT_ONE_DIR: string;
let ROOT_TWO_DIR: string;

test.beforeAll(() => {
  ROOT_ONE_DIR = makeRootDir('alpha', 3);
  ROOT_TWO_DIR = makeRootDir('bravo', 3);
  // The "Add Folder" pick returns this real directory instead of an OS dialog.
  process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = ROOT_TWO_DIR;
});

test.afterAll(() => {
  // biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined"; delete truly unsets.
  delete process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'];
  rmSync(ROOT_ONE_DIR, { force: true, recursive: true });
  rmSync(ROOT_TWO_DIR, { force: true, recursive: true });
});

test.describe('Add Folder to Workspace (smoke)', () => {
  test('@smoke a mid-session added root renders its files', { tag: '@smoke' }, async ({
    window: page,
  }) => {
    test.setTimeout(90_000);

    // Seed one already-open root with background indexing OFF (smoke-fast).
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
          JSON.stringify([{ addedAt: 1_800_000_000_000, path: rootOne, rootId: 'smoke-root-1' }])
        );
        localStorage.setItem(
          'background-indexing-preferences.v1',
          JSON.stringify({
            state: {
              enabled: false,
              indexingPolicyPreset: 'full-root',
              managedCollectionId: null,
              mode: 'root-folder-cache',
              paused: true,
            },
            version: 4,
          })
        );
      },
      { rootOne: ROOT_ONE_DIR }
    );

    const { reloadRenderer } = await loadElectronHelpers();
    await reloadRenderer(page, 'add-root-smoke-seeded');

    // Root #1 renders.
    await expect(page.getByText('alpha-1.ts').first()).toBeVisible({ timeout: 60_000 });

    // The Add Folder button must be clickable with a REAL pointer click — a
    // toolbar element overlapping it would make Playwright's actionability
    // check time out here (regression #1).
    const addFolderButton = page.getByRole('button', { name: 'Add Folder to Workspace' });
    await expect(addFolderButton).toBeVisible({ timeout: 30_000 });
    await addFolderButton.click({ timeout: 15_000 });

    // The added root's files render (regression #2 — never the empty/error state).
    await expect(page.getByText('bravo-1.ts').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('No files in this folder')).toHaveCount(0);
  });
});
