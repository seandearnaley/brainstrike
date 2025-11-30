import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { waitForAppLoad } from '../utils/layout-helpers';

export class HomePage {
  constructor(public readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/');
    await waitForAppLoad(this.page);
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
    // Wait for network to be idle to ensure all resources are loaded
    await this.page.waitForLoadState('networkidle');
    // Give a bit more time for the heading to appear with longer timeout
    await expect(this.contextExplorerHeading).toBeVisible({ timeout: 10_000 });
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
