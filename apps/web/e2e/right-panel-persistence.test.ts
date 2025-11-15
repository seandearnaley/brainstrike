import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

test.describe('Right Panel - Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test('persists DB logs subtab controls across hide/show and reload (if Database tab present)', async ({
    page,
  }) => {
    const elements = getPanelElements(page);

    await expect(elements.showRightPanelShim).toBeVisible();
    await elements.showRightPanelShim.click();
    await expect(elements.rightPanel).toBeVisible();

    const dbTab = page
      .getByRole('tab', { name: 'Database' })
      .or(page.getByRole('button', { name: 'Database' }));
    const hasDb = await dbTab.isVisible().catch(() => false);
    if (!hasDb) test.skip(true, 'Database tab not available in this environment');

    await dbTab.click();
    const subtab = page.getByLabel('DB subtab');
    await subtab.selectOption('logs');
    await page.locator('#db-logs-filter').fill('embeddings');
    await page.locator('#db-logs-sortby').fill('timestamp');
    await page.locator('#db-logs-dir').selectOption('desc');
    await page.locator('#db-logs-page').fill('3');
    await page.locator('#db-logs-pagesize').fill('25');

    await elements.hideRightPanelButton.click();
    await expect(elements.rightPanel).not.toBeVisible();
    await elements.showRightPanelShim.click();
    await expect(elements.rightPanel).toBeVisible();

    await dbTab.click();
    await expect(page.getByLabel('DB subtab')).toHaveValue('logs');
    await expect(page.locator('#db-logs-filter')).toHaveValue('embeddings');
    await expect(page.locator('#db-logs-sortby')).toHaveValue('timestamp');
    await expect(page.locator('#db-logs-dir')).toHaveValue('desc');
    await expect(page.locator('#db-logs-page')).toHaveValue('3');
    await expect(page.locator('#db-logs-pagesize')).toHaveValue('25');

    await page.reload();
    await waitForAppLoad(page);
    if (await elements.rightPanel.isHidden()) {
      await elements.showRightPanelShim.click();
    }
    await expect(elements.rightPanel).toBeVisible();
    await dbTab.click();
    await expect(page.getByLabel('DB subtab')).toHaveValue('logs');
    await expect(page.locator('#db-logs-filter')).toHaveValue('embeddings');
    await expect(page.locator('#db-logs-sortby')).toHaveValue('timestamp');
    await expect(page.locator('#db-logs-dir')).toHaveValue('desc');
    await expect(page.locator('#db-logs-page')).toHaveValue('3');
    await expect(page.locator('#db-logs-pagesize')).toHaveValue('25');
  });
});
