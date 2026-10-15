import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { FileExplorerPage } from './page-objects/file-explorer-page';
import {
  bootstrapFileExplorer,
  type ExplorerBootstrapOptions,
  reloadExplorer,
} from './utils/file-explorer-setup';
import { openExplorerCompactMenu } from './utils/file-tree-locators';
import { CONTEXT_EXPLORER_PANEL_SELECTOR } from './utils/layout-helpers';
import type { FileTree } from './utils/mock-fs';

/**
 * Helper to ensure the selection settings button is available in the current explorer state.
 */
async function openSelectionSettings(page: Page) {
  const settingsButton = page.getByRole('button', { name: /Selection settings/i });
  if (await settingsButton.isVisible().catch(() => false)) {
    return settingsButton;
  }

  const selectRootButton = page.getByRole('button', { name: /^Add Folder to Workspace$/i });
  if (await selectRootButton.isVisible().catch(() => false)) {
    await selectRootButton.click();
  }

  await expect(settingsButton).toBeVisible();
  return settingsButton;
}

/**
 * Helper to open the selection settings popover and set the max selection count
 */
async function setMaxSelectionCount(page: Page, value: number | string): Promise<void> {
  const settingsButton = await openSelectionSettings(page);
  await settingsButton.click();

  // Wait for popover to be visible
  const input = page.getByLabel('Maximum selection count input');
  await expect(input).toBeVisible();

  // Fill in the value
  await input.fill(String(value));

  // Click the apply button (checkmark)
  await page.getByRole('button', { name: 'Apply selection count' }).click();

  // Wait for popover to close
  await expect(input).not.toBeVisible();
}

/**
 * Helper to get the current max selection count from the selection counter
 */
async function getMaxSelectionCount(page: Page): Promise<string> {
  const text = await page.getByTestId('selection-max').textContent();
  return text || '';
}

