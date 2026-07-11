/**
 * E2E for TreeTable column resize on the collection browser surface.
 *
 * Covers the parts that JSDOM unit tests cannot:
 *  - Real layout: `<colgroup>` widths actually flow through to `<th>` and
 *    `<td>` computed widths in a real browser.
 *  - Real pointer events: pointerdown / pointermove / pointerup with capture.
 *  - Persistence: localStorage round-trips through Zustand persist on reload.
 *  - Sanitization: malformed persisted values fall back to defaults.
 */

import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { FileExplorerPage } from './page-objects/file-explorer-page';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, waitForAppLoad } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

const ROOT_NAME = 'tree-table-resize-root';
const FILE_TREE: FileTree = {
  'alpha.ts': 'export const alpha = "tree table resize";',
  'beta.ts': 'export const beta = "tree table resize";',
};

const STORE_KEY = 'collection-browser-column-sizes.v1';

interface ColumnSizesPersistEnvelope {
  state?: { sizes?: Record<string, unknown> };
  version?: number;
}

async function ensureDatabasePanelVisible(page: Page): Promise<void> {
  await ensureRightPanelVisible(page);
  const databaseTab = page.getByRole('tab', { name: /database/i });
  await expect(databaseTab).toBeVisible({ timeout: 15_000 });
  await databaseTab.click();
  await expect(page.getByRole('tabpanel', { name: /database/i })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('database-demo-panel')).toBeVisible({ timeout: 15_000 });
}

