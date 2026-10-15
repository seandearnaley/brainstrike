import type { Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { ensureMockWorkspaceOpen } from './utils/layout-helpers';

/** Every control in the Search panel, with whether it paints inside the panel and takes a click. */
async function searchControlLayout(page: Page) {
  return await page.getByTestId('explorer-search-panel-search').evaluate((panel) => {
    const bounds = panel.getBoundingClientRect();
    return {
      controls: [...panel.querySelectorAll('button, input')].map((control) => {
        const box = control.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          inside: box.left >= bounds.left - 0.5 && box.right <= bounds.right + 0.5,
          name:
            control.getAttribute('aria-label') ??
            control.getAttribute('placeholder') ??
            control.textContent?.trim(),
          reachable: hit === control || control.contains(hit),
        };
      }),
      panelWidth: bounds.width,
      scrollWidth: panel.scrollWidth,
    };
  });
}

/**
 * Drags the Files pane's separator until the pane sits at its minimum width,
 * 15% of the layout: the narrowest the Search panel gets. Returns the layout's
 * width.
 */
async function shrinkFilesPaneToMinimum(page: Page): Promise<number> {
  const drag = await page.getByTestId('explorer-search-panel-search').evaluate((panel) => {
    const pane = panel.closest('[data-panel]');
    const separator = pane?.previousElementSibling;
    const group = pane?.parentElement;
    if (!(pane && group && separator?.getAttribute('role') === 'separator')) {
      throw new Error('The Files pane has no resize separator');
    }
    const handle = separator.getBoundingClientRect();
    const layout = group.getBoundingClientRect();
    return {
      layoutWidth: layout.width,
      // Past the minimum but short of the collapse threshold, so the pane stops at its minimum.
      targetX: layout.right - layout.width * 0.12,
      x: handle.left + handle.width / 2,
      y: handle.top + handle.height / 2,
    };
  });
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.targetX, drag.y, { steps: 10 });
  await page.mouse.up();
  return drag.layoutWidth;
}

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

  test('every search control fits inside the Search panel at the Files pane minimum width', async ({
    window,
  }) => {
    test.setTimeout(60_000);
    // BST-1981: the header once laid out at 311px in a 180px panel and pushed the
    // toggles past its edge. The Search panel fills the Files pane, so the pane
    // is narrowed to its minimum first.
    await ensureMockWorkspaceOpen(window);
    await ensureFileExplorerPanelVisible(window);
    const tabStrip = window.getByRole('tablist', { name: 'Explorer and search' });
    await tabStrip.getByRole('tab', { name: 'Search' }).click();
    const searchPanel = window.getByTestId('explorer-search-panel-search');
    await expect(searchPanel.getByRole('button', { name: 'Use regular expression' })).toBeVisible({
      timeout: 15_000,
    });
    // A query's error card is part of the panel too.
    await searchPanel.getByPlaceholder('Search workspace').fill('export');
    await expect(searchPanel.getByRole('alert')).toBeVisible({ timeout: 20_000 });
    const layoutWidth = await shrinkFilesPaneToMinimum(window);
    const layout = await searchControlLayout(window);
    expect(layout.panelWidth).toBeLessThanOrEqual(layoutWidth * 0.16);
    expect(layout.scrollWidth).toBeLessThanOrEqual(Math.ceil(layout.panelWidth));
    expect(layout.controls.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'Text',
        'Semantic',
        'Search workspace',
        'Match case',
        'Match whole word',
        'Use regular expression',
        'Retry',
      ])
    );
    expect(layout.controls.filter(({ inside, reachable }) => !(inside && reachable))).toEqual([]);
  });

  test('a mounted workspace with no search mode chosen tells the user how to enable semantic search', async ({
    window,
  }) => {
    test.setTimeout(60_000);
    // Mounting a root reconfigures the native index; no Search & Indexing choice is saved.
    await ensureMockWorkspaceOpen(window);
    await ensureFileExplorerPanelVisible(window);
    const tabStrip = window.getByRole('tablist', { name: 'Explorer and search' });
    await tabStrip.getByRole('tab', { name: 'Search' }).click();
    const searchPanel = window.getByTestId('explorer-search-panel-search');
    const semantic = searchPanel.getByRole('button', { name: 'Semantic' });
    await expect(semantic).toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 });
    // The disabled reason is the setup step, never an internal admission state.
    await expect(async () => {
      await semantic.hover();
      await expect(window.getByRole('tooltip').first()).toHaveText(
        'Choose a search mode in Search & Indexing settings.',
        { timeout: 2000 }
      );
    }).toPass({ timeout: 30_000 });
  });

  test('Text search mode tells the user which setting turns semantic search on', async ({
    window,
  }) => {
    test.setTimeout(60_000);
    await ensureMockWorkspaceOpen(window);
    const home = new HomePage(window);
    await home.openSettings();
    await window
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: 'Search & Indexing' })
      .click();
    await window.getByRole('combobox', { name: 'Search mode' }).click();
    await window.getByRole('option', { exact: true, name: 'Text search' }).click();
    await home.leaveSettings();
    await ensureFileExplorerPanelVisible(window);
    const tabStrip = window.getByRole('tablist', { name: 'Explorer and search' });
    await tabStrip.getByRole('tab', { name: 'Search' }).click();
    const semantic = window
      .getByTestId('explorer-search-panel-search')
      .getByRole('button', { name: 'Semantic' });
    await expect(semantic).toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 });
    await expect(async () => {
      await semantic.hover();
      await expect(window.getByRole('tooltip').first()).toHaveText(
        'Semantic search is off. Choose “Text and semantic search” in Search & Indexing settings.',
        { timeout: 2000 }
      );
    }).toPass({ timeout: 30_000 });
  });
});
