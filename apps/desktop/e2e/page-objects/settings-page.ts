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

  /**
   * Sets one subagent limit (Settings → Subagents → Subagent limits) through its field,
   * which commits on Enter, and waits until THAT commit is stored: the check
   * runs before the blur, which would commit a draft on its own.
   */
  async setSubagentLimit(label: string, settingKey: string, value: number): Promise<void> {
    const section = (await this.openCategory(/Subagents/i, 'subagents')).getByTestId(
      'subagent-settings-section'
    );
    const field = section.getByRole('spinbutton', { exact: true, name: label });
    await field.fill(String(value));
    await field.press('Enter');
    await expect(section.getByRole('alert')).toHaveCount(0);
    await expect(field).not.toHaveAttribute('aria-invalid');
    // Only a landed commit reaches the persisted preferences store.
    await expect
      .poll(() =>
        this.page.evaluate((key) => {
          const stored = window.localStorage.getItem('assistant-subagent-preferences.v1');
          const settings = stored
            ? (JSON.parse(stored) as { state?: { settings?: Record<string, unknown> } }).state
                ?.settings
            : undefined;
          return settings?.[key];
        }, settingKey)
      )
      .toBe(value);
    await field.blur();
    await expect(field).toHaveValue(String(value));
  }
}
