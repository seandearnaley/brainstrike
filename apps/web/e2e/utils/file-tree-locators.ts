import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Retrieves the file explorer tree.
 */
export function getFileTree(page: Page): Locator {
  return page.getByRole('treegrid', { name: 'File tree' });
}

/**
 * Opens the compact Explorer actions menu for the attached workspace root.
 *
 * Radix portals the menu outside the toolbar, so scope the content through the
 * trigger's aria-controls relationship instead of selecting an arbitrary menu.
 */
export async function openExplorerCompactMenu(page: Page): Promise<Locator> {
  await expect(getFileTree(page)).toBeVisible({ timeout: 10_000 });

  const toolbar = page.getByTestId('file-explorer-toolbar');
  const compactActions = toolbar.getByRole('button', { name: 'More Explorer actions' });
  await expect(compactActions).toBeVisible({ timeout: 10_000 });

  const compactActionsHandle = await compactActions.elementHandle();
  if (!compactActionsHandle) {
    throw new Error('Compact Explorer actions trigger detached before opening');
  }

  await compactActions.click();

  const menuId = await compactActionsHandle.getAttribute('aria-controls');
  if (!menuId) {
    throw new Error('Compact Explorer actions trigger is missing aria-controls');
  }

  const explorerMenu = page.locator(`[id=${JSON.stringify(menuId)}]`);
  await expect(explorerMenu).toHaveAttribute('role', 'menu');
  await expect(explorerMenu).toBeVisible();
  return explorerMenu;
}

/**
 * Drives the responsive Explorer refresh contract.
 *
 * Exactly one action surface must be visible: the wide toolbar button or the
 * compact overflow menu. If neither or both are visible, fail instead of
 * guessing which UI state the test reached.
 */
export async function refreshFileTree(page: Page): Promise<void> {
  await expect(getFileTree(page)).toBeVisible({ timeout: 10_000 });

  const toolbar = page.getByTestId('file-explorer-toolbar');
  const wideRefresh = toolbar.getByRole('button', { exact: true, name: 'Refresh' });
  const compactActions = toolbar.getByRole('button', { name: 'More Explorer actions' });
  const visibleActionSurfaces = wideRefresh.or(compactActions).filter({ visible: true });

  await expect(visibleActionSurfaces).toHaveCount(1);

  if (await wideRefresh.isVisible()) {
    await wideRefresh.click();
    return;
  }

  const explorerMenu = await openExplorerCompactMenu(page);
  await explorerMenu.getByRole('menuitem', { exact: true, name: 'Refresh file tree' }).click();
  await expect(explorerMenu).toHaveCount(0);
}
