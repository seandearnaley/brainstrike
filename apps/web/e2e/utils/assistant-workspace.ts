import { expect, type Page } from '@playwright/test';
import { resetAppState } from './app-state';
import { waitForAppLoad } from './layout-helpers';
import { type FileTree, mockBrowserApis } from './mock-fs';

interface AssistantWorkspaceOptions {
  readonly clipboard?: boolean;
  readonly rootName?: string;
  readonly tree?: FileTree;
}

const DEFAULT_ASSISTANT_TREE: FileTree = {
  'README.md': '# Assistant workspace fixture',
};

export async function openAssistantWorkspace(
  page: Page,
  options: AssistantWorkspaceOptions = {}
): Promise<void> {
  await mockBrowserApis(
    page,
    options.rootName ?? 'assistant-workspace',
    options.tree ?? DEFAULT_ASSISTANT_TREE,
    { clipboard: options.clipboard ?? false }
  );

  await page.goto('/');
  await waitForAppLoad(page, { waitForDatabase: false });
  await resetAppState(page);
  await page.reload({ waitUntil: 'load' });
  await waitForAppLoad(page, { waitForDatabase: true });

  const selectRootButton = page.getByRole('button', { name: /^Add Folder to Workspace$/i });
  if (await selectRootButton.isVisible().catch(() => false)) {
    await selectRootButton.click();
  }

  await expect(page.getByTestId('assistant-thread-tabs-workspace')).toBeVisible({
    timeout: 15_000,
  });
}
