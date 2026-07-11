import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { FileExplorerPage } from './page-objects/file-explorer-page';
import {
  bootstrapFileExplorer,
  type ExplorerBootstrapOptions,
  reloadExplorer,
} from './utils/file-explorer-setup';
import {
  CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR,
  getContextExplorerRightResizeHandle,
} from './utils/layout-helpers';
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
      await expect(explorer.noFilesText).toBeVisible();
      await expect(explorer.filterInput).not.toBeVisible();
      await expect(page.getByText('No folders in your workspace')).toBeVisible();
      await expect(page.getByText('No files selected')).toBeVisible();
    });

    test('should show action buttons in disabled state initially', async () => {
      await expect(explorer.downloadContextButton).toBeVisible({ timeout: 10_000 });
      await expect(explorer.downloadContextButton).toBeDisabled();
      await expect(explorer.copyContextButton).toBeVisible();
      await expect(explorer.copyContextButton).toBeDisabled();
      await expect(explorer.includeProjectTreeToggle).toBeVisible();
    });

    test('should show selection counter with initial state', async ({ page }) => {
      await expect(page.getByText('0/10')).toBeVisible();
    });

    test('keeps header controls usable when the explorer panel is narrowed', async ({ page }) => {
      await explorer.selectRoot();
      await page.getByTestId('hide-threads-panel').click();
      await expect(page.getByTestId('show-threads-panel')).toBeVisible();

      const rightPanel = page.locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR);
      const initialWidth = await rightPanel.evaluate(
        (element) => element.getBoundingClientRect().width
      );

      const resizeHandle = getContextExplorerRightResizeHandle(page);
      const handleBox = await resizeHandle.boundingBox();
      if (!handleBox) {
        throw new Error('Resize handle not found');
      }
      const panelGroupRight = await rightPanel.evaluate((element) => {
        const group = element.closest('[data-group]');
        if (!group) {
          throw new Error('Explorer panel group is missing');
        }
        return group.getBoundingClientRect().right;
      });

      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      // Moving the right-panel's handle to the right makes the right panel narrower
      await page.mouse.move(panelGroupRight - 180, handleBox.y + handleBox.height / 2, {
        steps: 20,
      });
      await page.mouse.up();

      await page.waitForTimeout(300);

      const narrowedWidth = await rightPanel.evaluate(
        (element) => element.getBoundingClientRect().width
      );
      expect(narrowedWidth).toBeLessThanOrEqual(initialWidth);
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
        return {
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
      expect(geometry.tableHeight).toBeLessThanOrEqual(40);
    });

    test('uses one bottom-anchored scrollport with sticky table headers', async ({ page }) => {
      explorer = await bootstrapFileExplorer(page, {
        resetSettings: true,
        tree: Object.fromEntries(
          Array.from({ length: 24 }, (_, index) => [
            `long-context-file-name-${String(index).padStart(2, '0')}.ts`,
            `export const value${index} = ${index};`,
          ])
        ),
      });

      await explorer.selectRoot();
      await setMaxSelectionCount(page, 50);
      await explorer.selectAllButton.click();
      await expect(page.getByTestId('selection-count')).toHaveText('24', { timeout: 15_000 });

      const previewTable = page.getByTestId('preview-table');
      const contextTree = page.getByRole('treegrid', { name: 'Context explorer table' });
      await expect(previewTable).toBeVisible();
      await expect(contextTree).toBeVisible();

      const geometry = await previewTable.evaluate(async (previewElement) => {
        const treegrid = previewElement.querySelector<HTMLElement>('[role="treegrid"]');
        if (!treegrid) {
          throw new Error('Context explorer treegrid is missing');
        }

        const scrollOwners: HTMLElement[] = [];
        let ancestor = treegrid.parentElement;
        while (ancestor && previewElement.contains(ancestor)) {
          const style = getComputedStyle(ancestor);
          if (
            style.overflowX === 'auto' ||
            style.overflowX === 'scroll' ||
            style.overflowY === 'auto' ||
            style.overflowY === 'scroll'
          ) {
            scrollOwners.push(ancestor);
          }
          ancestor = ancestor.parentElement;
        }

        const owner = scrollOwners[0];
        const header = treegrid.querySelector<HTMLElement>('thead');
        const firstHeader = treegrid.querySelector<HTMLElement>('th');
        const firstBodyCell = treegrid.querySelector<HTMLElement>('tbody td');
        const firstBodyRow = treegrid.querySelector<HTMLElement>('tbody tr');
        if (!(owner && header && firstHeader && firstBodyCell && firstBodyRow)) {
          throw new Error('Expected a complete scrollable table surface');
        }

        const previewRect = previewElement.getBoundingClientRect();
        const ownerRect = owner.getBoundingClientRect();
        const initialHeaderRect = header.getBoundingClientRect();
        const initialHeaderCellRect = firstHeader.getBoundingClientRect();
        const initialBodyCellRect = firstBodyCell.getBoundingClientRect();
        const initialBodyRowRect = firstBodyRow.getBoundingClientRect();
        const targetScrollTop = Math.min(96, owner.scrollHeight - owner.clientHeight);
        const targetScrollLeft = Math.min(80, owner.scrollWidth - owner.clientWidth);

        owner.scrollTo({ left: targetScrollLeft, top: targetScrollTop });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

        const scrolledOwnerRect = owner.getBoundingClientRect();
        const scrolledHeaderRect = header.getBoundingClientRect();
        const scrolledHeaderCellRect = firstHeader.getBoundingClientRect();
        const scrolledBodyCellRect = firstBodyCell.getBoundingClientRect();
        const scrolledBodyRowRect = firstBodyRow.getBoundingClientRect();

        return {
          bodyCellDeltaX: scrolledBodyCellRect.left - initialBodyCellRect.left,
          bodyRowDeltaY: scrolledBodyRowRect.top - initialBodyRowRect.top,
          headerCellDeltaX: scrolledHeaderCellRect.left - initialHeaderCellRect.left,
          headerTopAfterScroll: scrolledHeaderRect.top,
          headerTopBeforeScroll: initialHeaderRect.top,
          horizontalOverflow: owner.scrollWidth - owner.clientWidth,
          ownerBottom: ownerRect.bottom,
          ownerTopAfterScroll: scrolledOwnerRect.top,
          previewBottom: previewRect.bottom,
          scrollLeft: owner.scrollLeft,
          scrollOwnerCount: scrollOwners.length,
          scrollTop: owner.scrollTop,
          verticalOverflow: owner.scrollHeight - owner.clientHeight,
        };
      });

      expect(geometry.scrollOwnerCount).toBe(1);
      expect(geometry.horizontalOverflow).toBeGreaterThan(0);
      expect(geometry.verticalOverflow).toBeGreaterThan(0);
      expect(Math.abs(geometry.ownerBottom - geometry.previewBottom)).toBeLessThanOrEqual(1);
      expect(geometry.scrollTop).toBeGreaterThan(0);
      expect(geometry.bodyRowDeltaY).toBeLessThan(-1);
      expect(
        Math.abs(geometry.headerTopAfterScroll - geometry.ownerTopAfterScroll)
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.headerTopAfterScroll - geometry.headerTopBeforeScroll)
      ).toBeLessThanOrEqual(1);
      expect(geometry.scrollLeft).toBeGreaterThan(0);
      expect(geometry.headerCellDeltaX).toBeLessThan(-1);
      expect(Math.abs(geometry.headerCellDeltaX - geometry.bodyCellDeltaX)).toBeLessThanOrEqual(1);

      await contextTree.locator('tbody').getByRole('checkbox').first().click();
      const clearContextSelection = page.getByRole('button', { name: 'Clear context selection' });
      await expect(clearContextSelection).toBeVisible();

      const bulkActionGeometry = await clearContextSelection.evaluate(async (button) => {
        const bar = button.parentElement;
        const preview = document.querySelector<HTMLElement>('[data-testid="preview-table"]');
        const treegrid = preview?.querySelector<HTMLElement>('[role="treegrid"]');
        const owner = treegrid?.parentElement;
        const lastRow = treegrid?.querySelector<HTMLElement>('tbody tr:last-child');
        if (!(bar && preview && owner && lastRow)) {
          throw new Error('Expected complete context bulk-action geometry');
        }

        owner.scrollTop = owner.scrollHeight;
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });

        return {
          barTop: bar.getBoundingClientRect().top,
          lastRowBottom: lastRow.getBoundingClientRect().bottom,
          layoutHasPadding: preview.classList.contains('pb-20'),
          ownerBottom: owner.getBoundingClientRect().bottom,
          ownerHasPadding: owner.classList.contains('pb-20'),
          ownerPaddingBottom: getComputedStyle(owner).paddingBottom,
          previewBottom: preview.getBoundingClientRect().bottom,
        };
      });

      expect(bulkActionGeometry.layoutHasPadding).toBe(false);
      expect(bulkActionGeometry.ownerHasPadding).toBe(true);
      expect(bulkActionGeometry.ownerPaddingBottom).toBe('80px');
      expect(
        Math.abs(bulkActionGeometry.ownerBottom - bulkActionGeometry.previewBottom)
      ).toBeLessThanOrEqual(1);
      expect(bulkActionGeometry.lastRowBottom).toBeLessThanOrEqual(bulkActionGeometry.barTop + 1);
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

    test('uses the table toolbar and a compact spatial dock for tapestry', {
      tag: '@web-smoke',
    }, async ({ page }) => {
      await explorer.selectRoot();

      await explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' }).click({
        force: true,
      });
      await explorer.fileTree.getByRole('checkbox', { name: 'Select test2.ts' }).click({
        force: true,
      });

      const previewToolbar = page.getByTestId('preview-view-toolbar');
      await expect(previewToolbar).toBeVisible();
      await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();
      await expect(
        previewToolbar.getByRole('button', { name: 'Toggle multi-select' })
      ).toBeVisible();
      await expect(previewToolbar.getByRole('button', { name: 'Group by' })).toBeVisible();
      await expect(
        previewToolbar.getByRole('button', { name: 'Select visible columns' })
      ).toBeVisible();

      await page.getByRole('tab', { name: 'Tapestry View' }).click();
      await expect(previewToolbar).toHaveCount(0);

      const tapestryDock = page.getByTestId('tapestry-command-dock');
      await expect(tapestryDock).toBeVisible();
      await expect(tapestryDock.getByRole('slider', { name: 'Gallery scale' })).toBeVisible();
      await expect(tapestryDock.getByRole('button', { name: 'Toggle code lens' })).toBeVisible();
      await tapestryDock.getByRole('button', { name: 'View options' }).click();
      await expect(
        page.getByRole('menuitemcheckbox', { name: 'File selection controls' })
      ).toBeVisible();
      await expect(page.getByRole('menuitemradio', { name: 'By Directory' })).toBeVisible();
      await expect(page.getByLabel('Select all files on current page')).toHaveCount(0);
    });

    test('reflects a grouped per-group select-all on the group heading checkbox', async ({
      page,
    }) => {
      await explorer.selectRoot();

      // Two root-level files in context so the grouped preview has a group with
      // multiple selectable items.
      await explorer.fileTree
        .getByRole('checkbox', { name: 'Select test.ts' })
        .click({ force: true });
      await explorer.fileTree
        .getByRole('checkbox', { name: 'Select test2.ts' })
        .click({ force: true });

      const previewToolbar = page.getByTestId('preview-view-toolbar');
      await expect(previewToolbar).toBeVisible();

      // Ensure the checkbox column is ON, then group by directory. Selection
      // controls are enabled by default (resolveColumnVisibility pins
      // checkbox: true), so a blind toggle click would turn them OFF and the
      // group heading checkbox this test exists to cover would never render.
      const multiSelectToggle = previewToolbar.getByRole('button', {
        name: 'Toggle multi-select',
      });
      if ((await multiSelectToggle.getAttribute('aria-pressed')) !== 'true') {
        await multiSelectToggle.click();
      }
      await expect(multiSelectToggle).toHaveAttribute('aria-pressed', 'true');
      await previewToolbar.getByRole('button', { name: 'Group by' }).click();
      await page.getByRole('menuitemradio', { name: 'By Directory' }).click();

      // Regression (multi-root): clicking a group's heading checkbox selected the
      // files but the heading checkbox stayed unchecked because the memoized
      // TreeTable rows never re-rendered. It must now reflect checked.
      // Trailing space targets the per-group heading ("…in group <id>/…"), not
      // the header "Select all files in grouped results".
      const groupHeadingCheckbox = page
        .getByRole('checkbox', { name: /^Select all files in group / })
        .first();
      await expect(groupHeadingCheckbox).not.toBeChecked();

      await groupHeadingCheckbox.click();

      await expect(groupHeadingCheckbox).toBeChecked();
    });

    test('renders the summary mode controls above the tabs without footer resize chrome', async ({
      page,
    }) => {
      await explorer.selectRoot();

      await explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' }).click({
        force: true,
      });

      const compactModeButton = page.getByRole('button', { name: 'Compact summary mode' });
      const tableTab = page.getByRole('tab', { name: 'Table View' });

      await expect(compactModeButton).toBeVisible();
      await expect(tableTab).toBeVisible();
      await expect(page.getByRole('button', { name: 'Balanced summary mode' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Insights summary mode' })).toBeVisible();
      await expect(
        page.getByRole('separator', { name: /resize context explorer footer/i })
      ).toHaveCount(0);
      await expect(page.getByRole('button', { name: /collapse footer/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /expand footer/i })).toHaveCount(0);

      const compactBox = await compactModeButton.boundingBox();
      const tableTabBox = await tableTab.boundingBox();
      expect(compactBox).not.toBeNull();
      expect(tableTabBox).not.toBeNull();
      expect((compactBox?.y ?? Number.POSITIVE_INFINITY) + (compactBox?.height ?? 0)).toBeLessThan(
        tableTabBox?.y ?? Number.NEGATIVE_INFINITY
      );
    });

    test('hides grouped selection checkboxes when selection controls are toggled off', async ({
      page,
    }) => {
      await explorer.selectRoot();

      await explorer.fileTree.getByRole('checkbox', { name: 'Select test.ts' }).click({
        force: true,
      });
      await explorer.fileTree.getByRole('checkbox', { name: 'Select test2.ts' }).click({
        force: true,
      });

      const previewToolbar = page.getByTestId('preview-view-toolbar');
      await expect(previewToolbar).toBeVisible();
      await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();
      await previewToolbar.getByRole('button', { name: 'Group by' }).click();
      await page.getByRole('menuitemradio', { name: 'By Directory' }).click();

      const groupedSelectionCheckboxes = page.getByRole('checkbox', {
        name: /^Select all files in group /i,
      });
      await expect(groupedSelectionCheckboxes).toHaveCount(0);
      await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();
      await expect(groupedSelectionCheckboxes).toHaveCount(1);

      await previewToolbar.getByRole('button', { name: 'Toggle multi-select' }).click();

      await expect(groupedSelectionCheckboxes).toHaveCount(0);
      await expect(page.getByLabel('Select all files on current page')).toHaveCount(0);
    });

    test('renders non-folder group headers in the folder column for size grouping', async ({
      page,
    }) => {
      explorer = await bootstrapFileExplorer(page, {
        resetSettings: true,
        tree: {
          'medium.ts': `export const medium = "${'x'.repeat(1400)}";`,
          'tiny.json': '{}',
        },
      });

      await explorer.selectRoot();
      await explorer.selectAllButton.click();

      // Two anchors guard the multi-step interaction below from racing with async work:
      //
      //   1. Selection actually applied. Persistence/restore on the first render after
      //      `resetSettings: true` can race with the Select All click and leave the
      //      selection count at 0. If this assertion times out, the failure is
      //      "Select All didn't take effect" — not a flake, a real bug.
      //
      //   2. Row sizes resolved. `data-rows-ready` flips to "true" only when every
      //      visible row has a defined `size` (FileSystem-adapter cache populated). If
      //      this assertion times out after #1 passed, the failure is "size metadata
      //      didn't resolve" — also a real bug. If both pass, downstream Group-by
      //      assertions can run on a deterministic state.
      await expect(page.getByTestId('selection-count')).toHaveText('2', { timeout: 15_000 });

      const previewTable = page.getByTestId('preview-table');
      await expect(previewTable).toHaveAttribute('data-rows-ready', 'true', { timeout: 15_000 });

      const previewToolbar = page.getByTestId('preview-view-toolbar');
      await expect(previewToolbar).toBeVisible();
      await previewToolbar.getByRole('button', { name: 'Group by' }).click();
      await page.getByRole('menuitemradio', { name: 'By Size Range' }).click();

      const contextTree = page.getByRole('treegrid', { name: 'Context explorer table' });
      const groupRow = contextTree
        .getByRole('row')
        .filter({ has: page.getByRole('button', { name: 'Collapse' }) })
        .first();
      await expect(groupRow).toBeVisible();

      const folderHeader = page.getByRole('button', { name: 'Sort by Folder' });
      const pathHeader = page.getByRole('button', { name: 'Sort by File Path' });
      const spanningFolderCell = groupRow.locator('[role="gridcell"][colspan="2"]').first();
      await expect(spanningFolderCell).toContainText('Small');

      const [folderBox, pathBox, spanningCellBox] = await Promise.all([
        folderHeader.boundingBox(),
        pathHeader.boundingBox(),
        spanningFolderCell.boundingBox(),
      ]);

      if (!(folderBox && pathBox && spanningCellBox)) {
        throw new Error('Expected grouped size row geometry to be measurable');
      }

      expect(spanningCellBox.x).toBeLessThan(pathBox.x);
      expect(spanningCellBox.x).toBeLessThan(folderBox.x + folderBox.width);
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

      await expect(explorer.downloadContextButton).toBeEnabled();

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        explorer.downloadContextButton.click(),
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
      const resizeHandle = getContextExplorerRightResizeHandle(page);
      const handleBox = await resizeHandle.boundingBox();
      const rightPanel = page.locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR);
      const panelGroupRight = await rightPanel.evaluate((element) => {
        const group = element.closest('[data-group]');
        if (!group) {
          throw new Error('Explorer panel group is missing');
        }
        return group.getBoundingClientRect().right;
      });
      if (!handleBox) {
        throw new Error('Explorer resize geometry is unavailable');
      }
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(panelGroupRight - 180, handleBox.y + handleBox.height / 2, {
        steps: 20,
      });
      await page.mouse.up();

      await expect(rightPanel).toBeVisible();

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
      const viewFiltersToggle = page.getByRole('button', { name: /view filters/i });
      await expect(viewFiltersToggle).toBeVisible({ timeout: 10_000 });

      if ((await viewFiltersToggle.getAttribute('aria-expanded')) !== 'true') {
        await viewFiltersToggle.click();
      }

      await expect(viewFiltersToggle).toHaveAttribute('aria-expanded', 'true');
    }

    async function getPresetTrigger(page: Page) {
      const presetTrigger = page
        .locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR)
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
        await expect(page.getByText('No files selected')).toBeVisible({ timeout: 15_000 });

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
          page.locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR).getByRole('button', {
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

    test('keeps root Select All and single-click expansion aligned with the TypeScript/JavaScript preset', async ({
      page,
    }) => {
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
        page.locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR).getByRole('button', {
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

          // Value should still be default (10)
          let maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('10');

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

          // Value should still be 10
          maxCount = await getMaxSelectionCount(page);
          expect(maxCount).toBe('10');
        },
        name: 'validates Max Selection Count values',
        tree: { 'a.ts': null, 'b.ts': null },
      },
      // Note: Include/Exclude filters and Use Regex toggle were moved to ViewFilterPresetDropdown
      // Persistence of filter presets is tested in view-filter-preset tests
      {
        execute: async ({ page, explorer }) => {
          await expect(explorer.includeProjectTreeToggle).toBeVisible();
          await explorer.includeProjectTreeToggle.click();
          await expect(explorer.includeProjectTreeToggle).toHaveAttribute('aria-checked', 'false');

          await reloadExplorer(page);

          await expect(explorer.includeProjectTreeToggle).toBeVisible();
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

          await expect(page.getByText('1/1')).toBeVisible();
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

      // Wait on a real signal from the indexer rather than a wall-clock sleep:
      // the TokenSummaryBar renders "<n>+ estimating…" only while
      // selectedTokensPendingCount > 0, and switches to "<n> selected" once
      // every selected file has been resolved by the background worker.
      try {
        await expect(page.getByText(/estimating…/)).toHaveCount(0, { timeout: 30_000 });
      } catch (err) {
        // Re-emit captured browser logs so failures surface their root cause.
        console.log('--- captured browser logs ---');
        for (const line of browserLogs.slice(-150)) {
          console.log(line);
        }
        throw err;
      }

      // Expect the converged total to match the fixture's heuristic math.
      // We assert against the "<n> source" badge specifically because
      // `sourceSelectedTokens` is the always-rendered, mode-independent total
      // (it represents tokens across complete selected files BEFORE any
      // tapestry-range filtering, which is what we want to validate here).
      // The "<n> output" badge is locked to the single per-file Output
      // presentation (there is no useTapestryRanges toggle anymore) and, with
      // no ranges applied in this fixture, would read identically to source —
      // asserting on source keeps this test independent of that presentation
      // detail. Without the indexer fix, this value would stall at 0 because
      // no handle is ever resolved for files inside the unexpanded `src/` and
      // `src/inner/` subfolders.
      await expect(page.getByText(`${expectedTokens.toLocaleString()} source`)).toBeVisible({
        timeout: 30_000,
      });
    });
  });
});
