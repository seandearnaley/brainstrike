import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { ensureRightPanelVisible } from './utils/layout-helpers';

test.describe('Embedding Worker Telemetry', () => {
  test('surfaces queue metrics and vector trends in the vectors tab', async ({ page }) => {
    const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
    const panelTimeout = isCI ? 20_000 : 8000;
    const home = new HomePage(page);

    await home.goto();
    await ensureRightPanelVisible(page);

    const vectorsTab = page.getByRole('tab', { name: /vectors/i });
    await expect(vectorsTab).toBeVisible({ timeout: panelTimeout });
    await vectorsTab.click();

    const vectorsPanel = page.getByRole('tabpanel', { name: /vectors/i });
    await expect(vectorsPanel).toBeVisible({ timeout: panelTimeout });

    const loadingVectors = vectorsPanel.getByText(/loading vectors/i);
    if ((await loadingVectors.count()) > 0) {
      await expect(loadingVectors).toBeHidden({ timeout: panelTimeout });
    }

    const vectorStatusHeading = vectorsPanel.getByRole('heading', { name: 'Vector Status' });
    await expect(vectorStatusHeading).toBeVisible({ timeout: panelTimeout });
    await expect(vectorsPanel.getByText(/Jobs\/min/i)).toBeVisible();
    await expect(vectorsPanel.getByRole('img', { name: 'Queue throughput trend' })).toBeVisible();
    await expect(vectorsPanel.getByRole('img', { name: 'Queue error trend' })).toBeVisible();
    await expect(vectorsPanel.getByRole('img', { name: 'Queue latency trend' })).toBeVisible();

    const queueStatus = page.getByTestId('status-bar-queue');
    await expect(queueStatus).toBeVisible();
    await expect(queueStatus.getByRole('button', { name: /retry/i })).toBeVisible();
  });
});
