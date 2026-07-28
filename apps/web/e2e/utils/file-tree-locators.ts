import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Retrieves the file explorer tree.
 */
export function getFileTree(page: Page): Locator {
  return page.getByRole('treegrid', { name: 'File tree' });
}

/**
 * Drives the responsive Explorer refresh contract.
 *
 * Exactly one action surface must be visible: the wide toolbar button or the
 * compact overflow menu. If neither or both are visible, fail instead of
 * guessing which UI state the test reached.
 */
export async function refreshFileTree(page: Page): Promise<void> {
  const toolbar = page.getByTestId('file-explorer-toolbar');
  const wideRefresh = toolbar.getByRole('button', { exact: true, name: 'Refresh' });
  const compactActions = toolbar.getByRole('button', { name: 'More Explorer actions' });
  const visibleActionSurfaces = wideRefresh.or(compactActions).filter({ visible: true });

  await expect(visibleActionSurfaces).toHaveCount(1);

  if (await wideRefresh.isVisible()) {
    await wideRefresh.click();
    return;
  }

  await expect(compactActions).toBeVisible();
  await compactActions.click();

  const explorerMenu = page.getByRole('menu');
  await expect(explorerMenu).toBeVisible();
  await explorerMenu.getByRole('menuitem', { exact: true, name: 'Refresh file tree' }).click();
  await expect(explorerMenu).toHaveCount(0);
}
