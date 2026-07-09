import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { ensureRightPanelVisible, waitForContextExplorerPage } from './utils/layout-helpers';

/**
 * Workspace-search smoke (web).
 *
 * Scope decision (mirrors the desktop smoke): text search only returns rows
 * against INDEXED content (`file_chunks`), and the only path that seeds those
 * rows is a real background-indexing round trip (the ~120s @web-indexing
 * `workspace-index-background-indexing.test.ts`). There is no fast fixture seed
 * for `file_chunks`, so this smoke asserts the feature is fully MOUNTED and
 * WIRED — the Explorer|Search tab strip toggles, the lazy search panel loads
 * its controls, and typing a query drives the store to an honest terminal state
 * (an error banner: no workspace index is available on a fresh app) without
 * crashing. The full results→selection round trip belongs in a nightly test
 * with a seeded, indexed fixture (see task-12 report Follow-Up).
 *
 * `waitForDatabase: false` keeps this on the fast functional shard (the search
 * chain reaches an error state whether the DB is still initializing — "database
 * is not ready" — or ready without an index — "no workspace index is
 * available"; both render the error banner).
 */
test.describe('Workspace search', { tag: '@smoke' }, () => {
  test('Explorer|Search tab strip mounts, the search panel loads, and a query reaches an honest terminal state', {
    tag: '@web-smoke',
  }, async ({ page }) => {
    const home = new HomePage(page);
    await home.goto({ waitForDatabase: false });
    await waitForContextExplorerPage(page);
    await ensureRightPanelVisible(page);

    const tabStrip = page.getByRole('tablist', { name: 'Explorer and search' });
    await expect(tabStrip).toBeVisible({ timeout: 15_000 });
    const explorerTab = tabStrip.getByRole('tab', { name: 'Explorer' });
    const searchTab = tabStrip.getByRole('tab', { name: 'Search' });
    await expect(explorerTab).toBeVisible({ timeout: 15_000 });
    await expect(searchTab).toBeVisible({ timeout: 15_000 });

    // Explorer is the default active tab.
    await expect(explorerTab).toHaveAttribute('aria-selected', 'true');

    await searchTab.click();
    await expect(searchTab).toHaveAttribute('aria-selected', 'true');

    const searchPanel = page.locator('#explorer-search-panel-search');
    await expect(searchPanel).toBeVisible({ timeout: 15_000 });

    // The lazy panel's controls render (mode toggle + query input).
    await expect(searchPanel.getByRole('button', { name: 'Text' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(searchPanel.getByRole('button', { name: 'Semantic' })).toBeVisible();
    const queryInput = searchPanel.getByPlaceholder('Search workspace');
    await expect(queryInput).toBeVisible();

    // Text mode auto-searches ≥3 chars after a 250ms debounce. With no workspace
    // index seeded, the run resolves to a definitive honest state: an error
    // banner (no index / db not ready) or an empty results tree — never a crash.
    await queryInput.fill('export');

    const errorBanner = searchPanel.getByRole('alert');
    const emptyResults = searchPanel.getByText('No matches found', { exact: true });
    await expect(errorBanner.or(emptyResults).first()).toBeVisible({ timeout: 20_000 });

    // The store wiring survives a switch back to Explorer, which re-selects and
    // reveals the file-explorer surface.
    await explorerTab.click();
    await expect(explorerTab).toHaveAttribute('aria-selected', 'true');
    await expect(searchTab).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('#explorer-search-panel-explorer')).toBeVisible({
      timeout: 15_000,
    });
  });
});
