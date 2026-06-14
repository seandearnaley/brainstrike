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

  get noDirectoryText(): Locator {
    return this.page.getByText('No folders in your workspace');
  }

  get noFilesText(): Locator {
    return this.page.getByText('No files selected');
  }

  get filterInput(): Locator {
    return this.page.getByTestId('file-filter-input');
  }

  get downloadContextButton(): Locator {
    return this.page.getByTestId('download-context-button');
  }

  get copyContextButton(): Locator {
    return this.page.getByTestId('copy-context-button');
  }

  /** @deprecated Use `downloadContextButton` instead. */
  get downloadReportButton(): Locator {
    return this.downloadContextButton;
  }

  /** @deprecated Use `copyContextButton` instead. */
  get copyReportButton(): Locator {
    return this.copyContextButton;
  }

  get selectAllButton(): Locator {
    return this.page.getByRole('button', { name: 'Select All' });
  }

  get includeProjectTreeToggle(): Locator {
    return this.page.getByRole('switch', { name: 'Include Project Tree' });
  }

  async selectRoot(): Promise<void> {
    await this.selectRootButton.click();

    // Wait for the tree to be visible with a longer timeout
    // This should work for both regular and performance tests
    await expect(this.fileTree).toBeVisible({ timeout: 30_000 });
  }
}
