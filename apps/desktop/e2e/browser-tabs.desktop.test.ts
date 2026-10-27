/**
 * Desktop E2E for browser pages as workspace tabs (BST-1271): each page opens
 * in a tab of its own among its conversation's tabs, against the REAL
 * main-process BrowserViewManager, and only the selected page is drawn.
 *
 * A `WebContentsView` paints above all renderer DOM, so a menu dropping over
 * the page is only visible if the renderer hides the view. The DOM cannot
 * observe that, so the test reads the views' drawn state in MAIN
 * (`View.getVisible()`), filtered to the pane's dedicated session partition.
 *
 * Pages are `data:` URLs with a <title>, so no network is involved. A fresh
 * profile opens on the new-thread screen, so each test starts a conversation
 * with a scripted reply first.
 *
 * BST-1843: closing the window with a page open must tear the pane down
 * without a main-process error — `dispose()` runs from the window's `closed`
 * event, when the BrowserWindow is already destroyed.
 */
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import {
  openBrowserPage,
  startConversation,
  titledPage,
  visibleAddress,
  workspaceTabs,
} from './utils/browser-page-helpers';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { loadElectronHelpers } from './utils/load-electron-helpers';

/** `BROWSER_PANE_PARTITION` in `src/browser/browser-session.ts`. */
const PANE_PARTITION = 'persist:browser-pane';

interface PaneViewState {
  readonly url: string;
  readonly visible: boolean;
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

/** Pane-session `webContents` still alive in main (a closed tab's page is gone). */
function countPaneWebContents(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ session, webContents }, partition) => {
    const paneSession = session.fromPartition(partition);
    return webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed() && contents.session === paneSession).length;
  }, PANE_PARTITION);
}

/**
 * Retire the window that hosts the browser pane (not the app) and wait until
 * it is destroyed. Returns after main has run the window's `closed` handlers.
 *
 * The pane host is the app's only visible window, and closing the last visible
 * window quits the app on every platform but macOS (`document-unload.ts`).
 * Destroying it skips that user-close path on all platforms, so the test
 * observes the window's own teardown, not app shutdown (which the harness's
 * exit guard would also flag as an unexpected exit).
 */
async function closePaneHostWindow(app: ElectronApplication): Promise<void> {
  const windowId = await app.evaluate(({ BrowserWindow, session, WebContentsView }, partition) => {
    const paneSession = session.fromPartition(partition);
    const host = BrowserWindow.getAllWindows().find((window) =>
      window.contentView.children.some(
        (view) => view instanceof WebContentsView && view.webContents.session === paneSession
      )
    );
    if (!host) {
      throw new Error('No window hosts a browser pane view');
    }
    host.destroy();
    return host.id;
  }, PANE_PARTITION);
  await expect
    .poll(
      () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id) === null, windowId),
      { timeout: 15_000 }
    )
    .toBe(true);
}

/**
 * Wait until everything main wrote to STDERR before this call has reached the
 * test: main emits a sentinel on stderr and we poll for it. A pipe is ordered,
 * so an uncaught exception (main's handler `console.error`s it) cannot arrive
 * after the sentinel — the absence check below is not a race against a flush.
 */
async function flushMainStdio(app: ElectronApplication): Promise<void> {
  const sentinel = `[e2e-flush ${crypto.randomUUID()}]`;
  await app.evaluate((_electron, marker) => {
    process.stderr.write(`${marker}\n`);
  }, sentinel);
  const { getBufferedElectronOutput } = await loadElectronHelpers();
  await expect
    .poll(async () => (await getBufferedElectronOutput(app)).stderr.join('\n'), { timeout: 10_000 })
    .toContain(sentinel);
}

/** The urls of the pane views main draws. */
async function expectDrawnPages(app: ElectronApplication, urls: readonly string[]): Promise<void> {
  await expect
    .poll(
      async () => (await readPaneViews(app)).filter((view) => view.visible).map((view) => view.url),
      { timeout: 10_000 }
    )
    .toEqual(urls);
}

