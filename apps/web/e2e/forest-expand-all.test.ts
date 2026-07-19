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
 * - Collapse All fully compacts the forest: directories collapse AND every
 *   root section header closes; a following Expand All reopens the closed
 *   sections and reaches their subtrees (BST-571).
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
 * Click the Expand All / Collapse All action. The buttons live in the
 * floating cluster pinned over the tree area (BST-571) and are visible at
 * every panel width — the old toolbar overflow-kebab fallback is gone.
 */
async function clickTreeAction(page: Page, action: 'collapse-all' | 'expand-all'): Promise<void> {
  await page.getByTestId(`${action}-button-small`).click();
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

    // Collapse All is FULLY compact (BST-571): directories collapse and every
    // root section header closes too — one click gets back to a headers-only
    // view no matter how many roots are open.
    await clickTreeAction(page, 'collapse-all');
    await expect(page.getByText('deep-a.ts')).toHaveCount(0);
    await expect(page.getByText('deep-b.ts')).toHaveCount(0);
    await expect(page.getByText('a-top.ts')).toHaveCount(0);
    await expect(page.getByText('b-top.ts')).toHaveCount(0);
    // The section headers themselves remain, closed — collapse, not clear.
    const headers = page.getByTestId('root-section-header');
    await expect(headers).toHaveCount(2);
    for (const header of await headers.all()) {
      await expect(header).toHaveAttribute('aria-expanded', 'false');
    }

    // Expand All must reach the CLOSED sections: they reopen as the sweep
    // runs and their subtrees are revealed again (before BST-571, collapsed
    // sections were unregistered and silently skipped).
    await clickTreeAction(page, 'expand-all');
    await page.getByTestId('expand-all-confirm-run').click();
    await expect(page.getByText('deep-a.ts')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('deep-b.ts')).toBeVisible({ timeout: 15_000 });
  });

  test('virtualizes against the shared sections scroller — no blank rows, bounded DOM', async ({
    page,
  }) => {
    // Big enough that the expanded forest far exceeds the viewport: 2 roots
    // × 8 dirs × 30 files ≈ 500+ rows. Regression under guard: each section's
    // viewport used to stretch to full content height inside the scrolling
    // sections column, freezing every virtualizer's window — scrolling showed
    // blank space and the DOM held every row.
    const bigTree = (prefix: string): FileTree => {
      const tree: FileTree = {};
      for (let d = 0; d < 8; d++) {
        const dir: FileTree = {};
        for (let f = 0; f < 30; f++) {
          dir[`${prefix}-${d}-${f}.ts`] = null;
        }
        tree[`dir-${d}`] = dir;
      }
      return tree;
    };

    const explorer = await bootstrapFileExplorer(page, {
      projectName: 'root-a',
      tree: bigTree('a'),
    });
    await explorer.selectRoot();
    await addMockRoot(page, 'root-b', bigTree('b'));
    await expect(getFileTree(page)).toHaveCount(2);

    await clickTreeAction(page, 'expand-all');
    await page.getByTestId('expand-all-confirm-run').click();
    // Expansion complete when a deep file from the LAST root is reachable.
    const scroller = page.getByTestId('forest-sections-scroll');
    await expect
      .poll(
        () =>
          scroller.evaluate((el) => el.scrollHeight > el.clientHeight * 3, undefined, {
            timeout: 1000,
          }),
        { timeout: 15_000 }
      )
      .toBe(true);

    // Bounded DOM: virtualization must keep rendered rows far below the
    // ~500-row total regardless of scroll position.
    const renderedRowCount = () =>
      scroller.evaluate((el) => el.querySelectorAll('[data-index]').length);
    expect(await renderedRowCount()).toBeLessThan(150);

    // Non-blank scroll: at middle and near-bottom positions, rendered rows
    // must intersect the scroller's visible window.
    const rowsInView = () =>
      scroller.evaluate((el) => {
        const viewportRect = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll('[data-index]')).filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
        }).length;
      });

    await scroller.evaluate((el) => {
      el.scrollTop = Math.floor(el.scrollHeight / 2);
    });
    await expect.poll(rowsInView, { timeout: 5000 }).toBeGreaterThan(0);
    expect(await renderedRowCount()).toBeLessThan(150);

    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect.poll(rowsInView, { timeout: 5000 }).toBeGreaterThan(0);
    // The last root's deepest file is actually reachable by scrolling.
    await expect(page.getByText('b-7-29.ts')).toBeVisible();
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
