import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import {
  assertSettingsModalClosed,
  closeSettingsModal,
  contextExplorerActiveNavLocator,
  openSettingsModal,
  profileMenuButtonLocator,
  settingsMenuItemLocator,
  settingsModalHeadingLocator,
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
    return settingsModalHeadingLocator(this.page);
  }

  get contextExplorerNavButton(): Locator {
    return this.page.getByRole('button', { exact: true, name: 'Context Explorer' });
  }

  /**
   * Settings is launched from the account/profile dropdown, not the sidebar.
   * `RootLayoutContent` filters the `/settings` item out of `navigationItems`,
   * so no top-level Settings nav button exists.
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
    await openSettingsModal(this.page);
    await waitForSettingsPage(this.page);
  }

  /**
   * Dismiss the Settings modal and wait for it to unmount. Fails loudly when the
   * modal is not actually open so callers cannot drift out of sync with the UI.
   */
  async closeSettings(): Promise<void> {
    await closeSettingsModal(this.page);
  }

  async navigateToHome(): Promise<void> {
    // Surface an open modal explicitly instead of silently dismissing it, which
    // would let a test pass with the UI in an unexpected state.
    await assertSettingsModalClosed(this.page, 'navigateToHome()');
    await this.contextExplorerNavButton.click();
    await waitForContextExplorerPage(this.page);
  }
}
