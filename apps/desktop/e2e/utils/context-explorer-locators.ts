import type { Locator, Page } from '@playwright/test';

export const contextExplorerFileExplorerPanelSelector = [
  '#context-explorer-tools-panel',
  '[data-panel-id="context-explorer-tools-panel"]',
  '#tools-panel',
  '[data-panel-id="tools-panel"]',
].join(', ');
export const contextExplorerMiddlePanelSelector = '#context-explorer-middle-panel, #middle-panel';

export function getContextExplorerFileExplorerPanel(page: Page): Locator {
  return page.locator(contextExplorerFileExplorerPanelSelector);
}

export function getContextExplorerMiddlePanel(page: Page): Locator {
  return page.locator(contextExplorerMiddlePanelSelector);
}
