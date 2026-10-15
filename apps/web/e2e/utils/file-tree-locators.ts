import { expect, type Locator, type Page } from '@playwright/test';
import { CONTEXT_EXPLORER_PANEL_SELECTOR } from './layout-helpers';

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
  // No "a tree is visible" precondition: after a forest Collapse All every
  // section is closed and NO treegrid is mounted, yet the toolbar actions must
  // still be reachable (that is the BST-571 contract). The trigger's own
  // visibility is the real readiness gate.
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
  // `.first()`: forest mode mounts one treegrid per root and the accessible
  // name is matched by substring, so an unqualified expect trips strict mode.
  await expect(getFileTree(page).first()).toBeVisible({ timeout: 10_000 });

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

/** The two Explorer tree-expansion actions, by their stable testids. */
export type ExplorerTreeAction = 'collapse-all' | 'expand-all';

const TREE_ACTION_MENU_ITEM: Record<ExplorerTreeAction, string> = {
  'collapse-all': 'Collapse all directories',
  'expand-all': 'Expand all directories',
};

/**
 * Drives Expand All / Collapse All the way a USER reaches them.
 *
 * These are responsive, exactly like Refresh above. BST-571 put them in a
 * floating overlay pinned over the tree area, where they were visible at every
 * width; BST-1208 retired that overlay (it covered the tree grid's column
 * header and intercepted its clicks) and moved them into the toolbar's left
 * track at the 236px step, folding into the compact menu below it. The
 * Explorer's default and minimum panel width is 180px, so the compact menu is
 * the DEFAULT route — clicking the testid directly times out there, which is
 * how this regression reached CI.
 *
 * Measured (built preview, whole-branch review): at 180px the toolbar's left
 * track is 76px and holds 12px of padding plus the 28px selection badge — 36px
 * free, against the ~50px two 24px controls need. The filter bar cannot host
 * them either: collapsing view filters (a persisted preference) makes that
 * block `height: 0` and `inert`, so anything in it becomes unreachable rather
 * than merely hidden.
 *
 * Same rigor as `refreshFileTree`: exactly one surface must be offering the
 * action, so a layout change that shows both (or neither) fails loudly instead
 * of being papered over by a fallback.
 */
export async function clickExplorerTreeAction(
  page: Page,
  action: ExplorerTreeAction
): Promise<void> {
  // Deliberately NO "a tree is visible" wait: Collapse All closes every forest
  // section, and the very next thing a spec does is Expand All again — which
  // must work with no treegrid mounted at all.
  const toolbar = page.getByTestId('file-explorer-toolbar');
  const wideButton = toolbar.getByTestId(`${action}-button-small`);
  const compactActions = toolbar.getByRole('button', { name: 'More Explorer actions' });
  const visibleActionSurfaces = wideButton.or(compactActions).filter({ visible: true });

  await expect(visibleActionSurfaces).toHaveCount(1);

  if (await wideButton.isVisible()) {
    await wideButton.click();
    return;
  }

  const explorerMenu = await openExplorerCompactMenu(page);
  await explorerMenu
    .getByRole('menuitem', { exact: true, name: TREE_ACTION_MENU_ITEM[action] })
    .click();
  await expect(explorerMenu).toHaveCount(0);
}

/**
 * Locator for whichever surface currently offers a tree action — for the
 * specs that assert on enabled/disabled state rather than clicking.
 */
export function explorerTreeActionButton(page: Page, action: ExplorerTreeAction): Locator {
  return page.getByTestId('file-explorer-toolbar').getByTestId(`${action}-button-small`);
}

/**
 * The Explorer is the whole Files page (BST-2018), as wide as the workspace
 * panel, so there is no separator to drag: this checks it is past the
 * toolbar's 388px step, where every control renders directly.
 */
export async function widenExplorerPanel(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator(CONTEXT_EXPLORER_PANEL_SELECTOR).evaluate((element) => element.clientWidth)
    )
    .toBeGreaterThan(388);
}

/**
 * Widen the Explorer until the tree-action BUTTONS are rendered directly.
 *
 * For specs that assert on the button itself — its `aria-label` flipping to
 * "Expanding...", its disabled state during a sweep — rather than on the
 * action's effect. Below the toolbar's 236px step those buttons are not merely
 * hidden: they are not in the DOM at all (they live in the compact menu), so
 * such assertions need the wide layout explicitly rather than by luck.
 */
export async function widenExplorerForDirectTreeActions(page: Page): Promise<void> {
  const expandButton = page
    .getByTestId('file-explorer-toolbar')
    .getByTestId('expand-all-button-small');
  if (await expandButton.isVisible().catch(() => false)) {
    return;
  }
  await widenExplorerPanel(page);
  await expect(expandButton).toBeVisible({ timeout: 10_000 });
}
