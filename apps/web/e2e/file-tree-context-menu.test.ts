import { expect, test } from '@playwright/test';
import type { FileExplorerPage } from './page-objects/file-explorer-page';
import { bootstrapFileExplorer } from './utils/file-explorer-setup';
import type { FileTree } from './utils/mock-fs';

// Extensions here are arbitrary: DEFAULT_STATE.includeFilters is empty (include
// filters are opt-in), so nothing in this fixture is filtered out. See
// packages/types/src/file-explorer-state-types.ts.
const tree: FileTree = {
  docs: {
    'notes.ts': null,
  },
  'readme.ts': null,
};

/**
 * Expands a collapsed directory row by clicking its Expand toggle, mirroring
 * the gesture used by file-explorer-persistence.test.ts.
 */
async function expandDirectory(explorer: FileExplorerPage, directoryName: string): Promise<void> {
  const escapedName = directoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const row = explorer.fileTree
    .getByRole('row', { name: new RegExp(`^Expand Select ${escapedName}\\b`) })
    .first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByRole('button', { name: 'Expand' }).click();
}

test.describe('File tree context menu', { tag: '@web-smoke' }, () => {
  test('copies the relative path of a nested file', async ({ page }) => {
    const consoleMessages: string[] = [];
    page.on('console', (message) => consoleMessages.push(message.text()));

    const explorer = await bootstrapFileExplorer(page, { clipboard: true, tree });
    await explorer.selectRoot();

    await expandDirectory(explorer, 'docs');

    const fileRow = explorer.fileTree.getByText('notes.ts', { exact: true });
    await expect(fileRow).toBeVisible();
    await fileRow.click({ button: 'right' });

    const copyRelative = page.getByRole('menuitem', { name: 'Copy Relative Path' });
    await expect(copyRelative).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Copy Name' })).toBeVisible();

    // Desktop-only actions must be hidden on web (no absolute paths).
    await expect(page.getByRole('menuitem', { name: 'Copy Full Path' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: /Reveal in/ })).toHaveCount(0);

    await copyRelative.click();
    await expect(page.getByRole('menu')).toBeHidden();

    const notesRow = fileRow.locator('xpath=ancestor::*[@data-node-id][1]');
    await expect(notesRow).toBeFocused();

    // Success toast confirms the outcome surfaced to the user. Radix Toast
    // also mirrors the text into an aria-live announcement node, so the text
    // can resolve to two elements — assert on the first match.
    await expect(page.getByText('Relative path copied').first()).toBeVisible();

    // The clipboard mock logs the written text to the console.
    await expect
      .poll(() => consoleMessages.some((text) => text.includes('docs/notes.ts')))
      .toBe(true);

    // Focus ownership remains with the tree after Radix closes. Keyboard
    // navigation and an immediate second context menu must both keep working.
    await notesRow.press('ArrowDown');
    const readmeRow = explorer.fileTree
      .getByText('readme.ts', { exact: true })
      .locator('xpath=ancestor::*[@data-node-id][1]');
    await expect(readmeRow).toHaveAttribute('data-focused', 'true');
    await readmeRow.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Copy Relative Path' })).toBeVisible();
  });
});
