/**
 * Desktop E2E (BST-1988): in Text search with no collection, a folder can be
 * disconnected with its indexed data, down to the last one, and a folder added
 * afterwards indexes. With no collection the TEXT partition's only scopes are
 * its folders, so removing the last leaves nothing to index: a ready, empty
 * index, not a blocked one.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { seedRoot } from './utils/seed-root';
import { chooseTextSearch, textReadiness } from './utils/text-search-mode';

function workspaceFolder(prefix: string, file: string): string {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  writeFileSync(path.join(folder, file), `${file} text\n`);
  return folder;
}

function textReady(folders: number) {
  return { folders, indexMode: 'text-only', kind: 'ready' };
}

async function showExplorer(page: Page): Promise<void> {
  await ensureFileExplorerPanelVisible(page);
  await page
    .getByRole('tablist', { name: 'Explorer and search' })
    .getByRole('tab', { name: 'Explorer' })
    .click();
}

/** The visible gesture: right-click the folder header, Disconnect…, delete its indexed data. */
async function disconnectWithIndexedData(page: Page, header: Locator): Promise<void> {
  await header.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Disconnect…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel('Also delete indexed data').click();
  await dialog.getByRole('button', { exact: true, name: 'Disconnect' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

async function expectDisconnectSucceeded(page: Page): Promise<void> {
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Disconnect failed' })
  ).toHaveCount(0);
}

test.describe('Text search folder removal (desktop)', () => {
  test('the only folder is removed with its indexed data, and a folder added afterwards indexes', async ({
    electron,
    electronApp,
    window: page,
  }) => {
    test.setTimeout(300_000);
    const first = workspaceFolder('bs-m6-text-removal-only-', 'only.txt');
    const next = workspaceFolder('bs-m6-text-removal-next-', 'next.txt');
    try {
      await seedRoot(page, first, { reloadReason: 'm6-text-removal-only', rootId: randomUUID() });
      await chooseTextSearch(page);
      await expect.poll(() => textReadiness(page), { timeout: 120_000 }).toEqual(textReady(1));

      await showExplorer(page);
      await disconnectWithIndexedData(page, page.getByTestId('single-root-header-row'));
      await expect(page.getByTestId('single-root-header-row')).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(() => textReadiness(page), { timeout: 60_000 }).toEqual(textReady(0));
      await expectDisconnectSucceeded(page);

      await electronApp.app.evaluate((_electron, folder) => {
        process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = folder;
      }, next);
      await showExplorer(page);
      await page.getByTestId('select-root-button').first().click();
      await expect.poll(() => textReadiness(page), { timeout: 120_000 }).toEqual(textReady(1));
    } finally {
      await electron.dispose();
      rmSync(first, { force: true, recursive: true });
      rmSync(next, { force: true, recursive: true });
    }
  });

  test('two folders are removed one at a time with their indexed data, then a folder indexes', async ({
    electron,
    electronApp,
    window: page,
  }) => {
    test.setTimeout(360_000);
    const alpha = workspaceFolder('bs-m6-text-removal-alpha-', 'alpha.txt');
    const bravo = workspaceFolder('bs-m6-text-removal-bravo-', 'bravo.txt');
    const next = workspaceFolder('bs-m6-text-removal-after-', 'after.txt');
    const setPickerFolder = async (folder: string): Promise<void> => {
      await electronApp.app.evaluate((_electron, picked) => {
        process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = picked;
      }, folder);
    };
    try {
      await seedRoot(page, alpha, { reloadReason: 'm6-text-removal-two', rootId: randomUUID() });
      await setPickerFolder(bravo);
      await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
      await expect(page.getByText('bravo.txt').first()).toBeVisible({ timeout: 60_000 });
      await chooseTextSearch(page);
      await expect.poll(() => textReadiness(page), { timeout: 120_000 }).toEqual(textReady(2));

      // The second folder first, while another remains.
      await showExplorer(page);
      await disconnectWithIndexedData(
        page,
        page.getByTestId('root-section-header-row').filter({ hasText: path.basename(bravo) })
      );
      await expect.poll(() => textReadiness(page), { timeout: 60_000 }).toEqual(textReady(1));
      await expectDisconnectSucceeded(page);

      // Then the last one.
      await showExplorer(page);
      await disconnectWithIndexedData(page, page.getByTestId('single-root-header-row'));
      await expect(page.getByTestId('single-root-header-row')).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(() => textReadiness(page), { timeout: 60_000 }).toEqual(textReady(0));
      await expectDisconnectSucceeded(page);

      await setPickerFolder(next);
      await showExplorer(page);
      await page.getByTestId('select-root-button').first().click();
      await expect.poll(() => textReadiness(page), { timeout: 120_000 }).toEqual(textReady(1));
    } finally {
      await electron.dispose();
      rmSync(alpha, { force: true, recursive: true });
      rmSync(bravo, { force: true, recursive: true });
      rmSync(next, { force: true, recursive: true });
    }
  });
});
