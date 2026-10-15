import { expect, type Page } from '@playwright/test';
import { resetAppState } from './app-state';
import { waitForAppLoad } from './layout-helpers';
import { type FileTree, mockBrowserApis } from './mock-fs';

interface AssistantWorkspaceOptions {
  readonly clipboard?: boolean;
  /**
   * Wait for the hosted composer to accept input before returning. The
   * provider and model themselves come from the mocked
   * `/api/assistant/status` payload (`HOSTED_ASSISTANT_STATUS`); this is the
   * readiness barrier, so a suite never races the first `Send`.
   */
  readonly hostedAssistantModel?: boolean;
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

  if (options.hostedAssistantModel === true) {
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeEnabled({
      timeout: 15_000,
    });
  }
}
