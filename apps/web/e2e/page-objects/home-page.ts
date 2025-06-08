import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class HomePage {
  constructor(public readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  get contextExplorerHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Context Explorer', exact: true });
  }

  get settingsHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Settings', exact: true });
  }

  get contextExplorerNavButton(): Locator {
    return this.page.getByRole('button', { name: 'Context Explorer', exact: true });
  }

  get settingsNavButton(): Locator {
    return this.page.getByRole('button', { name: 'Settings', exact: true });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.contextExplorerHeading).toBeVisible();
  }

  async navigateToSettings(): Promise<void> {
    await this.settingsNavButton.click();
    await expect(this.settingsHeading).toBeVisible();
  }

  async navigateToHome(): Promise<void> {
    await this.contextExplorerNavButton.click();
    await expect(this.contextExplorerHeading).toBeVisible();
  }
}
