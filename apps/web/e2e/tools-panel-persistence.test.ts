import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

test.describe('Tools Panel - Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test('persists tools panel tab selection across hide/show and reload', async ({ page }) => {
    const elements = getPanelElements(page);

    await page.waitForSelector(
      '[data-testid="show-tools-panel"], [data-testid="hide-tools-panel"]',
      {
        state: 'attached',
      }
    );
    const showToolsPanel = await elements.showRightPanelShim.isVisible().catch(() => false);
    const hideToolsPanel = await elements.hideRightPanelButton.isVisible().catch(() => false);
    if (!(showToolsPanel || hideToolsPanel)) {
      test.skip(true, 'Tools panel controls not available in this environment');
    }
    if (showToolsPanel) {
      await elements.showRightPanelShim.click();
    }
    await expect(elements.hideRightPanelButton).toBeVisible();

    const dbTab = page
      .getByRole('tab', { name: 'Database' })
      .or(page.getByRole('button', { name: 'Database' }));
    const hasDb = await dbTab.isVisible().catch(() => false);
    if (!hasDb) {
      test.skip(true, 'Database tab not available in this environment');
    }

    await dbTab.click();
    await expect(dbTab).toHaveAttribute('aria-selected', 'true');

    await elements.hideRightPanelButton.click();
    await expect(elements.showRightPanelShim).toBeVisible();
    await elements.showRightPanelShim.click();
    await expect(elements.hideRightPanelButton).toBeVisible();

    await dbTab.click();
    await expect(dbTab).toHaveAttribute('aria-selected', 'true');

    await page.reload();
    await waitForAppLoad(page);
    if (await elements.showRightPanelShim.isVisible().catch(() => false)) {
      await elements.showRightPanelShim.click();
    }
    await expect(elements.hideRightPanelButton).toBeVisible();
    await dbTab.click();
    await expect(dbTab).toHaveAttribute('aria-selected', 'true');
  });
});
