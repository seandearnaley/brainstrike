/**
 * Desktop E2E (BST-1990): Explorer search follows the workspace's folders with no
 * restart. A folder disconnected with its indexed data deleted leaves search over
 * the folders that remain, and the same folder added back is searched again under
 * its one id. Before, the search scope kept the removed folder's id, so native
 * search refused every query ("Native search scope contains an unauthorized
 * workspace root") until restart.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';
import { seedRoot } from './utils/seed-root';
import {
  getWorkspaceSemanticSearchSnapshot,
  openWorkspaceSearchPanel,
} from './utils/workspace-search-helpers';

const ALPHA_WORD = 'quartzalpha';
const BRAVO_WORD = 'harborbravo';

function workspaceFolder(prefix: string, file: string, word: string): string {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  writeFileSync(path.join(folder, file), `The ${word} line.\n`);
  return folder;
}

/** Text search through the visible Search & Indexing controls, then back to the workspace. */
async function chooseTextSearch(page: Page): Promise<void> {
  const home = new HomePage(page);
  await home.openSettings();
  const section = await new SettingsPage(page).openCategory(
    /Search & Indexing/i,
    'search-indexing'
  );
  await section.getByRole('combobox', { exact: true, name: 'Embedding model' }).click();
  await page.getByRole('option', { name: /BGE Small/ }).click();
  await section.getByRole('button', { exact: true, name: 'Use embedding model' }).click();
  await expect(section.getByRole('combobox', { name: 'Managed collection' })).toContainText(
    'Workspace Index (BGE Small)',
    { timeout: 15_000 }
  );
  await section.getByRole('combobox', { name: 'Search mode' }).click();
  await page.getByRole('option', { exact: true, name: 'Text search' }).click();
  await home.leaveSettings();
}

/** The native index's state: the folders it serves with a finished scan, or why it serves none. */
async function indexReadiness(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const capability = (
      window as Window & {
        readonly __brainstrikeTestHooks__?: { readonly indexSearch?: IndexSearchCapability };
      }
    ).__brainstrikeTestHooks__?.indexSearch;
    if (!capability) {
      throw new Error('The native index capability is unavailable');
    }
    const status = await capability.status();
    return status.kind === 'ready'
      ? { folders: status.rootReadiness.filter((root) => root.scanComplete).length }
      : { kind: status.kind, reason: status.reason };
  });
}

async function showExplorer(page: Page): Promise<void> {
  await ensureFileExplorerPanelVisible(page);
  await page
    .getByRole('tablist', { name: 'Explorer and search' })
    .getByRole('tab', { name: 'Explorer' })
    .click();
}

/** The panel's refusal of a query that ran while the folders or the index changed under it. */
const SCOPE_CHANGED = 'Native workspace search scope or capability changed.';

/**
 * Explorer Text search for `word` lists `file` first. A query that ran across the
 * folder change is retried with the panel's own Retry, as a person would; any
 * other error text is the received value, so a refusal fails with its reason.
 */
async function expectSearchFinds(page: Page, word: string, file: string): Promise<void> {
  const panel = await openWorkspaceSearchPanel(page);
  await panel.getByPlaceholder('Search workspace').fill(word);
  await expect
    .poll(
      async () => {
        const snapshot = await getWorkspaceSemanticSearchSnapshot(panel);
        if (snapshot.error === SCOPE_CHANGED) {
          await panel.getByRole('button', { exact: true, name: 'Retry' }).click();
        }
        return snapshot.error ?? snapshot.firstResultLabel;
      },
      { timeout: 30_000 }
    )
    .toContain(file);
}

/** The visible gesture: right-click the folder header, Disconnect…, Also delete indexed data. */
async function disconnectDeletingData(page: Page, name: string): Promise<void> {
  await showExplorer(page);
  const header = page.getByTestId('root-section-header-row').filter({ hasText: name });
  await header.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Disconnect…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const deleteIndexedData = dialog.getByLabel('Also delete indexed data');
  await expect(deleteIndexedData).not.toBeChecked();
  await deleteIndexedData.click();
  await expect(deleteIndexedData).toBeChecked();
  await dialog.getByRole('button', { exact: true, name: 'Disconnect' }).click();
  await expect(header).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Disconnect failed' })
  ).toHaveCount(0);
}

test('Explorer search follows a folder disconnected with its indexed data deleted, and added back', async ({
  electron,
  electronApp,
  window: page,
}) => {
  test.setTimeout(300_000);
  const alpha = workspaceFolder('bs-m6-explorer-alpha-', 'alpha.txt', ALPHA_WORD);
  const bravo = workspaceFolder('bs-m6-explorer-bravo-', 'bravo.txt', BRAVO_WORD);
  const addBravo = async (): Promise<void> => {
    await electronApp.app.evaluate((_electron, picked) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = picked;
    }, bravo);
    await showExplorer(page);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect(page.getByText('bravo.txt').first()).toBeVisible({ timeout: 60_000 });
  };
  try {
    await seedRoot(page, alpha, {
      reloadReason: 'm6-explorer-folder-change',
      rootId: randomUUID(),
    });
    await addBravo();
    await chooseTextSearch(page);
    await expect.poll(() => indexReadiness(page), { timeout: 120_000 }).toEqual({ folders: 2 });
    await expectSearchFinds(page, ALPHA_WORD, 'alpha.txt');
    await expectSearchFinds(page, BRAVO_WORD, 'bravo.txt');

    await disconnectDeletingData(page, path.basename(bravo));
    await expect.poll(() => indexReadiness(page), { timeout: 60_000 }).toEqual({ folders: 1 });
    await expectSearchFinds(page, ALPHA_WORD, 'alpha.txt');

    await addBravo();
    await expect.poll(() => indexReadiness(page), { timeout: 120_000 }).toEqual({ folders: 2 });
    await expectSearchFinds(page, BRAVO_WORD, 'bravo.txt');
  } finally {
    await electron.dispose();
    rmSync(alpha, { force: true, recursive: true });
    rmSync(bravo, { force: true, recursive: true });
  }
});
