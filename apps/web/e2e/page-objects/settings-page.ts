import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class SettingsPage {
  constructor(public readonly page: Page) {}

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Settings', exact: true });
  }

  get lightThemeButton(): Locator {
    return this.page.getByRole('button', { name: 'Light' });
  }

  get darkThemeButton(): Locator {
    return this.page.getByRole('button', { name: 'Dark' });
  }

  get systemThemeButton(): Locator {
    return this.page.getByRole('button', { name: 'System' });
  }

  async expectLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }
}
