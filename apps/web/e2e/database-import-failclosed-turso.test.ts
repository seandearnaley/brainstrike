import { expect, type Page, test } from '@playwright/test';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';
import { resolveWebDbRuntimeEngine, WEB_TURSO_CHUNK_INDEXING_BLOCKED } from './utils/turso-gates';

/**
 * FAIL-CLOSED contract for browser Turso chunk persistence (A7 ship
 * decision): while the @tursodatabase/database-wasm indexed-insert lockup
 * keeps the chunk-indexing gate closed, a chunked manual import must refuse
 * LOUDLY and IMMEDIATELY — the typed vendor diagnostic surfaces through the
 * existing import-error toast, no write is attempted (no partial file
 * records), nothing hangs, and the app stays responsive.
 *
 * When the vendor fix lands, flip the gates (see e2e/utils/turso-gates.ts)
 * — this spec then skips itself and the full import/backfill specs in
 * database-import-backfill.test.ts take back over as the regression proof.
 */

const ROOT_NAME = 'database-import-failclosed-root';
const CODE_FILE_TREE: FileTree = {
  'alpha.ts': 'export const alpha = "database import fail closed";',
  'notes.ts': 'export const notes = "browser turso chunk indexing gate";',
};

async function disableBackgroundIndexing(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem(
      'background-indexing-preferences.v1',
      JSON.stringify({ state: { enabled: false }, version: 4 })
    );
  });
}

async function ensureDatabasePanelVisible(page: Page): Promise<void> {
  await ensureRightPanelVisible(page);
  const databaseTab = page.getByRole('tab', { name: /database/i });
  await expect(databaseTab).toBeVisible({ timeout: 15_000 });
  await databaseTab.click();
  await expect(page.getByRole('tabpanel', { name: /database/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
}

async function createCollection(page: Page, collectionName: string): Promise<void> {
  const databasePanel = page.getByTestId('database-demo-panel');
  await databasePanel.getByRole('button', { name: 'New' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Create Search Collection')).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel('Name *').fill(collectionName);
  const createButton = dialog.getByRole('button', { name: 'Create Collection' });
  await expect(createButton).toBeEnabled({ timeout: 15_000 });
  await createButton.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test.describe('Database import fail-closed on browser Turso @stateful @web-import-indexing', () => {
  test('refuses chunked manual imports with the vendor diagnostic and stays responsive', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await mockBrowserApis(page, ROOT_NAME, CODE_FILE_TREE);
    await page.goto('/');
    await waitForAppLoad(page);

    const engine = await resolveWebDbRuntimeEngine(page);
    test.skip(
      engine !== 'turso' || !WEB_TURSO_CHUNK_INDEXING_BLOCKED,
      'Fail-closed contract applies only to the Turso default while the chunk-indexing gate is closed.'
    );

    await resetAppState(page);
    await disableBackgroundIndexing(page);
    await page.reload();
    await waitForAppLoad(page);

    await ensureDatabasePanelVisible(page);
    await createCollection(page, `Fail Closed ${Date.now()}`);

    // Select the fixture files in the explorer (same gesture as the full
    // import specs).
    const explorer = new FileExplorerPage(page);
    const showExplorerButton = page
      .locator('button[aria-label="Show explorer panel"]')
      .or(page.getByRole('button', { name: 'Show explorer panel' }))
      .first();
    if (await showExplorerButton.isVisible().catch(() => false)) {
      await showExplorerButton.click();
    }
    await explorer.selectRoot();
    await expect(explorer.selectAllButton).toBeEnabled({ timeout: 15_000 });
    await explorer.selectAllButton.click();

    const databasePanel = page.getByTestId('database-demo-panel');
    const importButton = databasePanel.getByRole('button', { name: /^Import \(\d+\)$/ });
    await expect(importButton).toContainText('(2)', { timeout: 15_000 });
    await importButton.click();

    // The typed vendor diagnostic surfaces through the existing import
    // error toast — immediately, with no hanging write.
    await expect(page.getByText('Import Failed').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/indexed-insert lockup/).first()).toBeVisible({
      timeout: 15_000,
    });

    // No partial import: the refusal happened before the base import, so
    // the collection stays empty.
    await expect(
      databasePanel.getByRole('option').filter({ hasText: 'Fail Closed' }).first()
    ).toContainText('0 files', { timeout: 15_000 });

    // The app stays responsive: the DB is still connected and the panel
    // still responds to interaction.
    await expect(page.getByTestId('status-bar-db-connected')).toBeVisible({ timeout: 15_000 });
    await expect(importButton).toBeEnabled();
  });
});
