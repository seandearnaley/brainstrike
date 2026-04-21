import type { Locator, Page } from '@playwright/test';

export const contextExplorerLeftPanelSelector = '#context-explorer-explorer-panel, #explorer-panel';
export const contextExplorerMiddlePanelSelector = '#context-explorer-middle-panel, #middle-panel';

export function getContextExplorerLeftPanel(page: Page): Locator {
  return page.locator(contextExplorerLeftPanelSelector);
}

export function getContextExplorerMiddlePanel(page: Page): Locator {
  return page.locator(contextExplorerMiddlePanelSelector);
}
