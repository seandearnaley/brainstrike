import type { Locator, Page } from '@playwright/test';

/** The Files app's explorer tab (ADR-0021: the explorer is the whole Files page). */
export const contextExplorerFileExplorerPanelSelector =
  '[data-testid="explorer-search-panel-explorer"]';

export function getContextExplorerFileExplorerPanel(page: Page): Locator {
  return page.locator(contextExplorerFileExplorerPanelSelector);
}
