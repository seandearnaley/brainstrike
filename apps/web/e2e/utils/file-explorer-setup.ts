import type { Locator, Page } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { waitForAppLoad } from './layout-helpers';
import { type FileTree, mockBrowserApis } from './mock-fs';

export interface ExplorerBootstrapOptions {
  /**
   * Mocked file system tree that will be exposed through the File System Access API.
   */
  tree: FileTree;
  /**
   * Optional label to use for the mocked root directory.
   * Defaults to "test-root" for historical parity with existing tests.
   */
  projectName?: string;
  /**
   * Remove persisted file explorer settings before continuing.
   * This clears both the legacy and current storage keys so scenarios start clean.
   */
  resetSettings?: boolean;
  /**
   * Additional storage keys to clear before reloading the application.
   */
  clearStorageKeys?: string[];
  /**
   * Reload the page after clearing storage to ensure UI picks up default state.
   * Enabled by default to mirror prior test flows.
   */
  reloadAfterClear?: boolean;
}

/**
 * Bootstraps the file explorer by mocking the file system, navigating to the app,
 * clearing any requested storage keys, and returning a page object for interaction.
 */
export async function bootstrapFileExplorer(
  page: Page,
  options: ExplorerBootstrapOptions
): Promise<FileExplorerPage> {
  const {
    tree,
    projectName = 'test-root',
    resetSettings = false,
    clearStorageKeys = [],
    reloadAfterClear = true,
  } = options;

  await mockBrowserApis(page, projectName, tree);

  const home = new HomePage(page);
  await home.goto();
  await waitForAppLoad(page);

  const keysToClear = new Set(clearStorageKeys);
  if (resetSettings) {
    keysToClear.add('file-explorer-storage-v4');
    keysToClear.add('fileExplorerSettings');
  }

  if (keysToClear.size > 0) {
    await page.evaluate((keys) => {
      for (const key of keys) {
        localStorage.removeItem(key);
      }
    }, Array.from(keysToClear));

    if (reloadAfterClear) {
      await reloadExplorer(page);
    }
  }

  return new FileExplorerPage(page);
}

/**
 * Helper to reload the current page and wait for the application shell to settle.
 */
export async function reloadExplorer(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'load' });
  await waitForAppLoad(page);
}

/**
 * Opens the file explorer settings dialog and waits for it to become visible.
 */
export async function openExplorerSettings(
  page: Page,
  explorer: FileExplorerPage
): Promise<Locator> {
  await explorer.openSettingsButton.click();
  const dialog = page.locator('dialog[aria-labelledby="config-title"]');
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}
