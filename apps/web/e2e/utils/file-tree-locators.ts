import type { Locator, Page } from '@playwright/test';

/**
 * File explorer migrated from ARIA tree to shared TreeTable (treegrid).
 * Keep tests compatible during rollout while preserving an explicit name anchor.
 */
export function getFileTree(page: Page): Locator {
  return page
    .getByRole('treegrid', { name: 'File tree' })
    .or(page.getByRole('tree', { name: 'File tree' }));
}
