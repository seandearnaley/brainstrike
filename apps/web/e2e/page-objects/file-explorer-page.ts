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
    return this.page.getByRole('button', { name: 'Copy Report' });
  }

  get selectAllButton(): Locator {
    return this.page.getByRole('button', { name: 'Select All' });
  }

  async selectRoot(): Promise<void> {
    await this.selectRootButton.click();
    await expect(this.fileTree).toBeVisible();
  }
}
