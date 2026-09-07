import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
  contextExplorerActiveNavLocator,
  leaveSettingsPage,
  openSettingsPage,
  profileMenuButtonLocator,
  settingsHeadingLocator,
  settingsMenuItemLocator,
  settingsNavButtonLocator,
  type WaitForAppLoadOptions,
  waitForAppLoad,
  waitForContextExplorerPage,
  waitForSettingsPage,
} from '../utils/layout-helpers';

export class HomePage {
  constructor(public readonly page: Page) {}

  async goto(options?: WaitForAppLoadOptions): Promise<void> {
    await this.page.goto('/');
    await waitForAppLoad(this.page, { ...options, timeoutMs: options?.timeoutMs ?? 10_000 });
  }

  /**
   * Locator that resolves when the Context Explorer page is active
   * (sidebar nav button has `aria-current="page"`).
   */
  get contextExplorerPageMarker(): Locator {
    return contextExplorerActiveNavLocator(this.page);
  }

  get settingsHeading(): Locator {
    return settingsHeadingLocator(this.page);
  }

  /** The nav-rail Settings item (BST-1668: Settings is a full app tab again). */
  get settingsNavButton(): Locator {
    return settingsNavButtonLocator(this.page);
  }

  get contextExplorerNavButton(): Locator {
    return this.page.getByRole('button', { exact: true, name: 'Context Explorer' });
  }

  /**
   * The account/profile dropdown also carries a "Settings…" entry that lands on
   * the same route as the nav-rail item.
   */
  get profileMenuButton(): Locator {
    return profileMenuButtonLocator(this.page);
  }

  /**
   * The dropdown entry renders as `Settings…` (with an ellipsis), so this matches
   * on the prefix rather than an exact name.
   */
  get settingsMenuItem(): Locator {
    return settingsMenuItemLocator(this.page);
  }

  async expectLoaded(): Promise<void> {
    // Wait for network to be idle to ensure all resources are loaded
    await this.page.waitForLoadState('networkidle');
    await expect(this.contextExplorerPageMarker).toBeVisible({ timeout: 10_000 });
  }

  async navigateToSettings(): Promise<void> {
    await openSettingsPage(this.page);
    await waitForSettingsPage(this.page);
  }

  /**
   * Leave the Settings route for the Context Explorer and wait for the settings
   * page to be hidden. Fails loudly when Settings is not the active route so
   * callers cannot drift out of sync with the UI.
   */
  async leaveSettings(): Promise<void> {
    await leaveSettingsPage(this.page);
  }

  async navigateToHome(): Promise<void> {
    await this.contextExplorerNavButton.click();
    await waitForContextExplorerPage(this.page);
  }
}
