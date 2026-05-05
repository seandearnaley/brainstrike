import type { Page } from '@playwright/test';
import { FileExplorerPage } from '../page-objects/file-explorer-page';
import { HomePage } from '../page-objects/home-page';
import { waitForAppLoad } from './layout-helpers';
import { type FileTree, mockBrowserApis } from './mock-fs';

export interface ExplorerBootstrapOptions {
  /**
   * Additional storage keys to clear before reloading the application.
   */
  clearStorageKeys?: string[];
  /**
   * Optional label to use for the mocked root directory.
   * Defaults to "test-root" for historical parity with existing tests.
   */
  projectName?: string;
  /**
   * Reload the page after clearing storage to ensure UI picks up default state.
   * Enabled by default to mirror prior test flows.
   */
  reloadAfterClear?: boolean;
  /**
   * Remove persisted file explorer settings before continuing.
   * This clears both the legacy and current storage keys so scenarios start clean.
   */
  resetSettings?: boolean;
  /**
   * Mocked file system tree that will be exposed through the File System Access API.
   */
  tree: FileTree;
  /**
   * Wait for the database status bar before returning.
   * File explorer-only flows do not need the DB and should not pay greenfield
   * PGlite startup cost in every isolated browser context.
   */
  waitForDatabase?: boolean;
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
    waitForDatabase = false,
  } = options;

  await mockBrowserApis(page, projectName, tree);

  const home = new HomePage(page);
  await home.goto({ waitForDatabase });

  const keysToClear = new Set(clearStorageKeys);
  if (resetSettings) {
    keysToClear.add('file-explorer-storage-v4');
    keysToClear.add('fileExplorerSettings');
    keysToClear.add('previewPanelPreferences.v1');
  }

  if (keysToClear.size > 0) {
    await page.evaluate((keys) => {
      for (const key of keys) {
        localStorage.removeItem(key);
      }
    }, Array.from(keysToClear));

    if (reloadAfterClear) {
      await reloadExplorer(page, { waitForDatabase });
    }
  }

  return new FileExplorerPage(page);
}

/**
 * Helper to reload the current page and wait for the application shell to settle.
 */
export async function reloadExplorer(
  page: Page,
  options: { readonly waitForDatabase?: boolean } = {}
): Promise<void> {
  await page.reload({ waitUntil: 'load' });
  await waitForAppLoad(page, { waitForDatabase: options.waitForDatabase ?? false });
}
