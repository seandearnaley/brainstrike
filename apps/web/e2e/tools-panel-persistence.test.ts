import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

test.describe('Agent sidebar database access', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test('keeps the database tab available across sidebar hide/show and reload', async ({ page }) => {
    const elements = getPanelElements(page);

    await page.waitForSelector(
      '[data-testid="show-threads-panel"], [data-testid="hide-threads-panel"]',
      {
        state: 'attached',
      }
    );

    const showSidebar = await elements.showExplorerShim.isVisible().catch(() => false);
    const hideSidebar = await elements.hideExplorerButton.isVisible().catch(() => false);
    if (!(showSidebar || hideSidebar)) {
      test.skip(true, 'Agent sidebar controls not available in this environment');
    }

    if (showSidebar) {
      await elements.showExplorerShim.click();
    }
    await expect(elements.hideExplorerButton).toBeVisible();

    const databaseTab = page.getByRole('tab', { name: 'Database' });
    await expect(databaseTab).toBeVisible();

    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });

    await elements.hideExplorerButton.click();
    await expect(elements.showExplorerShim).toBeVisible();
    await elements.showExplorerShim.click();
    await expect(elements.hideExplorerButton).toBeVisible();

    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await waitForAppLoad(page);
    if (await elements.showExplorerShim.isVisible().catch(() => false)) {
      await elements.showExplorerShim.click();
    }
    await expect(elements.hideExplorerButton).toBeVisible();
    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
  });
});
