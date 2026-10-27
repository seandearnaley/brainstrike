/**
 * Desktop E2E: a web link in a reply asks where to open it. "Open in
 * Brainstrike browser" opens it as a page among the conversation's workspace
 * tabs, "Open in default browser" hands it to the OS browser, and "Copy link"
 * puts it on the clipboard. While the menu is open, the page beside it hides.
 *
 * The OS browser is a stand-in in main that records the URL it is given, and
 * the link's host never resolves, so no network is involved.
 */
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { configureAssistantProvider } from './utils/assistant-mock';
import { visibleAddress, workspaceTabs } from './utils/browser-page-helpers';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startThread } from './utils/new-thread';

const LINK = 'https://docs.bst-link-choices.invalid/guide';

/** Stand in for the OS browser in main: record each URL instead of opening it. */
async function recordExternalOpens(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    Object.assign(globalThis, { __linkChoicesOpened: opened });
    shell.openExternal = (url: string): Promise<void> => {
      opened.push(url);
      return Promise.resolve();
    };
  });
}

function externalOpens(app: ElectronApplication): Promise<readonly string[]> {
  return app.evaluate(
    () => (globalThis as { __linkChoicesOpened?: readonly string[] }).__linkChoicesOpened ?? []
  );
}

/** How many browser pages main draws. A page is a native view the DOM cannot see. */
function drawnPages(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow, session, WebContentsView }) => {
    // `BROWSER_PANE_PARTITION` in `src/browser/browser-session.ts`.
    const paneSession = session.fromPartition('persist:browser-pane');
    return BrowserWindow.getAllWindows()
      .flatMap((window) => window.contentView.children)
      .filter(
        (view) =>
          view instanceof WebContentsView &&
          view.webContents.session === paneSession &&
          view.getVisible()
      ).length;
  });
}

test('a web link in a reply opens in the built-in or the default browser, or is copied', async ({
  electronApp,
  modelProvider,
  window: page,
}) => {
  test.setTimeout(120_000);
  const app = electronApp.app;
  await recordExternalOpens(app);
  await configureAssistantProvider(page);
  await ensureAssistantShellVisible(page);
  modelProvider.setScript(() => ({ finalText: `Read [the guide](${LINK}) first.` }));
  const conversation = await startThread(page, 'Where is the guide?');
  const link = conversation.getByRole('link', { exact: true, name: 'the guide' });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const tabs = workspaceTabs(page);
  const tabCount = await tabs.getByRole('tab').count();

  await link.click();
  await page.getByRole('menuitem', { name: 'Open in default browser' }).click();
  await expect.poll(() => externalOpens(app)).toEqual([LINK]);
  await expect(tabs.getByRole('tab')).toHaveCount(tabCount);

  await link.click();
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  await expect(page.getByText('Link copied', { exact: true })).toBeVisible();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(LINK);

  await link.click();
  await page.getByRole('menuitem', { name: 'Open in Brainstrike browser' }).click();
  await expect(tabs.getByRole('tab')).toHaveCount(tabCount + 1, { timeout: 15_000 });
  await expect(visibleAddress(page)).toHaveValue(LINK, { timeout: 15_000 });
  expect(await externalOpens(app)).toEqual([LINK]);

  // The menu can drop over the page beside the reply: the page hides while it is open.
  await expect.poll(() => drawnPages(app)).toBe(1);
  await link.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect.poll(() => drawnPages(app)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect.poll(() => drawnPages(app)).toBe(1);
});
