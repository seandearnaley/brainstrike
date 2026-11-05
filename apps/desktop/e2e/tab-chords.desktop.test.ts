/**
 * Desktop E2E for the tab keyboard chords (BST-1842, spec §9): ⌘/Ctrl+W closes
 * the active assistant thread tab and NOT the window. The application menu has
 * no `close`/`fileMenu`/`windowMenu` role and no W accelerator, so the keystroke
 * reaches the renderer; the test asserts that menu shape in main, because a CDP
 * key press never reaches a native menu accelerator. Reopen, cycling and focus
 * return are the chord router's own behaviour, pinned by its component tests
 * (`use-tab-chords`, `assistant-thread-tabs-chords`).
 */
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { startThread } from './utils/new-thread';

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

/** Live windows in main (E2E may run unshown). */
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

async function openTwoThreads(page: Page): Promise<Locator> {
  await setupAssistantMock(page);
  await ensureAssistantShellVisible(page);
  const strip = page.getByRole('tablist', { name: 'Open assistant threads' });
  await expect(strip).toBeVisible({ timeout: 30_000 });
  // Each thread is created by its first send.
  for (let count = await strip.getByRole('tab').count(); count < 2; count += 1) {
    await startThread(page, `Thread ${count + 1}`);
    await expect(strip.getByRole('tab')).toHaveCount(count + 1, { timeout: 15_000 });
  }
  return strip;
}

test.describe('Tab keyboard chords (desktop)', () => {
  test('⌘W closes a tab, not the window', async ({ electronApp, window: page }) => {
    test.setTimeout(120_000);
    const app = electronApp.app;

    // No menu role or accelerator owns ⌘/Ctrl+W, so the renderer receives it.
    const menu = await readApplicationMenu(app);
    // Positive control (BST-1852): `Menu.getApplicationMenu()?.items ?? []` is
    // `[]` whenever the native menu is null, which would make every negative
    // assertion below pass vacuously. Prove the menu is REAL first, by finding
    // the Command Palette's ⌘K/Ctrl+K accelerator item (View menu, main.ts).
    expect(menu.length).toBeGreaterThan(0);
    expect(
      menu.filter((item) =>
        /^(CmdOrCtrl|CommandOrControl|Cmd|Ctrl)\+K$/iu.test(item.accelerator ?? '')
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
        /^(CmdOrCtrl|CommandOrControl|Cmd|Ctrl)\+W$/iu.test(item.accelerator ?? '')
      )
    ).toEqual([]);

    const strip = await openTwoThreads(page);
    const [first, last] = await tabIds(strip);
    if (!(first && last)) {
      throw new Error('expected two thread tabs');
    }
    const windowsBefore = await liveWindowCount(app);
    expect(windowsBefore).toBeGreaterThan(0);

    // Focus inside the assistant panel scopes the chord to its strip.
    await strip.locator(`#assistant-thread-tab-${last}`).click();
    await expect(strip.locator(`#assistant-thread-tab-${last}`)).toHaveAttribute(
      'aria-selected',
      'true'
    );

    await page.keyboard.press('ControlOrMeta+w');
    await expect.poll(() => tabIds(strip)).toEqual([first]);
    expect(page.isClosed()).toBe(false);
    expect(await liveWindowCount(app)).toBe(windowsBefore);
    expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
    await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible();
  });
});
