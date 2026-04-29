import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
  contextExplorerActiveNavLocator,
  type WaitForAppLoadOptions,
  waitForAppLoad,
  waitForContextExplorerPage,
  waitForSettingsPage,
} from '../utils/layout-helpers';

export class HomePage {
  constructor(public readonly page: Page) {}

  async goto(options?: WaitForAppLoadOptions): Promise<void> {
    await this.page.goto('/');
    await waitForAppLoad(this.page, 10_000, options);
  }

  /**
   * Locator that resolves when the Context Explorer page is active
   * (sidebar nav button has `aria-current="page"`).
   */
  get contextExplorerPageMarker(): Locator {
    return contextExplorerActiveNavLocator(this.page);
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
    await expect(this.contextExplorerPageMarker).toBeVisible({ timeout: 10_000 });
  }

  async navigateToSettings(): Promise<void> {
    await this.settingsNavButton.click();
    await waitForSettingsPage(this.page);
  }

  async navigateToHome(): Promise<void> {
    await this.contextExplorerNavButton.click();
    await waitForContextExplorerPage(this.page);
  }
}
