import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ensureFileExplorerPanelVisible } from './file-explorer-selection.shared';
import { expect, test } from './fixtures/electron-fixture';
import { seedRoot } from './utils/seed-root';
import { expectSearchResults, openWorkspaceSearchPanel } from './utils/workspace-search-helpers';

const NO_FOLDER =
  'No folder is open, so there is nothing to search. Open a folder, then search again.';

/** Writes `relative` under `root`, making its folders. */
function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

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

/** The Files pane's width, as laid out now. */
async function filesPaneWidth(page: Page): Promise<number> {
  return await page.getByTestId('explorer-search-panel-search').evaluate((panel) => {
    const pane = panel.closest('[data-panel]');
    if (!pane) {
      throw new Error('The Search panel is not inside a resizable pane');
    }
    return pane.getBoundingClientRect().width;
  });
}

/** The Files pane's floor: the workspace pane's `rightPanelMinSize` (agent-workspace-layout.tsx). */
const FILES_PANE_MIN_WIDTH = 192;

/**
 * Narrows the Files pane to its minimum width: the narrowest the Search panel
 * gets. Returns the pane's width there.
 *
 * Resizes with the separator's keyboard steps, as a keyboard user would, and
 * waits for each step to lay out. A coordinate drag computed before the layout
 * settled was sometimes dropped, which left the pane at its default width
 * (BST-2301). A step that would pass the minimum stops at it, and it stops
 * there, since one more step from the minimum collapses the pane.
 */
async function shrinkFilesPaneToMinimum(page: Page): Promise<number> {
  const separator = page
    .getByTestId('explorer-search-panel-search')
    .locator('xpath=ancestor::*[@data-panel][1]/preceding-sibling::*[@role="separator"][1]');
  await separator.focus();
  let paneWidth = await filesPaneWidth(page);
  while (paneWidth > FILES_PANE_MIN_WIDTH + 0.5) {
    const before = paneWidth;
    await separator.press('ArrowRight');
    await expect
      .poll(() => filesPaneWidth(page), {
        message: 'The Files pane narrows by one keyboard step',
      })
      .toBeLessThan(before);
    paneWidth = await filesPaneWidth(page);
  }
  return paneWidth;
}

/** Workspace search (desktop): the Explorer's Search tab reads the open folders live (ADR-0035). */
test.describe('Desktop workspace search', () => {
  test('Explorer|Search tab strip mounts, the search panel loads, and a query with no folder open says so', async ({
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
    const queryInput = searchPanel.getByPlaceholder('Search workspace');
    await expect(queryInput).toBeVisible({ timeout: 15_000 });

    // A fresh app has no folder open, so the search says to open one instead of finding nothing.
    await queryInput.fill('export');
    await expect(searchPanel.getByTestId('workspace-search-results-error')).toHaveText(NO_FOLDER, {
      timeout: 20_000,
    });

    // The store wiring survives a switch back to Explorer, which re-selects and
    // reveals the file-explorer surface (its empty-state add-folder affordance).
    await explorerTab.click();
    await expect(explorerTab).toHaveAttribute('aria-selected', 'true');
    await expect(searchTab).toHaveAttribute('aria-selected', 'false');
    await expect(window.getByTestId('explorer-search-panel-explorer')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('a saved file is found at once; ignored and credential files never are; the match cap is shown', async ({
    electron,
    window,
  }) => {
    test.setTimeout(90_000);
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bs-live-search-')));
    electron.removeAfterClose(root);
    write(root, 'src/app.ts', 'export const needle = "live";\n');
    write(root, '.brainstrikeignore', 'private/\n');
    write(root, 'private/plan.md', 'needle in a private plan\n');
    write(root, 'node_modules/pkg/index.js', 'needle in a dependency\n');
    write(root, '.env', 'API_KEY=needle-secret\n');
    await seedRoot(window, root, { reloadReason: 'live-workspace-search', rootId: randomUUID() });
    const panel = await openWorkspaceSearchPanel(window);

    await expectSearchResults(panel, 'needle', (files) => {
      expect(files).toHaveLength(1);
      expect(files[0]).toContain('src/app.ts');
    });
    await expect(panel.getByText('API_KEY')).toHaveCount(0);

    // Saved a moment ago, found now: there is no index to catch up.
    write(root, 'src/fresh.ts', 'const needle = "just saved";\n');
    await expectSearchResults(panel, 'needle', (files) => {
      expect(files.map((file) => file.replace(/\d+ match(es)?$/u, ''))).toEqual(
        expect.arrayContaining(['src/app.ts', 'src/fresh.ts'])
      );
      expect(files).toHaveLength(2);
    });

    // Past its match cap the search stops and says how much it shows.
    write(root, 'big.txt', 'capword\n'.repeat(5100));
    await expectSearchResults(panel, 'capword', (files) => expect(files).toHaveLength(1));
    await expect(
      panel.getByText('Showing the first 5,000 matches. Narrow the search to see the rest.')
    ).toBeVisible();

    // A match row opens the file at its line.
    await expectSearchResults(panel, 'just saved', (files) => expect(files).toHaveLength(1));
    await panel.getByRole('row').filter({ hasText: 'just saved' }).last().click();
    await expect(window.getByRole('tab', { name: /fresh\.ts/u }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('every search control fits inside the Search panel at the Files pane minimum width', async ({
    window,
  }) => {
    test.setTimeout(60_000);
    // BST-1981: the header once laid out at 311px in a 180px panel and pushed the
    // toggles past its edge. The Search panel fills the Files pane, so the pane
    // is narrowed to its minimum first. With no folder open a query answers with
    // the results error card, whose Retry is measured too.
    await ensureFileExplorerPanelVisible(window);
    const tabStrip = window.getByRole('tablist', { name: 'Explorer and search' });
    await tabStrip.getByRole('tab', { name: 'Search' }).click();
    const searchPanel = window.getByTestId('explorer-search-panel-search');
    await expect(searchPanel.getByRole('button', { name: 'Use regular expression' })).toBeVisible({
      timeout: 15_000,
    });
    await searchPanel.getByPlaceholder('Search workspace').fill('export');
    await expect(searchPanel.getByTestId('workspace-search-results-error')).toBeVisible({
      timeout: 20_000,
    });
    const paneWidth = await shrinkFilesPaneToMinimum(window);
    expect(paneWidth).toBeGreaterThan(0);
    const layout = await searchControlLayout(window);
    expect(layout.panelWidth).toBeLessThanOrEqual(Math.ceil(paneWidth));
    expect(layout.scrollWidth).toBeLessThanOrEqual(Math.ceil(layout.panelWidth));
    expect(layout.controls.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'Search workspace',
        'Match case',
        'Match whole word',
        'Use regular expression',
        'Retry',
      ])
    );
    expect(layout.controls.filter(({ inside, reachable }) => !(inside && reachable))).toEqual([]);
  });
});
