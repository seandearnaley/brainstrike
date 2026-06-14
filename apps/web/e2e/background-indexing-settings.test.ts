import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible } from './utils/layout-helpers';

async function ensureDatabasePanelVisible(page: Page): Promise<void> {
  await ensureRightPanelVisible(page);
  const databaseTab = page.getByRole('tab', { name: /database/i });
  await expect(databaseTab).toBeVisible({ timeout: 15_000 });
  await databaseTab.click();
  await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
}

async function createCollection(page: Page, collectionName: string): Promise<void> {
  const databasePanel = page.getByTestId('database-demo-panel');
  await databasePanel.getByRole('button', { name: 'New' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Create Search Collection')).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel('Name *').fill(collectionName);
  await dialog.getByRole('button', { name: 'Create Collection' }).click();

  await expect(dialog).toBeHidden({ timeout: 15_000 });
  const collectionList = databasePanel.getByRole('listbox', { name: 'Search Collection' });
  await expect(collectionList).toBeVisible({ timeout: 15_000 });
  await expect(
    collectionList.getByRole('option').filter({ hasText: collectionName }).first()
  ).toBeVisible({
    timeout: 30_000,
  });
}

async function openSearchIndexingSettings(page: Page): Promise<void> {
  const home = new HomePage(page);
  await home.navigateToSettings();
  await page.getByRole('button', { name: 'Search & Indexing' }).click();
  await expect(page.getByTestId('settings-category-search-indexing')).toBeVisible({
    timeout: 15_000,
  });
}

async function selectManagedCollection(page: Page, collectionName: string): Promise<void> {
  await page.locator('#managed-cache-collection').click();
  const option = page.getByRole('option', { name: collectionName });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
}

test.describe('Background indexing settings (web) @stateful @web-settings-state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
  });

  test('lets users change the indexing policy from settings', async ({ page }) => {
    const home = new HomePage(page);

    await home.goto({ waitForDatabase: false });
    await openSearchIndexingSettings(page);

    await expect(
      page.getByText(/skipping common generated, cache, lock, and minified artifacts/i)
    ).toBeVisible({ timeout: 15_000 });

    await page.getByLabel('Indexing policy').click();
    await page.getByRole('option', { name: /full root/i }).click();

    await expect(
      page.getByText(/indexes every non-binary text file under the selected root/i)
    ).toBeVisible({ timeout: 15_000 });
  });

  test('surfaces Workspace Index setup state when enabled without a root folder', async ({
    page,
  }) => {
    const collectionName = `Managed Cache ${Date.now()}`;
    const home = new HomePage(page);

    await home.goto();
    await ensureDatabasePanelVisible(page);
    await createCollection(page, collectionName);

    await openSearchIndexingSettings(page);
    await selectManagedCollection(page, collectionName);

    const settingsSection = page.getByTestId('settings-category-search-indexing');
    await expect(page.getByRole('switch', { name: 'Workspace Index' })).toBeChecked();
    await expect(settingsSection.getByText('Disabled')).toBeVisible({ timeout: 15_000 });
    await expect(settingsSection.getByText('None selected')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('indexing-status-item')).toContainText('Idle');
  });

  test('disables manual DB import when the collection is marked as managed', async ({ page }) => {
    const collectionName = `Managed Import Guard ${Date.now()}`;
    const home = new HomePage(page);

    await home.goto();
    await ensureDatabasePanelVisible(page);
    await createCollection(page, collectionName);

    await openSearchIndexingSettings(page);
    await selectManagedCollection(page, collectionName);

    await home.navigateToHome();
    await ensureDatabasePanelVisible(page);

    const importButton = page
      .getByTestId('database-demo-panel')
      .getByRole('button', { name: /^Import\s*\(/ });
    await expect(importButton).toBeDisabled();
    await expect(page.getByText(/manual db imports are disabled/i)).toBeVisible({
      timeout: 15_000,
    });
  });
});
