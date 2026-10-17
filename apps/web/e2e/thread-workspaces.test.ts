import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { HOSTED_ASSISTANT_STATUS, mockAssistantApi } from './utils/assistant-mocks';
import { getFileTree } from './utils/file-tree-locators';
import { waitForAppLoad, waitForDatabaseReady } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

/**
 * BST-1268 per-thread saved workspaces: each thread owns its workspace
 * (tabs, apps, expansions); switching threads swaps it; new threads inherit;
 * the active thread's workspace survives a reload.
 */
test.describe('Per-thread workspaces', () => {
  test.beforeEach(async ({ page }) => {
    const tree: FileTree = {
      'alpha.ts': null,
      'beta.ts': null,
    };

    await mockBrowserApis(page, 'test-root', tree);
    // Web's assistant is enabled only by a configured hosted provider since the
    // built-in local chat model retired (#3679); its thread strip and workspace bar
    // mount only then.
    await mockAssistantApi(page, HOSTED_ASSISTANT_STATUS);

    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    // Thread rows live in PGlite — thread creation/switching needs the DB.
    await waitForDatabaseReady(page);
  });

  test('a new thread inherits the workspace; closing a tab there does not touch the original thread', async ({
    page,
  }) => {
    // Open a file in the first thread's workspace.
    await page.getByTestId('select-root-button').click();
    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();
    await fileTree.getByText('alpha.ts', { exact: true }).click();
    const alphaTab = page.getByTestId('workspace-tab-strip').getByRole('tab', {
      name: /alpha\.ts/,
    });
    await expect(alphaTab).toBeVisible();

    // Create a second thread — it INHERITS the current workspace.
    await page.getByTestId('assistant-new-thread-button').click();
    await expect(page.getByRole('tab', { name: /new thread/i })).toHaveCount(2);
    await expect(alphaTab).toBeVisible();

    // Close alpha in thread B only.
    await page.getByTitle('Close alpha.ts').click();
    await expect(alphaTab).toHaveCount(0);

    // Switch back to thread A: its workspace still has alpha open.
    await page.getByTestId('assistant-thread-tab-scroll').getByRole('tab').first().click();
    await expect(alphaTab).toBeVisible();

    // And back to thread B: alpha stays closed there.
    await page.getByTestId('assistant-thread-tab-scroll').getByRole('tab').nth(1).click();
    await expect(alphaTab).toHaveCount(0);
  });

  test("a reload restores the active thread's workspace", async ({ page }) => {
    await page.getByTestId('select-root-button').click();
    const fileTree = getFileTree(page);
    await expect(fileTree).toBeVisible();
    await fileTree.getByText('beta.ts', { exact: true }).click();
    await expect(
      page.getByTestId('workspace-tab-strip').getByRole('tab', { name: /beta\.ts/ })
    ).toBeVisible();

    // Let the debounced snapshot write settle before reloading.
    await page.waitForTimeout(800);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    await waitForDatabaseReady(page);

    await expect(
      page.getByTestId('workspace-tab-strip').getByRole('tab', { name: /beta\.ts/ })
    ).toBeVisible();
  });
});
