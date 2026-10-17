import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { HomePage } from './page-objects/home-page';
import { SettingsPage } from './page-objects/settings-page';

/**
 * BST-1791: the log viewer was clipped to ~102px inside Settings, behind two
 * nested scrollers. It is now the Logs workspace tab: the list fills the pane
 * and is the only scroller between its rows and the page.
 */

const SEEDED_RECORDS = 120;
const LONG_PAYLOAD_MESSAGE = 'Logs tab long payload';

async function setVisibleWindowSize(
  app: ElectronApplication,
  page: Page,
  size: { readonly height: number; readonly width: number }
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, { next, url }) => {
      const shown = BrowserWindow.getAllWindows().find(
        (window) => window.webContents.getURL() === url
      );
      if (!shown) {
        throw new Error(`No window shows ${url}.`);
      }
      shown.setContentSize(next.width, next.height);
    },
    { next: size, url: page.url() }
  );
  await page.waitForFunction(
    (next) => window.innerWidth === next.width && window.innerHeight === next.height,
    size
  );
}

/** Rendered geometry of the log list and every scrollable ancestor above it. */
async function measureLogList(page: Page) {
  return await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="log-list-scroll-container"]');
    if (!list) {
      throw new Error('The log list is not rendered.');
    }
    const listRect = list.getBoundingClientRect();
    const rows = Array.from(list.querySelectorAll<HTMLElement>('tbody tr[data-index]'));
    const visibleRows = rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.height > 0 && rect.top >= listRect.top && rect.bottom <= listRect.bottom;
    });
    const scrollingAncestors: string[] = [];
    for (let node = list.parentElement; node; node = node.parentElement) {
      const { overflowY } = getComputedStyle(node);
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight + 1
      ) {
        scrollingAncestors.push(
          `${node.tagName.toLowerCase()}[data-testid=${node.dataset['testid'] ?? ''}]`
        );
      }
    }
    return {
      listBottom: listRect.bottom,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      scrollingAncestors,
      viewportHeight: window.innerHeight,
      visibleRows: visibleRows.length,
    };
  });
}

test.describe('Logs workspace tab (BST-1791)', () => {
  test('Settings opens the log viewer as a workspace tab whose list is the only scroller', async ({
    electronApp,
    window: page,
  }) => {
    await setVisibleWindowSize(electronApp.app, page, { height: 800, width: 1280 });
    await page.evaluate(
      ({ count, longMessage }) => {
        const buffer = (
          window as Window & {
            __brainstrikeRendererLogBuffer?: { push(record: unknown): void };
          }
        ).__brainstrikeRendererLogBuffer;
        if (!buffer) {
          throw new Error('The renderer log buffer is unavailable.');
        }
        for (let index = 0; index < count; index += 1) {
          buffer.push({
            args: [],
            bindings: { runtime: 'electron-renderer' },
            level: 'warn',
            message: `Logs tab seed ${index}`,
            scope: 'LogsTabE2E',
            timestamp: Date.now() + index,
          });
        }
        // Wrapped payloads clamp to two lines rather than stretching the row.
        buffer.push({
          args: ['payload '.repeat(60)],
          bindings: { runtime: 'electron-renderer' },
          level: 'warn',
          message: longMessage,
          scope: 'LogsTabE2E',
          timestamp: Date.now() + count,
        });
      },
      { count: SEEDED_RECORDS, longMessage: LONG_PAYLOAD_MESSAGE }
    );

    await new HomePage(page).openSettings();
    const logging = await new SettingsPage(page).openCategory(/Logging & Diagnostics/i, 'logging');
    await expect(logging.getByRole('region', { name: 'Log Viewer' })).toHaveCount(0);
    await logging.getByRole('button', { name: 'Open Logs' }).click();

    const logsTab = page.getByTestId('workspace-app-tab-logs');
    await expect(logsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('settings-route')).toBeHidden();
    const viewer = page.getByRole('region', { name: 'Log Viewer' });
    // Only the seeded records, oldest first and auto-scrolled to the newest.
    await viewer.getByPlaceholder('Search logs...').fill('Logs tab');
    await expect(viewer.getByText(LONG_PAYLOAD_MESSAGE, { exact: true })).toBeVisible();

    // One page of every record, so the list overflows; the filters fold away again.
    const filters = viewer.getByRole('button', { name: /^Filters/ });
    await filters.click();
    await viewer.getByRole('combobox', { name: 'Page size' }).click();
    await page.getByRole('option', { name: '200 rows' }).click();
    await filters.click();
    await expect(viewer.getByRole('combobox', { name: 'Page size' })).toHaveCount(0);

    for (const size of [
      { height: 800, width: 1280 },
      { height: 640, width: 960 },
    ]) {
      await setVisibleWindowSize(electronApp.app, page, size);
      await expect
        .poll(async () => (await measureLogList(page)).visibleRows, {
          message: `rows visible at ${size.width}x${size.height}`,
        })
        .toBeGreaterThan(5);
      const geometry = await measureLogList(page);
      expect(geometry.scrollingAncestors, 'no scroller between the rows and the page').toEqual([]);
      expect(geometry.listBottom).toBeLessThanOrEqual(geometry.viewportHeight);
      expect(geometry.listScrollHeight).toBeGreaterThan(geometry.listClientHeight);

      // Rows re-measure at the new width after a resize, so the bottom can move under a
      // single scroll; scroll again until a check finds it still at the bottom (BST-2040).
      await page
        .getByTestId('log-list-scroll-container')
        .evaluate((list) => list.scrollTo({ top: list.scrollHeight }));
      await expect
        .poll(() =>
          page.getByTestId('log-list-scroll-container').evaluate((list) => {
            if (list.scrollTop + list.clientHeight >= list.scrollHeight - 1) {
              return true;
            }
            list.scrollTo({ top: list.scrollHeight });
            return false;
          })
        )
        .toBe(true);
      const longRow = viewer.getByRole('row').filter({ hasText: LONG_PAYLOAD_MESSAGE });
      await expect(longRow).toBeVisible();
      expect((await longRow.boundingBox())?.height).toBeLessThan(80);
      await page
        .getByTestId('log-list-scroll-container')
        .evaluate((list) => list.scrollTo({ top: 0 }));
    }
  });
});
