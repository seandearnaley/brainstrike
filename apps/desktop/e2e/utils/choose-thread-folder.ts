import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Chooses one of the workspace's open folders for the current thread the way a
 * person does: open the workspace-bar folder chip and pick the folder by name.
 * A thread has no folder until it is chosen (or added), so a test that needs the
 * thread bound to a folder calls this before sending. Resolves once the chip
 * names the folder.
 */
export async function chooseThreadFolder(scope: Locator | Page, folderName: string): Promise<void> {
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page);
  const chip = scope.getByTestId('workspace-bar-folder-chip').first();
  await chip.click();
  await page.getByRole('menuitem', { exact: true, name: folderName }).click();
  await expect(chip).toHaveAccessibleName(new RegExp(`^Folder: ${escapeRegExp(folderName)}`, 'u'));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