test.describe('File Explorer', () => {
  test.describe('core experience', () => {
    let explorer: FileExplorerPage;

    const defaultTree: FileTree = {
      folder1: {
        'nested.txt': null,
      },
      'test.ts': null,
      'test2.ts': null,
    };

    test.beforeEach(async ({ page }) => {
      explorer = await bootstrapFileExplorer(page, { tree: defaultTree });
    });

    test('should show initial empty state', { tag: '@web-smoke' }, async ({ page }) => {
      await expect(explorer.noDirectoryText).toBeVisible();
      await expect(explorer.selectRootButton).toBeVisible();
      await expect(explorer.selectionBar).toHaveCount(0);
      await expect(explorer.filterInput).not.toBeVisible();
      await expect(page.getByText('No folders in your workspace')).toBeVisible();
    });

    test('offers no export until files are selected', async () => {
      // Export lives in the selection bar (BST-2018), which shows only with a selection.
      await expect(explorer.exportTrigger).toHaveCount(0);
    });

    test('should show selection counter with initial state', async ({ page }) => {
      await expect(page.getByText('0/10')).toBeVisible();
    });

    test('keeps header controls usable when the explorer panel is narrowed', async ({ page }) => {
      await explorer.selectRoot();
      await page.getByTestId('hide-threads-panel').click();
      await expect(page.getByTestId('show-threads-panel')).toBeVisible();

      // The Files page is as wide as the workspace panel (BST-2018). Pin the
      // explorer to 180px, the narrowest it could be made, so the toolbar's
      // container queries are checked at that width.
      const explorerTab = page.getByTestId('explorer-search-panel-explorer');
      await explorerTab.evaluate((element) => {
        (element as HTMLElement).style.width = '180px';
      });
      const narrowedWidth = await explorerTab.evaluate(
        (element) => element.getBoundingClientRect().width
      );
      expect(narrowedWidth).toBeGreaterThanOrEqual(179);
      expect(narrowedWidth).toBeLessThanOrEqual(181);

      const toolbar = page.getByTestId('file-explorer-toolbar');
      await expect(toolbar.getByRole('button', { name: /^Selection settings/ })).toBeVisible();
      await expect(toolbar.getByTestId('selection-counter-control')).toBeVisible();
      await expect(toolbar.getByTestId('selection-count')).toBeVisible();
      await expect(toolbar.getByTestId('selection-compact-count')).not.toBeVisible();
      await expect(toolbar.getByRole('button', { name: 'Select All' })).toBeVisible();
      await expect(toolbar.getByTestId('bulk-action-full-label')).not.toBeVisible();

      const controlGeometry = await toolbar.getByRole('button').evaluateAll((buttons) =>
        buttons.flatMap((button) => {
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 ? [{ left: rect.left, right: rect.right }] : [];
        })
      );
      const toolbarGeometry = await toolbar.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          clientWidth: element.clientWidth,
          left: rect.left,
          right: rect.right,
          scrollWidth: element.scrollWidth,
        };
      });
      const sortedControls = [...controlGeometry].sort((a, b) => a.left - b.left);

      expect(toolbarGeometry.scrollWidth).toBeLessThanOrEqual(toolbarGeometry.clientWidth + 1);
      for (const control of sortedControls) {
        expect(control.left).toBeGreaterThanOrEqual(toolbarGeometry.left - 0.5);
        expect(control.right).toBeLessThanOrEqual(toolbarGeometry.right + 0.5);
      }
      for (let index = 1; index < sortedControls.length; index += 1) {
        expect(sortedControls[index]?.left ?? 0).toBeGreaterThanOrEqual(
          (sortedControls[index - 1]?.right ?? 0) - 0.5
        );
      }

      const edgeGutters = await toolbar.evaluate((element) => {
        const selectionSettings = element.querySelector('button[aria-label^="Selection settings"]');
        const bulkSelection = element.querySelector('button[aria-label="Select All"]');
        if (!(selectionSettings && bulkSelection)) {
          throw new Error('Expected both edge controls in the Explorer toolbar');
        }
        const toolbarRect = element.getBoundingClientRect();
        const selectionRect = selectionSettings.getBoundingClientRect();
        const bulkRect = bulkSelection.getBoundingClientRect();
        return {
          left: selectionRect.left - toolbarRect.left,
          right: toolbarRect.right - bulkRect.right,
        };
      });
      expect(edgeGutters.left).toBeGreaterThanOrEqual(11.5);
      expect(edgeGutters.right).toBeGreaterThanOrEqual(11.5);
      expect(Math.abs(edgeGutters.left - edgeGutters.right)).toBeLessThanOrEqual(1);

      const addFolderCenterDelta = await toolbar
        .getByRole('button', { name: 'Add Folder to Workspace' })
        .evaluate((button, toolbarTestId) => {
          const toolbarElement = button.closest(`[data-testid="${toolbarTestId}"]`);
          if (!toolbarElement) {
            throw new Error('File explorer toolbar ancestor is missing');
          }
          const buttonRect = button.getBoundingClientRect();
          const toolbarRect = toolbarElement.getBoundingClientRect();
          return Math.abs(
            buttonRect.left + buttonRect.width / 2 - (toolbarRect.left + toolbarRect.width / 2)
          );
        }, 'file-explorer-toolbar');
      expect(addFolderCenterDelta).toBeLessThanOrEqual(1);

      const toolbarControlCenters = await toolbar.evaluate((element) => {
        const centerX = (target: Element): number => {
          const rect = target.getBoundingClientRect();
          return rect.left + rect.width / 2;
        };
        const selectionSettings = element.querySelector('button[aria-label^="Selection settings"]');
        const addFolder = element.querySelector('button[aria-label="Add Folder to Workspace"]');
        const bulkSelection = element.querySelector('button[aria-label="Select All"]');
        if (!(selectionSettings && addFolder && bulkSelection)) {
          throw new Error('Expected all three Explorer toolbar controls');
        }
        return {
          addFolder: centerX(addFolder),
          bulkSelection: centerX(bulkSelection),
          selectionSettings: centerX(selectionSettings),
        };
      });
      expect(toolbarControlCenters.selectionSettings).toBeLessThan(toolbarControlCenters.addFolder);
      expect(toolbarControlCenters.addFolder).toBeLessThan(toolbarControlCenters.bulkSelection);

      const compactActions = toolbar.getByRole('button', { name: 'More Explorer actions' });
      await expect(compactActions).toBeVisible();
      await expect(toolbar.getByTestId('refresh-button-small')).not.toBeVisible();
      await compactActions.click();
      await page.getByRole('menuitem', { name: 'Hide view filters' }).click();
      await expect(page.locator('#view-filters-content')).toHaveAttribute('inert', '');
      await compactActions.click();
      await page.getByRole('menuitem', { name: 'Show view filters' }).click();
      await expect(page.locator('#view-filters-content')).not.toHaveAttribute('inert');

      await page.getByRole('button', { name: /^Selection settings/ }).press('Enter');
      await expect(page.getByRole('button', { name: '5K' })).toBeVisible();
      await expect(page.getByRole('button', { name: '6K' })).toBeVisible();
      await expect(page.getByRole('button', { name: '8K' })).toBeVisible();
    });

    test('keeps sparse file-tree rows intrinsic while its scrollport fills the panel', async ({
      page,
    }) => {
      explorer = await bootstrapFileExplorer(page, {
        resetSettings: true,
        tree: {
          'only-file.ts': 'export const onlyFile = true;',
        },
      });

      await explorer.selectRoot();
      await expect(
        explorer.fileTree.getByRole('checkbox', { name: 'Select only-file.ts' })
      ).toBeVisible();

      const geometry = await explorer.fileTree.evaluate((treegrid) => {
        const owner = treegrid.parentElement;
        const row = treegrid.querySelector<HTMLElement>('tbody tr');
        const panel = treegrid.closest<HTMLElement>('[data-testid="file-tree"]');
        if (!(owner && row && panel)) {
          throw new Error('Expected a complete sparse file-tree surface');
        }

        const ownerRect = owner.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        // The single-root grid's sticky column header (BST-1208) is IN FLOW
        // inside the table, so it contributes to the table's painted height.
        // Subtract the MEASURED header (0 on headerless surfaces) — the same
        // coordinate rule as the pitch spec below; see the "header inside the
        // scrollport" section of docs/agents/ui-conventions.md.
        const header = treegrid.querySelector<HTMLElement>('thead');
        return {
          headerHeight: header ? header.getBoundingClientRect().height : 0,
          ownerBottom: ownerRect.bottom,
          ownerHeight: ownerRect.height,
          ownerOverflowX: getComputedStyle(owner).overflowX,
          ownerOverflowY: getComputedStyle(owner).overflowY,
          panelBottom: panelRect.bottom,
          rowHeight: rowRect.height,
          tableHeight: treegrid.getBoundingClientRect().height,
        };
      });

      expect(geometry.ownerOverflowX).toBe('auto');
      expect(geometry.ownerOverflowY).toBe('auto');
      expect(Math.abs(geometry.ownerBottom - geometry.panelBottom)).toBeLessThanOrEqual(1);
      expect(geometry.ownerHeight).toBeGreaterThan(geometry.rowHeight * 3);
      expect(geometry.rowHeight).toBeLessThanOrEqual(40);
      // Intrinsic CONTENT height: one sparse row must not stretch to fill the
      // panel, whatever chrome the header adds above it.
      expect(geometry.tableHeight - geometry.headerHeight).toBeLessThanOrEqual(40);
    });

    test('paints tree rows at exactly the pitch its virtualizer models', {
      tag: '@web-smoke',
    }, async ({ page }) => {
      // OptimizedFileTree passes TreeTable a NUMERIC rowHeight, which disables
      // per-row measurement: nothing ever reconciles the declared pitch with the
      // painted one, so a wrong constant silently skews every offset the
      // virtualizer computes. Derive the declared pitch back out of the top
      // spacer (paddingTop === firstRenderedIndex * rowHeight) and compare it to
      // real painted geometry — this stays true whatever the constant's value,
      // so a future row-CSS change that shifts the pitch fails here.
      //
      // Tagged @web-smoke deliberately: this is the ONLY check that can catch
      // pitch drift (jsdom has no layout), so it has to gate merges rather than
      // report the regression the next morning. The tree is sized to the
      // invariant's actual need — enough rows for an interior window with a
      // spacer on both sides — not to a round number, to stay cheap enough for
      // a lane that runs --workers=2 --max-failures=1.
      const rowCount = 240;
      const scrollTarget = 2400;

      explorer = await bootstrapFileExplorer(page, {
        resetSettings: true,
        tree: Object.fromEntries(
          Array.from({ length: rowCount }, (_, index) => [
            `file-${String(index).padStart(4, '0')}.ts`,
            `export const value${index} = ${index};`,
          ])
        ),
      });

      await explorer.selectRoot();
      await expect(
        explorer.fileTree.getByRole('checkbox', { name: 'Select file-0000.ts' })
      ).toBeVisible();

      const geometry = await explorer.fileTree.evaluate(async (treegrid, targetScrollTop) => {
        const viewport = treegrid.closest<HTMLElement>('[data-testid="tree-table-viewport"]');
        const body = treegrid.querySelector('tbody');
        if (!(viewport && body)) {
          throw new Error('Expected the file tree to own a tree-table viewport');
        }
        // The sticky header lives INSIDE this scrollport and is IN FLOW, so it
        // occupies the first `headerHeight` px of the scroll content. The
        // virtualizer models tbody rows only (`paddingTop = index * rowHeight`,
        // scrollMargin 0 in own-scrollport mode), so every comparison below has
        // to convert scrollport coordinates into the row model's own space by
        // subtracting it. Measured, not assumed — a headerless surface reads 0.
        const headerHeight = treegrid.querySelector('thead')?.getBoundingClientRect().height ?? 0;

        const readWindowStart = (): number => {
          const first = [...body.children].find(
            (row): row is HTMLElement =>
              row instanceof HTMLElement && row.dataset['nodeId'] !== undefined
          );
          return first ? Number(first.dataset['index']) : Number.NaN;
        };

        // Land mid-list so BOTH spacers exist and the window is fully interior.
        // The virtualizer is configured `useFlushSync: false`, so its re-render
        // is deliberately NOT synchronous with the scroll event — wait on the
        // window actually settling rather than on a fixed frame count, which
        // would be a time-based bet that a loaded CI runner eventually loses.
        viewport.scrollTop = targetScrollTop;
        let previousStart = Number.NaN;
        let stableFrames = 0;
        let frames = 0;
        while (stableFrames < 3) {
          await new Promise((resolve) => {
            requestAnimationFrame(() => resolve(undefined));
          });
          const currentStart = readWindowStart();
          // NaN === NaN is false, so an empty window can never look stable.
          stableFrames = currentStart === previousStart ? stableFrames + 1 : 0;
          previousStart = currentStart;
          frames += 1;
          if (frames > 180) {
            throw new Error(
              `Virtual window never settled at scrollTop ${targetScrollTop} (last start index ${currentStart}).`
            );
          }
        }

        const children = [...body.children];
        const rows = children.filter(
          (row): row is HTMLElement =>
            row instanceof HTMLElement && row.dataset['nodeId'] !== undefined
        );
        // The LEADING spacer specifically: TreeTable only renders it when
        // paddingTop > 0, so a window starting at index 0 would let a positional
        // `find` return the trailing spacer and derive a nonsense pitch.
        const leading = children[0];
        const topSpacer =
          leading instanceof HTMLElement && leading.dataset['nodeId'] === undefined
            ? leading
            : undefined;
        const firstRow = rows[0];
        if (!(topSpacer && firstRow && rows.length > 4)) {
          throw new Error('Expected a virtualized interior window with a leading spacer');
        }

        const firstIndex = Number(firstRow.dataset['index']);
        if (!firstIndex) {
          throw new Error(
            `Expected an interior window, but it starts at row ${firstIndex} — the scroll never landed mid-list.`
          );
        }
        const declaredPitch = topSpacer.getBoundingClientRect().height / firstIndex;

        // Median of consecutive row tops: the pitch the browser actually paints,
        // immune to the half-pixel a collapsed border leaves on an edge row.
        const tops = rows.map((row) => row.getBoundingClientRect().top);
        const deltas = tops.slice(1).map((top, index) => top - (tops[index] ?? 0));
        deltas.sort((left, right) => left - right);
        const paintedPitch = deltas[Math.floor(deltas.length / 2)] ?? 0;

        const viewportTop = viewport.getBoundingClientRect().top;
        const topmostVisible = rows.find(
          (row) => row.getBoundingClientRect().bottom > viewportTop + 0.5
        );

        // Snapshot every scroll-dependent measurement BEFORE the reveal probe
        // below moves scrollTop — reading them afterwards would silently mix
        // two different scroll positions.
        const contentHeight = viewport.scrollHeight - headerHeight;
        const modelledTopIndex = Math.floor((viewport.scrollTop - headerHeight) / declaredPitch);
        const paintedTopIndex = topmostVisible ? Number(topmostVisible.dataset['index']) : -1;

        // Reveal check: keyboard/scroll-to-row must never park a row UNDER the
        // sticky header. It works because the header is in flow — the
        // virtualizer's `scrollTop = index * rowHeight` (scrollMargin 0) and the
        // row's real content offset of `headerHeight + index * rowHeight`
        // cancel, landing the row flush at the header's bottom edge. Adding a
        // header-sized scrollMargin, or taking the header out of flow, would
        // break that; this is what would catch it.
        //
        // Runs LAST because it scrolls.
        //
        // `index * declaredPitch` is the virtualizer's OWN offset for a
        // start-aligned reveal (scrollMargin 0, model coordinates) — not the
        // row's content offset. Using the content offset here would scroll
        // `headerHeight` too far and park the row under the header, which is
        // precisely the bug this asserts cannot happen.
        const targetIndex = 120;
        viewport.scrollTop = targetIndex * declaredPitch;
        let revealSettleFrames = 0;
        while (revealSettleFrames < 3) {
          await new Promise((resolve) => {
            requestAnimationFrame(() => resolve(undefined));
          });
          revealSettleFrames += 1;
        }
        const revealedRow = [...body.children].find(
          (candidate): candidate is HTMLElement =>
            candidate instanceof HTMLElement && candidate.dataset['index'] === String(targetIndex)
        );
        const revealHeaderBottom = viewport.getBoundingClientRect().top + headerHeight;
        const revealedBox = revealedRow?.getBoundingClientRect();

        return {
          contentHeight,
          declaredPitch,
          headerHeight,
          modelledTopIndex,
          paintedPitch,
          paintedTopIndex,
          revealHeaderBottomGap: revealedBox ? revealedBox.top - revealHeaderBottom : Number.NaN,
          revealOccludedPx: revealedBox
            ? Math.max(0, Math.min(revealedBox.bottom, revealHeaderBottom) - revealedBox.top)
            : Number.NaN,
        };
      }, scrollTarget);

      // The virtualizer's per-row step must be the step the browser paints.
      expect(Math.abs(geometry.declaredPitch - geometry.paintedPitch)).toBeLessThan(0.5);
      // …so the scrollport is as tall as the model claims, and the row sitting at
      // the top edge is the row the model believes is there. The 1px tolerance is
      // TableBody's `[&_tr:last-child]:border-0` dropping the final row's rule.
      //
      // Both are measured in the ROW MODEL's coordinate space: the sticky header
      // is in flow inside this scrollport, so it contributes to scrollHeight and
      // shifts scrollTop, while the virtualizer models tbody rows alone. That is
      // a coordinate conversion, not a slackening — the tolerances are unchanged
      // and the index comparison is still exact.
      expect(
        Math.abs(geometry.contentHeight - rowCount * geometry.declaredPitch)
      ).toBeLessThanOrEqual(1);
      expect(geometry.paintedTopIndex).toBe(geometry.modelledTopIndex);

      // A revealed row lands flush BELOW the sticky header, never under it.
      expect(geometry.headerHeight).toBeGreaterThan(0);
      expect(geometry.revealOccludedPx).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.revealHeaderBottomGap)).toBeLessThanOrEqual(1);
    });

    test('renders no focused-root badge or separate current-directory row in the toolbar', async ({
      page,
    }) => {
      await explorer.selectRoot();

      // Multi-root: the focused-root folder badge was removed because it implied
      // a single active root. The toolbar now holds workspace-wide actions only.
      const toolbar = page.getByTestId('file-explorer-toolbar');
      await expect(toolbar).not.toContainText('test-root');
      await expect(page.getByText(/current directory/i)).toHaveCount(0);
    });

    // ADR-0021 (BST-2018): the Files app is the explorer, with no preview of
    // the selection; selected files are exported from the selection bar.
    test('presents the explorer as the whole Files page, exporting from the selection bar', {
      tag: '@web-smoke',
    }, async ({ page }) => {
      await explorer.selectRoot();
      await expect(page.getByTestId('explorer-search-tab-strip')).toBeVisible();

      await explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' }).click({
        force: true,
      });
      await explorer.fileTree.getByRole('checkbox', { name: 'Select test2.ts' }).click({
        force: true,
      });

      await expect(page.getByTestId('show-explorer-panel')).toHaveCount(0);
      await expect(page.getByTestId('hide-explorer-panel')).toHaveCount(0);
      await expect(page.getByText('2 files selected', { exact: true })).toBeVisible();
      await expect(explorer.exportTrigger).toBeEnabled();
    });

    test('should allow downloading context with multiple file selections', async ({ page }) => {
      await explorer.selectRoot();

      await expect(explorer.filterInput).toBeVisible({ timeout: 10_000 });
      await expect(explorer.noDirectoryText).not.toBeVisible();

      const file1Checkbox = explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' });
      const file2Checkbox = explorer.fileTree.getByRole('checkbox', { name: 'Select test2.ts' });

      await expect(file1Checkbox).toBeVisible();
      await file1Checkbox.click({ force: true });
      await expect(file1Checkbox).toBeChecked();

      await expect(file2Checkbox).toBeVisible();
      await file2Checkbox.click({ force: true });
      await expect(file2Checkbox).toBeChecked();

      await expect(page.getByText('2/10')).toBeVisible();

      await explorer.exportTrigger.click();
      await expect(explorer.includeProjectTreeToggle).toBeVisible();
      await expect(explorer.exportDownloadButton).toBeEnabled();

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        explorer.exportDownloadButton.click(),
      ]);

      expect(download.suggestedFilename()).toMatch(/context/i);
    });
  });

  test.describe('high-count responsive header', () => {
    test('contains a four-digit selection at the minimum Explorer width', async ({ page }) => {
      const largeTree = Object.fromEntries(
        Array.from({ length: 1000 }, (_, index) => [`file-${index}.txt`, null])
      ) as FileTree;
      const largeExplorer = await bootstrapFileExplorer(page, {
        resetSettings: true,
        tree: largeTree,
      });

      await largeExplorer.selectRoot();
      await setMaxSelectionCount(page, 8000);
      await largeExplorer.selectAllButton.click();
      await expect(page.getByTestId('selection-settings-button')).toHaveAccessibleName(
        /1000 of 8000 files selected/,
        { timeout: 20_000 }
      );
      await expect(page.getByTestId('selection-counter-control')).toBeVisible();
      await expect(page.getByTestId('selection-count')).toHaveText('1K');

      await page.getByTestId('hide-threads-panel').click();
      await expect(page.getByTestId('show-threads-panel')).toBeVisible();
      // The Files page is as wide as the workspace panel (BST-2018). Pin the
      // explorer to 180px, the narrowest it could be made, so the toolbar's
      // container queries are checked at that width.
      const explorerTab = page.getByTestId('explorer-search-panel-explorer');
      await explorerTab.evaluate((element) => {
        (element as HTMLElement).style.width = '180px';
      });
      await expect(explorerTab).toBeVisible();

      const geometry = await page.getByTestId('file-explorer-toolbar').evaluate((element) => {
        const toolbarRect = element.getBoundingClientRect();
        const buttons = Array.from(element.querySelectorAll('button'))
          .map((button) => button.getBoundingClientRect())
          .filter((button) => button.width > 0 && button.height > 0)
          .sort((left, right) => left.left - right.left);
        return {
          buttons: buttons.map((button) => ({ left: button.left, right: button.right })),
          clientWidth: element.clientWidth,
          left: toolbarRect.left,
          right: toolbarRect.right,
          scrollWidth: element.scrollWidth,
        };
      });

      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
      for (const button of geometry.buttons) {
        expect(button.left).toBeGreaterThanOrEqual(geometry.left - 0.5);
        expect(button.right).toBeLessThanOrEqual(geometry.right + 0.5);
      }
      for (let index = 1; index < geometry.buttons.length; index += 1) {
        expect(geometry.buttons[index]?.left ?? 0).toBeGreaterThanOrEqual(
          (geometry.buttons[index - 1]?.right ?? 0) - 0.5
        );
      }
    });
  });

  test.describe('filtering', () => {
    async function openViewFilters(page: Page): Promise<void> {
      // Both action surfaces render only once a root is attached, so gate on
      // that before probing visibility — otherwise "not rendered yet" is
      // indistinguishable from "compact layout".
      const viewFiltersContent = page.locator('#view-filters-content');
      await expect(viewFiltersContent).toBeAttached({ timeout: 10_000 });

      const viewFiltersToggle = page.getByRole('button', { name: /view filters/i });
      if (await viewFiltersToggle.isVisible()) {
        if ((await viewFiltersToggle.getAttribute('aria-expanded')) !== 'true') {
          await viewFiltersToggle.click();
        }

        await expect(viewFiltersToggle).toHaveAttribute('aria-expanded', 'true');
      } else {
        const explorerMenu = await openExplorerCompactMenu(page);

        const showViewFilters = explorerMenu.getByRole('menuitem', {
          name: /^Show view filters/,
        });
        if ((await showViewFilters.count()) > 0) {
          await showViewFilters.click();
        } else {
          await expect(
            explorerMenu.getByRole('menuitem', { name: 'Hide view filters' })
          ).toBeVisible();
          await page.keyboard.press('Escape');
        }

        await expect(explorerMenu).toHaveCount(0);
      }

      await expect(viewFiltersContent).not.toHaveAttribute('inert');
    }

    async function getPresetTrigger(page: Page) {
      const presetTrigger = page
        .locator(CONTEXT_EXPLORER_PANEL_SELECTOR)
        .locator('button')
        .filter({
          hasText:
            /custom filters|select filter|source files|documentation|typescript\/javascript/i,
        })
        .first();

      await expect(presetTrigger).toBeVisible({ timeout: 10_000 });
      await expect(presetTrigger).toBeEnabled({ timeout: 10_000 });
      return presetTrigger;
    }

    interface FilterScenario {
      before?: (ctx: { page: Page; explorer: FileExplorerPage }) => Promise<void>;
      expectedHidden: string[];
      expectedVisible: string[];
      query: string;
      title: string;
    }

    const tree: FileTree = {
      'Button.test.tsx': null,
      'Button.tsx': null,
      'config.json': null,
      'legacy.js': null,
      my_custom_coverage: {
        'lcov.info': null,
      },
      my_custom_modules: {
        'some-package': {
          'index.js': null,
        },
      },
      'OldComponent.jsx': null,
      'package.json': null,
      'utils.test.ts': null,
      'utils.ts': null,
    };

    test.describe('default tree', () => {
      const bootstrapOptions: ExplorerBootstrapOptions = {
        clearStorageKeys: ['panel-layout-store.v1'],
        projectName: 'test-project',
        resetSettings: true,
        tree,
        waitForDatabase: true,
      };

      let explorer: FileExplorerPage;

      test.beforeEach(async ({ page }) => {
        explorer = await bootstrapFileExplorer(page, bootstrapOptions);

        await expect(page.getByText('No folders in your workspace')).toBeVisible({
          timeout: 15_000,
        });
        await expect(explorer.selectionBar).toHaveCount(0);

        await explorer.selectRoot();

        await expect(explorer.filterInput).toBeVisible({ timeout: 10_000 });
        await expect(explorer.noDirectoryText).not.toBeVisible();
        await expect(explorer.fileTree).toBeVisible();
      });

      test('keeps the preset trigger enabled when view filters first appear', async ({ page }) => {
        await openViewFilters(page);
        await getPresetTrigger(page);
      });

      test('loads presets and applies a selected preset from the dropdown', async ({ page }) => {
        await openViewFilters(page);

        const presetTrigger = await getPresetTrigger(page);
        await presetTrigger.click();

        await expect(page.getByText('Loading presets...')).toBeHidden({ timeout: 10_000 });

        const documentationOption = page.getByRole('button', { name: /documentation/i }).first();
        await expect(documentationOption).toBeVisible({ timeout: 10_000 });
        await documentationOption.click();

        await expect(
          page.locator(CONTEXT_EXPLORER_PANEL_SELECTOR).getByRole('button', {
            name: /documentation/i,
          })
        ).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText('Select filter...')).toHaveCount(0);
      });

      test('does not stay stuck on loading presets after opening the dropdown', async ({
        page,
      }) => {
        await openViewFilters(page);

        const presetTrigger = await getPresetTrigger(page);
        await presetTrigger.click();

        await expect(page.getByText('Loading presets...')).toBeHidden({ timeout: 10_000 });
        await expect(page.getByRole('button', { name: /documentation/i }).first()).toBeVisible({
          timeout: 10_000,
        });
      });

      const scenarios: FilterScenario[] = [
        {
          expectedHidden: ['utils.ts', 'package.json'],
          expectedVisible: ['Button.tsx', 'Button.test.tsx'],
          query: 'Button',
          title: 'matches files by substring',
        },
        {
          expectedHidden: ['Button.tsx', 'utils.ts'],
          expectedVisible: ['Button.test.tsx', 'utils.test.ts'],
          query: '.test',
          title: 'filters down to test files',
        },
        {
          expectedHidden: ['utils.test.ts', 'Button.tsx'],
          expectedVisible: ['utils.ts'],
          query: 'utils -test',
          title: 'supports negation syntax',
        },
        {
          before: async ({ explorer }) => {
            await explorer.filterInput.fill('Button');
            await expect(explorer.fileTree.getByText('Button.tsx')).toBeVisible();
            await expect(explorer.fileTree.getByText('utils.ts')).not.toBeVisible();
          },
          expectedHidden: [],
          expectedVisible: ['Button.tsx', 'utils.ts'],
          query: '',
          title: 'clearing the filter restores the tree',
        },
      ];

      for (const scenario of scenarios) {
        test(scenario.title, async ({ page }) => {
          if (scenario.before) {
            await scenario.before({ explorer, page });
          }

          await explorer.filterInput.fill(scenario.query);

          for (const fileName of scenario.expectedVisible) {
            await expect(explorer.fileTree.getByText(fileName)).toBeVisible();
          }

          for (const fileName of scenario.expectedHidden) {
            await expect(explorer.fileTree.getByText(fileName)).not.toBeVisible();
          }
        });
      }
    });

    test.fixme('keeps root Select All and single-click expansion aligned with the TypeScript/JavaScript preset', {
      annotation: { description: 'BST-1953', type: 'quarantine' },
    }, async ({ page }) => {
      const presetTree: FileTree = {
        assets: {
          'logo.png': null,
        },
        docs: {
          'guide.md': null,
        },
        scripts: {
          'build.js': null,
        },
        src: {
          'app.ts': null,
          nested: {
            'deep.tsx': null,
            'notes.txt': null,
          },
          'readme.md': null,
        },
      };

      const filteredExplorer = await bootstrapFileExplorer(page, {
        clearStorageKeys: ['panel-layout-store.v1'],
        projectName: 'filtered-select-all-project',
        resetSettings: true,
        tree: presetTree,
        waitForDatabase: true,
      });

      await filteredExplorer.selectRoot();
      await openViewFilters(page);

      const presetTrigger = await getPresetTrigger(page);
      await presetTrigger.click();
      await expect(page.getByText('Loading presets...')).toBeHidden({ timeout: 10_000 });

      const tsPresetOption = page.getByRole('button', { name: /typescript\/javascript/i }).first();
      await expect(tsPresetOption).toBeVisible({ timeout: 10_000 });
      await tsPresetOption.click();

      await expect(
        page.locator(CONTEXT_EXPLORER_PANEL_SELECTOR).getByRole('button', {
          name: /typescript\/javascript/i,
        })
      ).toBeVisible({ timeout: 10_000 });

      await filteredExplorer.selectAllButton.click();

      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select src' })
      ).toHaveAttribute('data-state', 'checked');
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select scripts' })
      ).toHaveAttribute('data-state', 'checked');
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select docs' })
      ).toHaveAttribute('data-state', 'unchecked');
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select assets' })
      ).toHaveAttribute('data-state', 'unchecked');

      const srcRow = filteredExplorer.fileTree.getByRole('row', {
        name: /Select src src/i,
      });
      const srcExpandButton = srcRow.getByRole('button', { name: 'Expand' });
      if (await srcExpandButton.isVisible()) {
        await srcExpandButton.click();
      }

      await expect(filteredExplorer.fileTree.getByText('app.ts')).toBeVisible({ timeout: 10_000 });
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select app.ts' })
      ).toBeChecked();
      await expect(filteredExplorer.fileTree.getByText('readme.md')).not.toBeVisible();

      const nestedRow = filteredExplorer.fileTree.getByRole('row', {
        name: /Select nested nested/i,
      });
      const nestedExpandButton = nestedRow.getByRole('button', { name: 'Expand' });
      if (await nestedExpandButton.isVisible()) {
        await nestedExpandButton.click();
      }

      await expect(filteredExplorer.fileTree.getByText('deep.tsx')).toBeVisible({
        timeout: 10_000,
      });
      await expect(
        filteredExplorer.fileTree.getByRole('checkbox', { name: 'Select deep.tsx' })
      ).toBeChecked();
      await expect(filteredExplorer.fileTree.getByText('notes.txt')).not.toBeVisible();
    });
  });

  test.describe('settings persistence', () => {
    interface SettingsScenario {
      execute: (ctx: { page: Page; explorer: FileExplorerPage }) => Promise<void>;
      name: string;
      options?: Partial<ExplorerBootstrapOptions>;
      tree: FileTree;
    }

    const settingsScenarios: SettingsScenario[] = [
      {
        execute: async ({ page }) => {
          await setMaxSelectionCount(page, 5);

          await reloadExplorer(page);

          const maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('5');
        },
        name: 'persists updates to max selection count',
        tree: { 'example.ts': null },
      },
      {
        execute: async ({ page }) => {
          // Try to set invalid value (too low)
          const settingsButton = await openSelectionSettings(page);
          await settingsButton.click();

          const input = page.getByLabel('Maximum selection count input');
          await expect(input).toBeVisible();

          await input.fill('0');
          await page.getByRole('button', { name: 'Apply selection count' }).click();

          // Should show error message
          await expect(page.getByText('Minimum selection count is 1')).toBeVisible();

          // Cancel and close popover
          await page.getByRole('button', { name: 'Close selection settings' }).click();
          await expect(input).not.toBeVisible();

          // Value should still be the default (DEFAULT_MAX_SELECTION_COUNT = 1000)
          let maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('1000');

          // Try to set invalid value (too high)
          await settingsButton.click();
          await expect(input).toBeVisible();

          await input.fill('50000');
          await page.getByRole('button', { name: 'Apply selection count' }).click();

          // Should show error message
          await expect(page.getByText('Maximum selection count is 10,000')).toBeVisible();

          // Cancel and close popover
          await page.getByRole('button', { name: 'Close selection settings' }).click();
          await expect(input).not.toBeVisible();

          // Value should still be the default
          maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('1000');
        },
        name: 'validates Max Selection Count values',
        tree: { 'a.ts': null, 'b.ts': null },
      },
      // Note: Include/Exclude filters and Use Regex toggle were moved to ViewFilterPresetDropdown
      // Persistence of filter presets is tested in view-filter-preset tests
      {
        execute: async ({ page, explorer }) => {
          // The toggle lives in the selection bar's Export popover (BST-2018).
          const openExport = async () => {
            await explorer.selectRoot();
            const src = explorer.fileTree.getByRole('checkbox', { name: 'Select src' });
            if ((await src.getAttribute('data-state')) !== 'checked') {
              await src.click({ force: true });
            }
            await explorer.exportTrigger.click();
            await expect(explorer.includeProjectTreeToggle).toBeVisible();
          };
          await openExport();
          await explorer.includeProjectTreeToggle.click();
          await expect(explorer.includeProjectTreeToggle).toHaveAttribute('aria-checked', 'false');

          await reloadExplorer(page);

          await openExport();
          await expect(explorer.includeProjectTreeToggle).toHaveAttribute('aria-checked', 'false');
        },
        name: 'persists Include Project Tree toggle',
        tree: {
          src: {
            'component.tsx': null,
          },
        },
      },
      {
        execute: async ({ explorer, page }) => {
          await explorer.selectRoot();
          await setMaxSelectionCount(page, 1);

          const fileTree = explorer.fileTree;
          const first = fileTree.getByRole('checkbox', { name: 'Select a.ts' });
          const second = fileTree.getByRole('checkbox', { name: 'Select b.ts' });

          await first.click({ force: true });
          await second.click({ force: true });

          // Scope to the selection counter — a bare getByText('1/1') also
          // matches the tree pager's "Page 1 of 1" output (strict mode).
          await expect(
            page.getByTestId('selection-counter-control').getByText('1/1')
          ).toBeVisible();
        },
        name: 'caps selections when Max Selection Count is reduced',
        tree: { 'a.ts': null, 'b.ts': null },
      },
    ];

    for (const scenario of settingsScenarios) {
      test(scenario.name, async ({ page }) => {
        const options: ExplorerBootstrapOptions = {
          resetSettings: true,
          tree: scenario.tree,
          ...(scenario.options ?? {}),
        };

        const explorer = await bootstrapFileExplorer(page, options);

        await scenario.execute({ explorer, page });
      });
    }
  });

  test.describe('Select All across unexpanded subfolders', () => {
    test('counts tokens for files inside unexpanded subfolders after Select All (web parity with desktop)', async ({
      page,
    }) => {
      const browserLogs: string[] = [];
      page.on('console', (msg) => {
        const text = `[${msg.type()}] ${msg.text()}`;
        browserLogs.push(text);
      });
      page.on('pageerror', (err) => {
        browserLogs.push(`[pageerror] ${err.message}`);
      });
      // Files live exclusively inside nested subfolders so the bug shows up as
      // a stalled or partial token total rather than partial credit from any
      // top-level files. Single-character fixture contents keep the expected
      // total stable in both heuristic and WASM token-counting modes.
      const shallowContent = 'a';
      const deepContent = 'b';
      const expectedTokens = 2;
      const expectedSelectedFiles = 2;

      const explorer = await bootstrapFileExplorer(page, {
        resetSettings: true,
        tree: {
          src: {
            inner: {
              'deep.ts': deepContent,
            },
            'shallow.ts': shallowContent,
          },
        },
      });

      await explorer.selectRoot();

      // Sanity-check the bug surface: both subfolder rows are present but
      // collapsed. We deliberately do NOT click any expand chevron — that is
      // exactly the state where the web indexer used to skip nested files.
      const srcRow = explorer.fileTree.getByRole('row', { name: /Select src src/i });
      await expect(srcRow.getByRole('button', { name: 'Expand' })).toBeVisible();
      await expect(explorer.fileTree.getByText('shallow.ts')).toHaveCount(0);
      await expect(explorer.fileTree.getByText('deep.ts')).toHaveCount(0);

      await explorer.selectAllButton.click();

      // SelectionCounter should reflect the full recursive selection regardless
      // of UI expansion. This part already works on web today and acts as a
      // control assertion: if it fails, the bug is no longer the indexer path.
      await expect(page.getByTestId('selection-count')).toHaveText(String(expectedSelectedFiles));

      // The Export popover totals the selection from the token cache (BST-2018);
      // it reports uncounted files as pending, never as zero. Without the
      // indexer fix the files inside the unexpanded `src/` and `src/inner/`
      // subfolders would never be counted, so this would stay pending.
      await explorer.exportTrigger.click();
      try {
        await expect(page.getByTestId('explorer-export-tokens')).toHaveText(
          `~${expectedTokens.toLocaleString()} tokens`,
          { timeout: 30_000 }
        );
      } catch (err) {
        // Re-emit captured browser logs so failures surface their root cause.
        console.log('--- captured browser logs ---');
        for (const line of browserLogs.slice(-150)) {
          console.log(line);
        }
        throw err;
      }
    });
  });
});
