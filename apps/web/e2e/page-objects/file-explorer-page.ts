import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class FileExplorerPage {
  constructor(public readonly page: Page) {}

  get selectRootButton(): Locator {
    return this.page.getByRole('button', { name: 'Select Root' });
  }

  get openSettingsButton(): Locator {
    return this.page.getByRole('button', { name: 'Open settings' });
  }

  get fileTree(): Locator {
    return this.page.getByRole('tree', { name: 'File tree' });
  }

  get fileTreeScrollContainer(): Locator {
    return this.page.locator('[data-testid="file-tree-scroll-container"]');
  }

  get noDirectoryText(): Locator {
    return this.page.getByText('No directory selected');
  }

  get noFilesText(): Locator {
    return this.page.getByText('No files selected');
  }

  get filterInput(): Locator {
    return this.page.getByPlaceholder("Type to filter files... (e.g. 'test component -spec')");
  }

  get downloadReportButton(): Locator {
    return this.page.getByRole('button', { name: 'Download Report' });
  }

  get copyReportButton(): Locator {
    return this.page
      .locator(
        'button:has-text("Copy Report"), button:has-text("Copy"):not(:has-text("Copy Report"))'
      )
      .first();
  }

  get selectAllButton(): Locator {
    return this.page.getByRole('button', { name: 'Select All' });
  }

  async selectRoot(): Promise<void> {
    await this.selectRootButton.click();

    // Wait for the tree to be visible with a longer timeout
    // This should work for both regular and performance tests
    await expect(this.fileTree).toBeVisible({ timeout: 30_000 });
  }
}