async function createCollection(page: Page, name: string): Promise<void> {
  const databasePanel = page.getByTestId('database-demo-panel');
  await databasePanel.getByRole('button', { name: 'New' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Create Search Collection')).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel('Name *').fill(name);
  await dialog.getByRole('button', { name: 'Create Collection' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  const list = databasePanel.getByRole('listbox', { name: 'Search Collection' });
  await expect(list.getByRole('option').filter({ hasText: name }).first()).toBeVisible({
    timeout: 30_000,
  });
}

async function importOneFile(page: Page): Promise<void> {
  const explorer = new FileExplorerPage(page);
  const showExplorer = page
    .locator('button[aria-label="Show explorer panel"]')
    .or(page.getByRole('button', { name: 'Show explorer panel' }))
    .first();
  if (await showExplorer.isVisible().catch(() => false)) {
    await showExplorer.click();
  }
  await explorer.selectRootButton.click();
  await expect(explorer.fileTree).toBeVisible({ timeout: 30_000 });
  await expect(explorer.selectAllButton).toBeEnabled({ timeout: 15_000 });
  await explorer.selectAllButton.click();
  const databasePanel = page.getByTestId('database-demo-panel');
  const importButton = databasePanel.getByRole('button', { name: /^Import \(\d+\)$/ });
  await expect(importButton).toBeVisible({ timeout: 15_000 });
  await importButton.click();
  // Wait for the collection summary to report at least one imported file.
  await expect(databasePanel.getByRole('listbox', { name: 'Search Collection' })).toContainText(
    /[1-9]\d*\s+files?/,
    { timeout: 120_000 }
  );
  await expect(importButton).toBeEnabled({ timeout: 120_000 });
}

function nameResizeHandle(page: Page): Locator {
  return page.getByRole('separator', { name: /resize name column/i }).first();
}

async function widthOf(locator: Locator): Promise<number> {
  return await locator.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
}

async function readPersistedSizes(page: Page): Promise<ColumnSizesPersistEnvelope | null> {
  return await page.evaluate((key: string) => {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ColumnSizesPersistEnvelope) : null;
  }, STORE_KEY);
}

async function setPersistedSizesRaw(page: Page, raw: string): Promise<void> {
  await page.evaluate(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [STORE_KEY, raw]
  );
}

// `@stateful` is required because the setup creates a collection and imports
// files into the local PGlite store; the test relies on `waitForAppLoad` to
// gate on database readiness before interacting with the tree.
// `@web-collection-browser` keeps this in the collection-browser CI lane.
test.describe('TreeTable column resize @stateful @web-collection-browser', () => {
  test.describe.configure({ mode: 'serial' });

  test('pointer drag, persistence, and malformed-value sanitization @stateful', async ({
    page,
  }) => {
    test.setTimeout(240_000);

    await mockBrowserApis(page, ROOT_NAME, FILE_TREE);
    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);

    await ensureDatabasePanelVisible(page);
    await createCollection(page, `Tree Table Resize ${Date.now()}`);
    await importOneFile(page);

    // The source pager belongs to the same resizable panel as the tree. Opening
    // and resizing the inspector must resize the pager instead of leaving it
    // fixed to the full CollectionBrowserView width.
    const databasePanel = page.getByTestId('database-demo-panel');
    const treeRegion = databasePanel.getByTestId('collection-tree-region');
    const treegrid = treeRegion.getByRole('treegrid', { name: 'Collection browser' });
    const firstVisibleDataRow = treegrid.getByRole('row', { name: /beta\.ts/ });
    await expect(firstVisibleDataRow).toBeVisible({ timeout: 30_000 });
    const paginationBar = databasePanel.getByTestId('table-pagination');
    await expect(paginationBar).toBeVisible();
    const fullPagerWidth = await widthOf(paginationBar);

    // The mocked live-query harness keeps its refresh overlay active after the
    // imported rows are ready. Dispatch only the context-menu setup event so
    // this layout test can use the real Inspect action and panel drag below.
    await firstVisibleDataRow.dispatchEvent('contextmenu', {
      bubbles: true,
      button: 2,
      cancelable: true,
    });
    const contextMenu = page.getByRole('menu');
    await expect(contextMenu).toBeVisible();
    await contextMenu.getByRole('menuitem', { exact: true, name: 'Inspect' }).click();

    const collapseInspector = databasePanel.getByRole('button', { name: 'Collapse inspector' });
    await expect(collapseInspector).toBeVisible({ timeout: 15_000 });

    const browserPanel = treegrid.locator('xpath=ancestor::*[@data-panel][1]');
    await expect(browserPanel.getByTestId('table-pagination')).toBeVisible();
    await expect
      .poll(async () => await widthOf(paginationBar), { timeout: 5000 })
      .toBeLessThan(fullPagerWidth - 20);

    const readPagerGeometry = async () =>
      await browserPanel.evaluate((panel) => {
        const pager = panel.querySelector('[data-testid="table-pagination"]');
        if (!pager) {
          throw new Error('Resizable browser panel is missing its pagination bar');
        }
        const panelRect = panel.getBoundingClientRect();
        const pagerRect = pager.getBoundingClientRect();
        return {
          clientWidth: pager.clientWidth,
          leftDelta: pagerRect.left - panelRect.left,
          rightDelta: panelRect.right - pagerRect.right,
          scrollWidth: pager.scrollWidth,
          width: pagerRect.width,
        };
      });

    const openedGeometry = await readPagerGeometry();
    expect(Math.abs(openedGeometry.leftDelta)).toBeLessThanOrEqual(1);
    expect(Math.abs(openedGeometry.rightDelta)).toBeLessThanOrEqual(1);
    expect(openedGeometry.scrollWidth).toBeLessThanOrEqual(openedGeometry.clientWidth + 1);

    const inspectorPanel = collapseInspector.locator('xpath=ancestor::*[@data-panel][1]');
    const inspectorSeparator = inspectorPanel.locator(
      'xpath=preceding-sibling::*[@data-separator][1]'
    );
    const separatorBox = await inspectorSeparator.boundingBox();
    if (!separatorBox) {
      throw new Error('Inspector resize separator not found');
    }
    const inspectorDragStart = {
      clientX: separatorBox.x + separatorBox.width / 2,
      clientY: separatorBox.y + separatorBox.height / 2,
    };
    await inspectorSeparator.dispatchEvent('pointerdown', {
      bubbles: true,
      button: 0,
      buttons: 1,
      cancelable: true,
      ...inspectorDragStart,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    });
    await page.evaluate(({ clientX, clientY }) => {
      document.body.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          buttons: 1,
          cancelable: true,
          clientX: clientX - 60,
          clientY,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
        })
      );
      document.body.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          button: 0,
          cancelable: true,
          clientX: clientX - 60,
          clientY,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
        })
      );
    }, inspectorDragStart);

    await expect
      .poll(async () => (await readPagerGeometry()).width, { timeout: 5000 })
      .toBeLessThan(openedGeometry.width - 30);
    const resizedGeometry = await readPagerGeometry();
    expect(Math.abs(resizedGeometry.leftDelta)).toBeLessThanOrEqual(1);
    expect(Math.abs(resizedGeometry.rightDelta)).toBeLessThanOrEqual(1);
    expect(resizedGeometry.scrollWidth).toBeLessThanOrEqual(resizedGeometry.clientWidth + 1);

    await collapseInspector.click();
    await expect(collapseInspector).not.toBeVisible();

    // ── Resize handle is rendered with the right ARIA contract ───────────────
    const handle = nameResizeHandle(page);
    await expect(handle).toBeVisible({ timeout: 15_000 });
    await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    await expect(handle).toHaveAttribute('aria-valuemin', /\d+/);
    await expect(handle).toHaveAttribute('aria-valuemax', /\d+/);
    await expect(handle).toHaveAttribute('aria-valuenow', /\d+/);

    // The pinned status icon column has no handle (width=min=max=44).
    await expect(page.getByRole('separator', { name: /resize status column/i })).toHaveCount(0);

    // ── Pointer drag changes the column width ────────────────────────────────
    const nameHeader = page.getByRole('columnheader', { name: /^Name\b/i }).first();
    const headerWidthBefore = await widthOf(nameHeader);
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const box = handleBox as NonNullable<typeof handleBox>;

    // Playwright's `page.mouse.*` API dispatches mouse events but NOT pointer
    // events. The ColumnResizeHandle listens for pointer events (with capture)
    // so we dispatch pointer events explicitly via dispatchEvent. Coordinates
    // are absolute (clientX/clientY) since the listeners read clientX directly.
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await handle.dispatchEvent('pointerdown', {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: startX,
      clientY: startY,
      isPrimary: true,
      pointerId: 1,
      pointerType: 'mouse',
    });
    // pointermove must hit the window listener, which is what the handle
    // installs after pointerdown. Dispatch from document.body so the event
    // bubbles up to window.
    await page.evaluate(
      ({ clientX, clientY }) => {
        const event = new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
        });
        window.dispatchEvent(event);
      },
      { clientX: startX + 60, clientY: startY }
    );
    await page.evaluate(
      ({ clientX, clientY }) => {
        const event = new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          isPrimary: true,
          pointerId: 1,
          pointerType: 'mouse',
        });
        window.dispatchEvent(event);
      },
      { clientX: startX + 60, clientY: startY }
    );

    await expect
      .poll(async () => await widthOf(nameHeader), { timeout: 5000 })
      .toBeGreaterThan(headerWidthBefore + 30);
    const headerWidthAfterDrag = await widthOf(nameHeader);

    // Body cell width follows the header via <colgroup>.
    const firstBodyCell = page.locator('[role="treegrid"] tbody tr').first().locator('td').first();
    if (await firstBodyCell.isVisible().catch(() => false)) {
      const bodyWidth = await widthOf(firstBodyCell);
      expect(bodyWidth).toBeGreaterThanOrEqual(headerWidthAfterDrag - 2);
      expect(bodyWidth).toBeLessThanOrEqual(headerWidthAfterDrag + 2);
    }

    // aria-valuenow on the handle reflects the new width (rounded).
    const valueNowAttr = await handle.getAttribute('aria-valuenow');
    expect(Number(valueNowAttr)).toBeGreaterThanOrEqual(Math.round(headerWidthAfterDrag) - 4);

    // ── Sort is NOT triggered by clicks on the handle ────────────────────────
    // The Name header is sortable — recording state before & after a handle click.
    // Clicking the handle itself should bubble nothing into the header onClick.
    const sortIndicatorBefore = await nameHeader.getAttribute('aria-sort');
    await handle.click({ force: true, position: { x: 1, y: box.height / 2 } });
    const sortIndicatorAfter = await nameHeader.getAttribute('aria-sort');
    expect(sortIndicatorAfter).toBe(sortIndicatorBefore);

    // ── Persistence survives reload ──────────────────────────────────────────
    // Persist may be async (it's behind Zustand+persist), so poll until the
    // store has flushed before reloading.
    const expectedPersistedName = Number(valueNowAttr);
    await expect
      .poll(async () => (await readPersistedSizes(page))?.state?.sizes?.['name'], {
        timeout: 5000,
      })
      .toBeDefined();

    await page.reload();
    await waitForAppLoad(page);
    await ensureDatabasePanelVisible(page);
    const handleAfterReload = nameResizeHandle(page);
    await expect(handleAfterReload).toBeVisible({ timeout: 30_000 });
    const headerAfterReload = page.getByRole('columnheader', { name: /^Name\b/i }).first();
    const restoredWidth = await widthOf(headerAfterReload);
    // Allow ±4px for sub-pixel rounding when restoring across reload.
    expect(restoredWidth).toBeGreaterThanOrEqual(expectedPersistedName - 4);
    expect(restoredWidth).toBeLessThanOrEqual(expectedPersistedName + 4);

    // ── Malformed persisted values fall back to defaults ────────────────────
    // Write a broken envelope (NaN, Infinity, negative, unknown key).
    await setPersistedSizesRaw(
      page,
      JSON.stringify({
        state: {
          sizes: {
            mystery: 9999,
            name: Number.NaN,
            size: 'not-a-number',
            status: -10,
          },
        },
        version: 1,
      })
    );
    await page.reload();
    await waitForAppLoad(page);
    await ensureDatabasePanelVisible(page);
    const handleAfterCorruption = nameResizeHandle(page);
    await expect(handleAfterCorruption).toBeVisible({ timeout: 30_000 });
    const headerAfterCorruption = page.getByRole('columnheader', { name: /^Name\b/i }).first();
    const restoredFromCorruptionWidth = await widthOf(headerAfterCorruption);
    // After sanitization the Name column should fall back to its declared
    // defaultWidth (320 in COLLECTION_BROWSER_COLUMN_BOUNDS). Allow a small
    // tolerance for layout rounding.
    expect(restoredFromCorruptionWidth).toBeGreaterThanOrEqual(316);
    expect(restoredFromCorruptionWidth).toBeLessThanOrEqual(324);

    // ── Keyboard resize advances width in 8px increments ────────────────────
    await handleAfterCorruption.focus();
    const beforeKey = await widthOf(headerAfterCorruption);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => await widthOf(headerAfterCorruption), { timeout: 2000 })
      .toBeGreaterThanOrEqual(beforeKey + 14);
    const afterFine = await widthOf(headerAfterCorruption);

    // Shift+ArrowLeft is the coarse step (-32px).
    await page.keyboard.press('Shift+ArrowLeft');
    await expect
      .poll(async () => await widthOf(headerAfterCorruption), { timeout: 2000 })
      .toBeLessThanOrEqual(afterFine - 28);

    // Home → minWidth (150 for Name column).
    await page.keyboard.press('Home');
    await expect
      .poll(async () => await widthOf(headerAfterCorruption), { timeout: 2000 })
      .toBeLessThanOrEqual(154);

    // End → maxWidth (800 for Name column).
    await page.keyboard.press('End');
    await expect
      .poll(async () => await widthOf(headerAfterCorruption), { timeout: 2000 })
      .toBeGreaterThanOrEqual(796);

    // ── Double-click resets to the column's declared defaultWidth ──────────
    // After End the column is at max (800). Double-click the handle and the
    // Name column should snap back to its defaultWidth of 320 (±4 for layout
    // rounding).
    await handleAfterCorruption.dispatchEvent('dblclick', { bubbles: true, cancelable: true });
    await expect
      .poll(async () => await widthOf(headerAfterCorruption), { timeout: 2000 })
      .toBeLessThanOrEqual(324);
    await expect
      .poll(async () => await widthOf(headerAfterCorruption), { timeout: 2000 })
      .toBeGreaterThanOrEqual(316);
  });
});
