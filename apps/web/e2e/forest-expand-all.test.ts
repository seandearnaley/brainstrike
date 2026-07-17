import { expect, type Page, test } from '@playwright/test';
import { bootstrapFileExplorer } from './utils/file-explorer-setup';
import { getFileTree } from './utils/file-tree-locators';
import { addMockRoot, type FileTree } from './utils/mock-fs';

/**
 * Forest (multi-root) Expand All — end-to-end over the multi-root fixture
 * harness (addMockRoot). Guards the toolbar → forest-registry pipeline the
 * unit suites can only cover piecewise:
 *
 * - Multi-root Expand All stages behind a confirmation naming the root count
 *   (an accidental click must not start an I/O-heavy whole-workspace sweep).
 * - Confirming expands EVERY root section's unloaded subtree through its OWN
 *   tree provider (the recurring "forest disease": routing through the
 *   focused provider silently expands only the invisible panel tree).
 * - Collapse All returns every section to its top level.
 */

const TREE_A: FileTree = {
  'a-top.ts': null,
  nested: {
    deeper: {
      'deep-a.ts': null,
    },
  },
};

const TREE_B: FileTree = {
  'b-top.ts': null,
  burrow: {
    deeper: {
      'deep-b.ts': null,
    },
  },
};

/**
 * Click the toolbar Expand All / Collapse All action. Below the 240px toolbar
 * container breakpoint the inline buttons yield to the overflow kebab, so the
 * click routes through whichever affordance the current panel width shows.
 */
async function clickTreeAction(page: Page, action: 'collapse-all' | 'expand-all'): Promise<void> {
  const inlineButton = page.getByTestId(`${action}-button-small`);
  if (await inlineButton.isVisible()) {
    await inlineButton.click();
    return;
  }
  await page.getByTestId('tree-actions-overflow-trigger').click();
  await page.getByTestId(`${action}-menu-item`).click();
}

test.describe('Forest expand-all (multi-root)', { tag: '@web-smoke' }, () => {
  test('stages behind a confirm, expands every root, collapses back', async ({ page }) => {
    const explorer = await bootstrapFileExplorer(page, { projectName: 'root-a', tree: TREE_A });
    await explorer.selectRoot();
    await addMockRoot(page, 'root-b', TREE_B);
    await expect(getFileTree(page)).toHaveCount(2);

    // Multi-root Expand All must NOT start immediately — it stages behind a
    // confirmation that names the root count.
    await clickTreeAction(page, 'expand-all');
    const confirmDialog = page.getByTestId('expand-all-confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText('2 root folders');
    await expect(page.getByText('deep-a.ts')).toHaveCount(0);

    await page.getByTestId('expand-all-confirm-run').click();
    await expect(confirmDialog).not.toBeVisible();

    // The sweep ran inside EVERY section's own tree context: deeply nested
    // (initially unloaded) files from BOTH roots are revealed.
    await expect(page.getByText('deep-a.ts')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('deep-b.ts')).toBeVisible({ timeout: 15_000 });

    // Collapse All returns every section to its top level.
    await clickTreeAction(page, 'collapse-all');
    await expect(page.getByText('deep-a.ts')).toHaveCount(0);
    await expect(page.getByText('deep-b.ts')).toHaveCount(0);
    // Top-level entries stay visible — collapse, not clear.
    await expect(page.getByText('a-top.ts')).toBeVisible();
    await expect(page.getByText('b-top.ts')).toBeVisible();
  });

  test('cancelling the confirmation leaves every root untouched', async ({ page }) => {
    const explorer = await bootstrapFileExplorer(page, { projectName: 'root-a', tree: TREE_A });
    await explorer.selectRoot();
    await addMockRoot(page, 'root-b', TREE_B);
    await expect(getFileTree(page)).toHaveCount(2);

    await clickTreeAction(page, 'expand-all');
    const confirmDialog = page.getByTestId('expand-all-confirm-dialog');
    await expect(confirmDialog).toBeVisible();
    await page.getByTestId('expand-all-confirm-cancel').click();
    await expect(confirmDialog).not.toBeVisible();

    await expect(page.getByText('deep-a.ts')).toHaveCount(0);
    await expect(page.getByText('deep-b.ts')).toHaveCount(0);
  });
});