test.describe('Browser tabs (desktop)', () => {
  test("opens pages as the conversation's workspace tabs and draws only the selected one", async ({
    electronApp,
    modelProvider,
    window: page,
  }) => {
    test.setTimeout(180_000);
    const app = electronApp.app;
    await ensureAssistantShellVisible(page);
    await configureAssistantProvider(page);
    await startConversation(page, modelProvider, 'First conversation');
    const tabs = workspaceTabs(page);

    const alpha = await openBrowserPage(page, titledPage('Alpha'), 'Alpha');
    const beta = await openBrowserPage(page, titledPage('Beta'), 'Beta');
    await expect.poll(async () => (await readPaneViews(app)).length).toBe(2);
    await expectDrawnPages(app, [titledPage('Beta')]);

    // Selecting a tab shows its page; any other workspace tab hides them all.
    await alpha.click();
    await expect(visibleAddress(page)).toHaveValue(titledPage('Alpha'));
    await expectDrawnPages(app, [titledPage('Alpha')]);
    await tabs.getByRole('tab', { name: 'Files' }).click();
    await expectDrawnPages(app, []);

    // Closing a page's tab closes the page in main.
    await alpha.click();
    await page.keyboard.press('Delete');
    await expect(alpha).toHaveCount(0);
    await expect.poll(() => countPaneWebContents(app)).toBe(1);

    // A strip menu drops over the page: the view hides while it is open.
    await beta.click();
    await expectDrawnPages(app, [titledPage('Beta')]);
    await beta.click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await expectDrawnPages(app, []);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expectDrawnPages(app, [titledPage('Beta')]);
    // So does the "+" menu.
    await page.getByTestId('workspace-add-tab').click();
    await expect(page.getByTestId('workspace-add-tab-new-browser-tab')).toBeVisible();
    await expectDrawnPages(app, []);
    await page.keyboard.press('Escape');
    await expectDrawnPages(app, [titledPage('Beta')]);

    // Another conversation has its own tabs; the page waits for its return.
    const threads = page.getByRole('tablist', { name: 'Open assistant threads' });
    const first = threads.getByRole('tab', { selected: true });
    const firstId = await first.getAttribute('id');
    await startConversation(page, modelProvider, 'Second conversation');
    await expect(threads.getByRole('tab')).toHaveCount(2);
    await expect(tabs.getByRole('tab', { name: 'Beta' })).toHaveCount(0);
    await expectDrawnPages(app, []);
    expect(await countPaneWebContents(app)).toBe(1);

    await threads.locator(`[id="${firstId}"]`).click();
    await expect(tabs.getByRole('tab', { name: 'Beta' })).toBeVisible({ timeout: 15_000 });
    await tabs.getByRole('tab', { name: 'Beta' }).click();
    await expectDrawnPages(app, [titledPage('Beta')]);
  });

  test('closing the window with a page open releases the pane without a main-process error (BST-1843)', async ({
    electronApp,
    modelProvider,
    window: page,
  }) => {
    test.setTimeout(120_000);
    const app = electronApp.app;
    await ensureAssistantShellVisible(page);
    await configureAssistantProvider(page);
    await startConversation(page, modelProvider, 'A conversation with a page');
    await openBrowserPage(page, titledPage('Alpha'), 'Alpha');
    await expect.poll(() => countPaneWebContents(app)).toBe(1);

    await closePaneHostWindow(app);
    await flushMainStdio(app);

    const { getBufferedElectronOutput } = await loadElectronHelpers();
    const output = await getBufferedElectronOutput(app);
    const destroyedErrors = [...output.stderr, ...output.stdout].filter((line) =>
      line.includes('Object has been destroyed')
    );
    expect(destroyedErrors).toEqual([]);
    // Electron does not destroy a WebContentsView's page with its window: the
    // close path must release it itself.
    await expect.poll(() => countPaneWebContents(app)).toBe(0);
  });
});
