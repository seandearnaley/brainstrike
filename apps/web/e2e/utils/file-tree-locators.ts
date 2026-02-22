import type { Locator, Page } from '@playwright/test';

/**
 * File explorer migrated from ARIA tree to shared TreeTable (treegrid).
 * Keep tests compatible during rollout while preserving an explicit name anchor.
 * TODO(BST-312): remove the tree fallback once all file-explorer surfaces expose role="treegrid".
 */
export function getFileTree(page: Page): Locator {
  return page
    .getByRole('treegrid', { name: 'File tree' })
    .or(page.getByRole('tree', { name: 'File tree' }));
}
