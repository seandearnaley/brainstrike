import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';

/**
 * Workspace-search smoke (desktop).
 *
 * Scope decision: text search only returns rows against INDEXED content
 * (`file_chunks`), and the only path that produces those rows is a real
 * background-indexing round trip (see `full-workspace-index.desktop.test.ts`,
 * skip-by-default + WebGPU + a real root). There is no fast fixture seed for
 * `file_chunks`, so this smoke asserts the feature is fully MOUNTED and WIRED —
 * the Explorer|Search tab strip toggles, the lazy search panel loads its
 * controls, and typing a query drives the store to an honest terminal state
 * (an error banner: no workspace index is available on a fresh app) without
 * crashing. The full results→selection round trip belongs in a nightly test
 * with a seeded, indexed fixture (see task-12 report Follow-Up).
 */
test.describe('Desktop workspace search', () => {
  test('Explorer|Search tab strip mounts, the search panel loads, and a query reaches an honest terminal state', async ({
    window,
  }) => {
    test.setTimeout(60_000);

    await ensureFileExplorerPanelVisible(window);

    const tabStrip = window.getByRole('tablist', { name: 'Explorer and search' });
    await expect(tabStrip).toBeVisible({ timeout: 15_000 });
    const explorerTab = tabStrip.getByRole('tab', { name: 'Explorer' });
    const searchTab = tabStrip.getByRole('tab', { name: 'Search' });
    await expect(explorerTab).toBeVisible({ timeout: 15_000 });
    await expect(searchTab).toBeVisible({ timeout: 15_000 });

    // Explorer is the default active tab.
    await expect(explorerTab).toHaveAttribute('aria-selected', 'true');

    await searchTab.click();
    await expect(searchTab).toHaveAttribute('aria-selected', 'true');

    const searchPanel = window.getByTestId('explorer-search-panel-search');
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
    // reveals the file-explorer surface (its empty-state add-folder affordance).
    await explorerTab.click();
    await expect(explorerTab).toHaveAttribute('aria-selected', 'true');
    await expect(searchTab).toHaveAttribute('aria-selected', 'false');
    await expect(window.getByTestId('explorer-search-panel-explorer')).toBeVisible({
      timeout: 15_000,
    });
  });
});
