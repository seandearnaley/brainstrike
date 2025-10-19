import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, getPanelElements, waitForAppLoad } from './utils/layout-helpers';

test.describe('Right Panel - Navigation Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
    // Clear relevant right-panel stores to avoid leakage across tests
    await page.evaluate(() => {
      localStorage.removeItem('right-panel.v1');
      localStorage.removeItem('search-panel.v1');
      localStorage.removeItem('db-panel.v1');
      localStorage.removeItem('panel-layout-store.v1');
    });
  });

  test('retains search filters after navigating to Settings and back', async ({ page }) => {
    const elements = getPanelElements(page);

    // Show right panel if hidden
    await ensureRightPanelVisible(page);
    await expect(elements.rightPanel).toBeVisible();

    // Go to Search tab and set filters
    await page
      .getByRole('tab', { name: 'Search' })
      .or(page.getByRole('button', { name: 'Search' }))
      .click();
    const query = page.locator('#rp-search-query');
    await query.fill('navtest');
    await page.getByLabel('Regex').click();
    await page.getByLabel('Case').click();

    // Navigate to Settings via nav sidebar
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('button', { name: 'Settings' }).click();
    await expect(
      page.getByRole('heading', { name: 'Settings', exact: true, level: 1 })
    ).toBeVisible();

    // Navigate back to Context Explorer
    await nav.getByRole('button', { name: 'Context Explorer' }).click();
    await expect(elements.rightPanel).toBeVisible();

    // Verify filters persisted
    await page
      .getByRole('tab', { name: 'Search' })
      .or(page.getByRole('button', { name: 'Search' }))
      .click();
    await expect(page.locator('#rp-search-query')).toHaveValue('navtest');
    await expect(page.getByLabel('Regex')).toBeChecked();
    await expect(page.getByLabel('Case')).toBeChecked();
  });
});
