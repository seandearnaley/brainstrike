/**
 * Desktop E2E for the tab keyboard chords (BST-1842, spec §9), on the assistant
 * thread strip against the real renderer, stores and PGlite threads:
 *
 * - ⌘/Ctrl+W closes the active tab and NOT the window. The application menu
 *   has no `close`/`fileMenu`/`windowMenu` role and no W accelerator, so the
 *   keystroke reaches the renderer; the test asserts that menu shape in main,
 *   because a CDP key press never reaches a native menu accelerator.
 * - ⌘/Ctrl+Shift+T restores the closed tab at its old index and activates it.
 * - Ctrl+Tab / Ctrl+Shift+Tab cycle by position and wrap (D7).
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';

interface MenuItemShape {
  readonly accelerator: string | null;
  readonly role: string | null;
}

/** Every application-menu item, flattened, with its role and accelerator. */
function readApplicationMenu(app: ElectronApplication): Promise<readonly MenuItemShape[]> {
  return app.evaluate(({ Menu }) => {
    const flatten = (items: readonly Electron.MenuItem[]): MenuItemShape[] =>
      items.flatMap((item) => [
        { accelerator: item.accelerator ?? null, role: item.role ?? null },
        ...flatten(item.submenu?.items ?? []),
      ]);
    return flatten(Menu.getApplicationMenu()?.items ?? []);
  });
}

/** Live windows in main, hidden host renderers included (E2E may run unshown). */
function liveWindowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length
  );
}

/** The thread ids of the strip's tabs, in strip order. */
async function tabIds(strip: Locator): Promise<readonly string[]> {
  const ids = await strip
    .getByRole('tab')
    .evaluateAll((tabs) => tabs.map((tab) => tab.id.replace('assistant-thread-tab-', '')));
  return ids;
}

async function selectedTabId(strip: Locator): Promise<string> {
  const id = await strip.locator('[role="tab"][aria-selected="true"]').getAttribute('id');
  return (id ?? '').replace('assistant-thread-tab-', '');
}

async function openThreeThreads(page: Page): Promise<Locator> {
  await setupAssistantMock(page, { variant: 'simple' });
  await ensureAssistantShellVisible(page);
  const strip = page.getByRole('tablist', { name: 'Open assistant threads' });
  await expect(strip).toBeVisible({ timeout: 30_000 });
  const newThread = page.getByTestId('assistant-new-thread-button');
  for (let count = await strip.getByRole('tab').count(); count < 3; count += 1) {
    await expect(newThread).toBeEnabled({ timeout: 15_000 });
    await newThread.click();
    await expect(strip.getByRole('tab')).toHaveCount(count + 1, { timeout: 15_000 });
  }
  return strip;
}

test.describe('Tab keyboard chords (desktop)', () => {
  test('⌘W closes a tab, not the window; ⌘⇧T restores it; Ctrl+Tab cycles by position', async ({
    electronApp,
    window: page,
  }) => {
    test.setTimeout(120_000);
    const app = electronApp.app;

    // No menu role or accelerator owns ⌘/Ctrl+W, so the renderer receives it.
    const menu = await readApplicationMenu(app);
    // Positive control (BST-1852): `Menu.getApplicationMenu()?.items ?? []` is
    // `[]` whenever the native menu is null, which would make every negative
    // assertion below pass vacuously. Prove the menu is REAL first, by finding
    // the Command Palette's ⌘K/Ctrl+K accelerator item (main.ts ~line 1521).
    expect(menu.length).toBeGreaterThan(0);
    expect(
      menu.filter((item) =>
        /^(CmdOrCtrl|CommandOrControl|Cmd|Ctrl)\+K$/i.test(item.accelerator ?? '')
      )
    ).toHaveLength(1);

    // Electron reports roles lowercased ("selectAll" reads "selectall").
    const roles = menu.map((item) => item.role?.toLowerCase() ?? null);
    // One assertion per role: any ONE of them would bind CmdOrCtrl+W.
    for (const role of ['close', 'filemenu', 'windowmenu']) {
      expect(roles, `menu role "${role}"`).not.toContain(role);
    }
    expect(
      menu.filter((item) =>
        /^(CmdOrCtrl|CommandOrControl|Cmd|Ctrl)\+W$/i.test(item.accelerator ?? '')
      )
    ).toEqual([]);

    const strip = await openThreeThreads(page);
    const [first, middle, last] = await tabIds(strip);
    if (!(first && middle && last)) {
      throw new Error('expected three thread tabs');
    }
    const windowsBefore = await liveWindowCount(app);
    expect(windowsBefore).toBeGreaterThan(0);

    // Focus inside the assistant panel scopes the chords to its strip.
    await strip.locator(`#assistant-thread-tab-${middle}`).click();
    await expect(strip.locator(`#assistant-thread-tab-${middle}`)).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await page.keyboard.press('ControlOrMeta+w');
    await expect.poll(() => tabIds(strip)).toEqual([first, last]);
    expect(page.isClosed()).toBe(false);
    expect(await liveWindowCount(app)).toBe(windowsBefore);
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible();

    await page.keyboard.press('ControlOrMeta+Shift+T');
    await expect.poll(() => tabIds(strip)).toEqual([first, middle, last]);
    await expect.poll(() => selectedTabId(strip)).toBe(middle);

    await page.keyboard.press('Control+Tab');
    await expect.poll(() => selectedTabId(strip)).toBe(last);
    await page.keyboard.press('Control+Tab');
    await expect.poll(() => selectedTabId(strip)).toBe(first);
    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(() => selectedTabId(strip)).toBe(last);

    // From the composer: each switch hides the panel that held focus, and focus
    // stays in the strip, so repeated chords keep cycling threads.
    await page
      .getByTestId('assistant-thread-tabs-workspace')
      .locator('[role="tabpanel"]:not([hidden])')
      .getByRole('textbox', { name: 'Message input' })
      .click();
    await page.keyboard.press('Control+PageDown');
    await expect.poll(() => selectedTabId(strip)).toBe(first);
    await page.keyboard.press('Control+PageDown');
    await expect.poll(() => selectedTabId(strip)).toBe(middle);

    // The workspace strip scopes by fallback (no panel), but a ⌘W on one of
    // its tabs still returns focus to its new selected tab, not to body.
    const workspace = page.getByRole('tablist', { name: 'Workspace tabs' });
    for (const appId of ['changes', 'canvas']) {
      await page.getByTestId('workspace-add-tab').click();
      await page.getByTestId(`workspace-add-tab-${appId}`).click();
    }
    const canvasTab = workspace.getByTestId('workspace-app-tab-canvas');
    await canvasTab.click();
    await expect(canvasTab).toHaveAttribute('aria-selected', 'true');
    await canvasTab.focus();
    await page.keyboard.press('ControlOrMeta+w');
    await expect(canvasTab).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement;
          return active?.getAttribute('role') === 'tab' &&
            active.getAttribute('aria-selected') === 'true' &&
            active.closest('[role="tablist"]')?.getAttribute('aria-label') === 'Workspace tabs'
            ? active.textContent
            : `not a selected workspace tab: ${active?.tagName}`;
        })
      )
      .toBe('Changes');
  });
});
