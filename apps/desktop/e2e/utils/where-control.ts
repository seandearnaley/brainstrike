import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The composer's where-control (ADR-0034): one control for the thread's
 * folders, branch and checkout. Its Branch and Folders rows are submenus.
 */
export function whereChip(scope: Locator | Page): Locator {
  return scope.getByTestId('workspace-bar-where-chip').first();
}

/** The page a scope is on: the where-menu opens at the page's top level. */
export function pageOf(scope: Locator | Page): Page {
  return 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page);
}

/** Opens the where-menu. */
export async function openWhereMenu(scope: Locator | Page): Promise<void> {
  await whereChip(scope).click();
  await expect(pageOf(scope).getByRole('menu').first()).toBeVisible();
}

/**
 * Opens a where-menu submenu from its trigger with the keyboard. Opened by a
 * click, the pointer stays on its trigger, and moving it to an item while the
 * submenu is still animating in can leave the menu's pointer grace area and
 * close it under the click (BST-2302).
 */
export async function openWhereSubmenu(page: Page, trigger: Locator): Promise<void> {
  await trigger.focus();
  await page.keyboard.press('ArrowRight');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

/**
 * The thread's folder rows: the Folders submenu while the thread has a live
 * folder, the where-menu itself while it has none. Opens the where-menu first.
 */
export async function openFolderRows(scope: Locator | Page): Promise<void> {
  await openWhereMenu(scope);
  const page = pageOf(scope);
  const folders = page.getByTestId('workspace-bar-folders');
  if (await folders.isVisible()) {
    await openWhereSubmenu(page, folders);
  }
}

/** The Branch row of the open where-menu: the switcher's submenu trigger. */
export function branchRow(page: Page): Locator {
  return page.getByTestId('workspace-bar-branch');
}
