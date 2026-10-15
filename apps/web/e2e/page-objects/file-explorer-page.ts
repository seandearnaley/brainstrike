import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { getFileTree } from '../utils/file-tree-locators';

export class FileExplorerPage {
  constructor(public readonly page: Page) {}

  get selectRootButton(): Locator {
    return this.page.getByTestId('select-root-button');
  }

  get fileTree(): Locator {
    return getFileTree(this.page);
  }

  get fileTreeScrollContainer(): Locator {
    return this.page.locator('[data-testid="file-tree-scroll-container"]');
  }

  get fileTreeViewport(): Locator {
    return this.page.locator('[data-testid="tree-table-viewport"]');
  }

  get noDirectoryText(): Locator {
    return this.page.getByText('No folders in your workspace');
  }

  /** The selection bar; it shows only with a selection (the Files app has no preview, BST-2018). */
  get selectionBar(): Locator {
    return this.page.getByTestId('explorer-selection-actions');
  }

  get filterInput(): Locator {
    return this.page.getByTestId('file-filter-input');
  }

  /** The selection bar's Export action (BST-2018); it shows only with a selection. */
  get exportTrigger(): Locator {
    return this.page.getByTestId('explorer-export-trigger');
  }

  /** Inside the open Export popover. */
  get exportDownloadButton(): Locator {
    return this.page.getByTestId('explorer-export-download');
  }

  /** Inside the open Export popover. */
  get exportCopyButton(): Locator {
    return this.page.getByTestId('explorer-export-copy');
  }

  get selectAllButton(): Locator {
    return this.page.getByRole('button', { name: 'Select All' });
  }

  /** Inside the open Export popover. */
  get includeProjectTreeToggle(): Locator {
    return this.page.getByTestId('explorer-export-include-tree');
  }

  async selectRoot(): Promise<void> {
    await this.selectRootButton.click();

    // Wait for the tree to be visible with a longer timeout
    // This should work for both regular and performance tests
    await expect(this.fileTree).toBeVisible({ timeout: 30_000 });
  }
}
