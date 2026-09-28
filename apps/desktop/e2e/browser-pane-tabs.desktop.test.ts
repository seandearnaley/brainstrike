/**
 * Desktop E2E for the browser pane's tab strip (BST-1840): the shared
 * TabStrip's keyboard model against the REAL main-process BrowserViewManager,
 * and native-view occlusion while a strip menu is open.
 *
 * A `WebContentsView` paints above all renderer DOM, so a menu dropping into
 * the pane is only visible if the renderer occludes the view. The DOM cannot
 * observe that, so the test reads the views' drawn state in MAIN
 * (`View.getVisible()`), filtered to the pane's dedicated session partition.
 *
 * Pages are `data:` URLs with a <title>, so no network is involved.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';

/** `BROWSER_PANE_PARTITION` in `src/browser/browser-session.ts`. */
const PANE_PARTITION = 'persist:browser-pane';

interface PaneViewState {
  readonly url: string;
  readonly visible: boolean;
}

function titledPage(title: string): string {
  return `data:text/html,${encodeURIComponent(`<title>${title}</title><p>${title}</p>`)}`;
}

/** Every pane `WebContentsView` in main, with whether it is drawn. */
function readPaneViews(app: ElectronApplication): Promise<readonly PaneViewState[]> {
  return app.evaluate(({ BrowserWindow, session, WebContentsView }, partition) => {
    const paneSession = session.fromPartition(partition);
    return BrowserWindow.getAllWindows().flatMap((window) =>
      window.contentView.children
        .filter(
          (view): view is Electron.WebContentsView =>
            view instanceof WebContentsView && view.webContents.session === paneSession
        )
        .map((view) => ({ url: view.webContents.getURL(), visible: view.getVisible() }))
    );
  }, PANE_PARTITION);
}

async function expectDrawnPaneViews(app: ElectronApplication, drawn: number): Promise<void> {
  await expect
    .poll(async () => (await readPaneViews(app)).filter((view) => view.visible).length, {
      timeout: 10_000,
    })
    .toBe(drawn);
}

async function openBrowserRoute(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { exact: true, name: 'Main navigation' })
    .getByRole('button', { exact: true, name: 'Browser' })
    .click({ timeout: 15_000 });
  await expect(page.getByTestId('browser-pane')).toBeVisible({ timeout: 15_000 });
}

async function openTitledTab(page: Page, title: string): Promise<void> {
  await page.getByTestId('browser-new-tab').click();
  const address = page.getByTestId('browser-url-input');
  await expect(address).toHaveValue('about:blank', { timeout: 15_000 });
  await address.fill(titledPage(title));
  await address.press('Enter');
  await expect(page.getByRole('tab', { name: title })).toHaveAttribute('aria-selected', 'true', {
    timeout: 15_000,
  });
}

test.describe('Browser pane tabs (desktop)', () => {
  test('drives tabs by keyboard and occludes the native view while a strip menu is open', async ({
    electronApp,
    window: page,
  }) => {
    test.setTimeout(120_000);
    const app = electronApp.app;
    await openBrowserRoute(page);
    const strip = page.getByRole('tablist', { name: 'Browser tabs' });

    await openTitledTab(page, 'Alpha');
    await openTitledTab(page, 'Beta');
    await expect(strip.getByRole('tab')).toHaveCount(2);
    await expect.poll(async () => (await readPaneViews(app)).length).toBe(2);
    await expectDrawnPaneViews(app, 1);

    // Manual activation: an arrow moves focus only; Enter selects in main.
    const alpha = strip.getByRole('tab', { name: 'Alpha' });
    const beta = strip.getByRole('tab', { name: 'Beta' });
    await beta.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(alpha).toBeFocused();
    await expect(alpha).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Enter');
    await expect(alpha).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('browser-url-input')).toHaveValue(/Alpha/);

    // Delete closes the focused tab in main and hands focus to its neighbour.
    await page.keyboard.press('Delete');
    await expect(strip.getByRole('tab')).toHaveCount(1);
    await expect(beta).toBeFocused();
    await expect(beta).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await readPaneViews(app)).length).toBe(1);
    await expectDrawnPaneViews(app, 1);

    // The tab menu drops into the pane: the view hides while it is open.
    await beta.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Duplicate' })).toBeVisible();
    await expectDrawnPaneViews(app, 0);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expectDrawnPaneViews(app, 1);
    await expect(beta).toBeFocused();

    // So does the All-tabs menu.
    await page.getByRole('button', { name: 'All tabs' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Beta' })).toBeVisible();
    await expectDrawnPaneViews(app, 0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expectDrawnPaneViews(app, 1);
  });
});
