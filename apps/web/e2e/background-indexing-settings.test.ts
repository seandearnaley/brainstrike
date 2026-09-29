// The web E2E graph is ESM, so the barrel's `./hmr-utils.js` re-export (which
// contains `import.meta` syntax) is supported directly.
import type { BackgroundIndexingPolicyPreset } from '@brainstrike/utils';
import { BACKGROUND_INDEXING_POLICY_OPTIONS } from '@brainstrike/utils';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible } from './utils/layout-helpers';

/**
 * Resolves the settings copy rendered for a policy preset straight from the shared
 * catalogue, so this suite can never drift from the product string.
 *
 * Deliberately not `getBackgroundIndexingPolicyOption`: that helper falls back to the
 * first option, which would silently assert the balanced copy for a preset that no
 * longer exists.
 */
function policyDescription(preset: BackgroundIndexingPolicyPreset): string {
  const option = BACKGROUND_INDEXING_POLICY_OPTIONS.find((entry) => entry.value === preset);
  if (!option) {
    throw new Error(`No background indexing policy option registered for preset: ${preset}`);
  }
  return option.description;
}

async function ensureDatabasePanelVisible(page: Page): Promise<void> {
  await ensureRightPanelVisible(page);
  const databaseTab = page.getByRole('tab', { name: /collections/i });
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
  await expect(collectionList.getByRole('option', { name: /Workspace Index/i })).toHaveCount(0);
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

    await expect(page.getByText(policyDescription('balanced'))).toBeVisible({ timeout: 15_000 });

    await page.getByLabel('Indexing policy').click();
    await page.getByRole('option', { name: /full root/i }).click();

    await expect(page.getByText(policyDescription('full-root'))).toBeVisible({ timeout: 15_000 });
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

    // "No root selected", not "Waiting for restore". The latter is the badge the
    // provider paints while a workspace coverage audit is IN FLIGHT
    // (`workspace-collection-sync-provider.tsx` sets `state: 'waiting'` as it
    // starts the audit, then moves on when it settles), so asserting it made
    // this spec a race against a transient: it passed only when the 15s poll
    // happened to sample mid-audit. Measured — the badge is "No root selected"
    // at every sample across 5 runs and stays that way for a 12s poll, while
    // the "Waiting for restore" assertion failed 1-in-3 cold and 3-in-3 once a
    // competing poll starved the audit's scheduling.
    //
    // "No root selected" is also what this spec is actually about: it is the
    // terminal badge for an enabled index with a managed collection and no root
    // folder, which is precisely the setup state named in the title.
    await expect(settingsSection.getByText('No root selected')).toBeVisible({ timeout: 15_000 });
    await expect(settingsSection.getByText('None selected')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('indexing-status-item')).toContainText('Workspace Index');
  });

  test('disables manual DB import when the collection is marked as managed', async ({ page }) => {
    const collectionName = `Managed Import Guard ${Date.now()}`;
    const home = new HomePage(page);

    await home.goto();
    await ensureDatabasePanelVisible(page);
    await createCollection(page, collectionName);

    await openSearchIndexingSettings(page);
    await selectManagedCollection(page, collectionName);

    await home.leaveSettings();
    await home.navigateToHome();
    await ensureDatabasePanelVisible(page);

    // The import trigger itself now lives in the explorer's selection bar
    // (BST-1212); the Database panel's remaining job is to EXPLAIN why manual
    // imports are unavailable for a background-indexed collection. The
    // explorer-side block is covered by explorer-import-action.test.tsx.
    await expect(page.getByText(/manual db imports are disabled/i)).toBeVisible({
      timeout: 15_000,
    });
  });
});
