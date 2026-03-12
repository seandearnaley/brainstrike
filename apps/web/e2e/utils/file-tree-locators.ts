import type { Locator, Page } from '@playwright/test';

/**
 * Retrieves the file explorer tree.
 */
export function getFileTree(page: Page): Locator {
  return page.getByRole('treegrid', { name: 'File tree' });
}
