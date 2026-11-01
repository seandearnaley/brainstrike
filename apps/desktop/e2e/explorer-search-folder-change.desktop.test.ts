/**
 * Desktop E2E (BST-1990, ADR-0035): Explorer search follows the workspace's
 * folders with no restart. It reads the open folders live through the agent
 * host, so a disconnected folder is no longer searched and the same folder
 * added back is searched again at once, with nothing to rebuild.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { seedRoot } from './utils/seed-root';
import { expectSearchResults, openWorkspaceSearchPanel } from './utils/workspace-search-helpers';

const ALPHA_WORD = 'quartzalpha';
const BRAVO_WORD = 'harborbravo';

function workspaceFolder(prefix: string, file: string, word: string): string {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  writeFileSync(path.join(folder, file), `The ${word} line.\n`);
  return folder;
}

async function showExplorer(page: Page): Promise<void> {
  await ensureFileExplorerPanelVisible(page);
  await page
    .getByRole('tablist', { name: 'Explorer and search' })
    .getByRole('tab', { name: 'Explorer' })
    .click();
}

/** Explorer search for `word` lists exactly `files`. */
async function expectSearchFinds(
  page: Page,
  word: string,
  files: readonly string[]
): Promise<void> {
  const panel = await openWorkspaceSearchPanel(page);
  await expectSearchResults(panel, word, (labels) => {
    expect(labels).toHaveLength(files.length);
    for (const [index, file] of files.entries()) {
      expect(labels[index]).toContain(file);
    }
  });
}

/** The visible gesture: right-click the folder header, Disconnect…, Disconnect. */
async function disconnect(page: Page, name: string): Promise<void> {
  await showExplorer(page);
  const header = page.getByTestId('root-section-header-row').filter({ hasText: name });
  await header.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Disconnect…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { exact: true, name: 'Disconnect' }).click();
  await expect(header).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.locator('[data-sonner-toast]').filter({ hasText: 'Disconnect failed' })
  ).toHaveCount(0);
}

test('Explorer search follows a folder disconnected and added back', async ({
  electron,
  electronApp,
  window: page,
}) => {
  test.setTimeout(120_000);
  const alpha = workspaceFolder('bs-m6-explorer-alpha-', 'alpha.txt', ALPHA_WORD);
  electron.removeAfterClose(alpha);
  const bravo = workspaceFolder('bs-m6-explorer-bravo-', 'bravo.txt', BRAVO_WORD);
  electron.removeAfterClose(bravo);
  const addBravo = async (): Promise<void> => {
    await electronApp.app.evaluate((_electron, picked) => {
      process.env['BRAINSTRIKE_E2E_REAL_ROOT_PATH'] = picked;
    }, bravo);
    await showExplorer(page);
    await page.getByRole('button', { name: 'Add Folder to Workspace' }).click();
    await expect(page.getByText('bravo.txt').first()).toBeVisible({ timeout: 60_000 });
  };
  await seedRoot(page, alpha, {
    reloadReason: 'm6-explorer-folder-change',
    rootId: randomUUID(),
  });
  await addBravo();
  await expectSearchFinds(page, ALPHA_WORD, ['alpha.txt']);
  await expectSearchFinds(page, BRAVO_WORD, ['bravo.txt']);

  await disconnect(page, path.basename(bravo));
  await expectSearchFinds(page, ALPHA_WORD, ['alpha.txt']);
  await expectSearchFinds(page, BRAVO_WORD, []);

  await addBravo();
  await expectSearchFinds(page, BRAVO_WORD, ['bravo.txt']);
});
