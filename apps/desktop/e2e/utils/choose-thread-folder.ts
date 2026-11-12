import { expect, type Locator, type Page } from '@playwright/test';
import { openFolderRows, whereChip } from './where-control';

/**
 * Chooses one of the workspace's open folders for the current thread the way a
 * person does: open the composer's where-control and pick the folder by name.
 * A thread has no folder until it is chosen (or added), so a test that needs the
 * thread bound to a folder calls this before sending. Resolves once the control
 * names the folder.
 */
export async function chooseThreadFolder(scope: Locator | Page, folderName: string): Promise<void> {
  const page = 'page' in scope && typeof scope.page === 'function' ? scope.page() : (scope as Page);
  const chip = whereChip(scope);
  await openFolderRows(scope);
  await page.getByRole('menuitem', { exact: true, name: folderName }).click();
  await expect(chip).toHaveAccessibleName(
    new RegExp(`^Where this thread works: ${escapeRegExp(folderName)}`, 'u')
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
