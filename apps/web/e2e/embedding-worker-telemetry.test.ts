import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { ensureRightPanelVisible } from './utils/layout-helpers';

test.describe('Embedding Worker Telemetry', { tag: '@smoke' }, () => {
  /**
   * Indexing activity is now exposed through the app-shell status bar instead
   * of a Database-tab footer. This keeps queue/status visibility stable while
   * users navigate between collections and panels.
   */
  test('surfaces indexing activity in the app status bar', async ({ page }) => {
    const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
    const panelTimeout = isCI ? 20_000 : 8000;
    const home = new HomePage(page);

    await home.goto({ waitForDatabase: false });
    await ensureRightPanelVisible(page);

    // Navigate to Database tab (BST-311: Vectors tab merged into Database)
    const databaseTab = page.getByRole('tab', { name: /database/i });
    await expect(databaseTab).toBeVisible({ timeout: panelTimeout });
    await databaseTab.click();

    const databasePanel = page.getByRole('tabpanel', { name: /database/i });
    await expect(databasePanel).toBeVisible({ timeout: panelTimeout });

    const indexingStatusItem = page.getByTestId('indexing-status-item');
    await expect(indexingStatusItem).toBeVisible({ timeout: panelTimeout });
    await expect(indexingStatusItem).toContainText(/Indexing:/);

    await page.getByTestId('indexing-status-trigger').click();

    await expect(page.getByText('Indexing activity')).toBeVisible({ timeout: panelTimeout });
    const indexingPopover = page.getByTestId('indexing-status-popover');
    await expect(indexingPopover.getByText('Queue', { exact: true })).toBeVisible();
    await expect(page.getByText(/queued \/ .*running \/ .*failed \/ .*succeeded/)).toBeVisible();
    await expect(indexingPopover.getByText('Worker', { exact: true })).toBeVisible();
  });
});
