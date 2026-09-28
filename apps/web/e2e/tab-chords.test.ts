import { expect, type Locator, type Page, test } from '@playwright/test';
import { openAssistantWorkspace } from './utils/assistant-workspace';
import { getFileTree } from './utils/file-tree-locators';
import { getPanelElements } from './utils/layout-helpers';

/**
 * Tab chords on web (BST-1842, spec §9) against the built app. Ctrl+PgUp/PgDn
 * act on the strip whose panel holds focus, and on the workspace strip when
 * focus is in no panel. The browser keeps ⌘W, ⌘T and Ctrl+Tab.
 */

async function selectedTabId(strip: Locator): Promise<string | null> {
  return await strip.locator('[role="tab"][aria-selected="true"]').getAttribute('id');
}

/** Whether the app claimed a keystroke: read after every document listener ran. */
async function pressAndReadDefaultPrevented(page: Page, keys: string): Promise<boolean> {
  await page.evaluate(() => {
    const record = (event: KeyboardEvent): void => {
      (window as Window & { __lastKeyPrevented?: boolean }).__lastKeyPrevented =
        event.defaultPrevented;
    };
    window.addEventListener('keydown', record, { once: true });
  });
  await page.keyboard.press(keys);
  return await page.evaluate(
    () => (window as Window & { __lastKeyPrevented?: boolean }).__lastKeyPrevented === true
  );
}

test.describe('Tab chords by focus scope @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ page }) => {
    await openAssistantWorkspace(page);
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }
    const threads = page.getByRole('tablist', { name: 'Open assistant threads' });
    if ((await threads.getByRole('tab').count()) < 2) {
      await page.getByTestId('assistant-new-thread-button').click();
    }
    await expect(threads.getByRole('tab')).toHaveCount(2);

    const workspace = page.getByRole('tablist', { name: 'Workspace tabs' });
    await getFileTree(page).getByText('README.md', { exact: true }).click();
    await expect(workspace.getByRole('tab', { name: /README\.md/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(workspace.getByRole('tab')).toHaveCount(2);
  });

  test('Ctrl+PgDn cycles the workspace strip from no panel and the assistant strip from its panel', async ({
    page,
  }) => {
    const threads = page.getByRole('tablist', { name: 'Open assistant threads' });
    const workspace = page.getByRole('tablist', { name: 'Workspace tabs' });
    const threadBefore = await selectedTabId(threads);

    // Focus in no panel: the workspace strip moves, the assistant strip stays.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+PageDown');
    await expect(workspace.getByRole('tab', { name: /Files/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.keyboard.press('Control+PageUp');
    await expect(workspace.getByRole('tab', { name: /README\.md/ })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await selectedTabId(threads)).toBe(threadBefore);

    // Focus inside the assistant panel: the assistant strip moves. (Switching
    // threads then hydrates that thread's saved workspace, BST-1268, so the
    // workspace strip is not asserted here; the unit suite pins exclusivity.)
    await page
      .getByTestId('assistant-thread-tabs-workspace')
      .locator('[role="tabpanel"]:not([hidden])')
      .getByRole('textbox', { name: 'Message input' })
      .click();
    await page.keyboard.press('Control+PageDown');
    await expect.poll(() => selectedTabId(threads)).not.toBe(threadBefore);
    // The switch hid the composer's panel; focus stays in the assistant strip,
    // so the next press cycles threads again (wrapping back) rather than the
    // workspace.
    await page.keyboard.press('Control+PageDown');
    await expect.poll(() => selectedTabId(threads)).toBe(threadBefore);
  });

  test('leaves ⌘W, ⌘T and Ctrl+Tab to the browser', async ({ page }) => {
    const threads = page.getByRole('tablist', { name: 'Open assistant threads' });
    const workspace = page.getByRole('tablist', { name: 'Workspace tabs' });
    const workspaceBefore = await selectedTabId(workspace);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    for (const keys of ['ControlOrMeta+w', 'ControlOrMeta+t', 'Control+Tab']) {
      expect(await pressAndReadDefaultPrevented(page, keys), keys).toBe(false);
    }
    await expect(workspace.getByRole('tab')).toHaveCount(2);
    await expect(threads.getByRole('tab')).toHaveCount(2);
    expect(await selectedTabId(workspace)).toBe(workspaceBefore);
  });
});
