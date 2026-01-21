import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { ensureRightPanelVisible } from './utils/layout-helpers';

test.describe('Embedding Worker Telemetry', () => {
  /**
   * BST-311: Vector Status was merged into the Database tab as EmbeddingStatusBar.
   * This test verifies the compact embedding telemetry UI in the Database tab toolbar.
   */
  test('surfaces queue metrics and trends in the database tab toolbar', async ({ page }) => {
    const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
    const panelTimeout = isCI ? 20_000 : 8000;
    const home = new HomePage(page);

    await home.goto();
    await ensureRightPanelVisible(page);

    // Navigate to Database tab (BST-311: Vectors tab merged into Database)
    const databaseTab = page.getByRole('tab', { name: /database/i });
    await expect(databaseTab).toBeVisible({ timeout: panelTimeout });
    await databaseTab.click();

    const databasePanel = page.getByRole('tabpanel', { name: /database/i });
    await expect(databasePanel).toBeVisible({ timeout: panelTimeout });

    // BST-311: EmbeddingStatusBar is now in the Database tab footer
    // Verify the embedding status bar is visible
    const embeddingStatusBar = page.getByTestId('embedding-status-bar');
    await expect(embeddingStatusBar).toBeVisible({ timeout: panelTimeout });

    // Verify queue metrics are displayed in the compact status bar
    // Throughput and latency sparklines
    await expect(embeddingStatusBar.getByRole('img', { name: 'Throughput trend' })).toBeVisible();
    await expect(embeddingStatusBar.getByRole('img', { name: 'Latency trend' })).toBeVisible();

    // Jobs/min indicator
    await expect(embeddingStatusBar.getByText(/jobs\/min/i)).toBeVisible();

    // Queue counts (Q: for queued, showing queued/running)
    await expect(embeddingStatusBar.getByText('Q:')).toBeVisible();
  });
});
