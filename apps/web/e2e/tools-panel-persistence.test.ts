import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

test.describe('Agent sidebar database access', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('keeps the database tab available across sidebar hide/show and reload', async ({ page }) => {
    const elements = getPanelElements(page);

    await page.waitForSelector(
      '[data-testid="show-threads-panel"], [data-testid="hide-threads-panel"]',
      {
        state: 'attached',
      }
    );

    const showSidebar = await elements.showAgentPanelShim.isVisible().catch(() => false);
    const hideSidebar = await elements.hideAgentPanelButton.isVisible().catch(() => false);
    if (!(showSidebar || hideSidebar)) {
      test.skip(true, 'Agent sidebar controls not available in this environment');
    }

    if (showSidebar) {
      await elements.showAgentPanelShim.click();
    }
    await expect(elements.hideAgentPanelButton).toBeVisible();

    const databaseTab = page.getByRole('tab', { name: 'Database' });
    await expect(databaseTab).toBeVisible();

    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });

    await elements.hideAgentPanelButton.click();
    await expect(elements.showAgentPanelShim).toBeVisible();
    await elements.showAgentPanelShim.click();
    await expect(elements.hideAgentPanelButton).toBeVisible();

    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    if (await elements.showAgentPanelShim.isVisible().catch(() => false)) {
      await elements.showAgentPanelShim.click();
    }
    await expect(elements.hideAgentPanelButton).toBeVisible();
    await databaseTab.click();
    await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
  });
});
