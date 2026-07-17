import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export class SettingsPage {
  constructor(private readonly page: Page) {}

  get categoryNav(): Locator {
    return this.page.getByRole('navigation', { name: 'Settings categories' });
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { exact: true, name: 'Settings' });
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
    await expect(this.heading).toBeVisible({ timeout: 15_000 });
    await expect(this.categoryNav).toBeVisible({ timeout: 15_000 });
  }

  async openCategory(name: string | RegExp, categoryId: string): Promise<Locator> {
    await this.categoryButton(name).click();
    const content = this.categoryContent(categoryId);
    await expect(content).toBeVisible({ timeout: 15_000 });
    return content;
  }
}
