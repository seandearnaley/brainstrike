import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { waitForSettingsPage } from '../utils/layout-helpers';

export class SettingsPage {
  constructor(public readonly page: Page) {}

  get categoryNav(): Locator {
    return this.page.getByRole('navigation', { name: 'Settings categories' });
  }

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

  categoryButton(name: string | RegExp): Locator {
    return this.categoryNav.getByRole('button', { name });
  }

  categoryContent(categoryId: string): Locator {
    return this.page.getByTestId(`settings-category-${categoryId}`);
  }

  searchInput(): Locator {
    return this.page.getByRole('searchbox', { name: 'Search settings' });
  }

  async expectLoaded(): Promise<void> {
    await waitForSettingsPage(this.page);
  }

  async openCategory(name: string | RegExp, categoryId: string): Promise<Locator> {
    await this.categoryButton(name).click();
    const content = this.categoryContent(categoryId);
    await expect(content).toBeVisible({ timeout: 15_000 });
    return content;
  }
}
