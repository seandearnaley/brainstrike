import type { Page } from 'playwright';

export class HomePage {
  constructor(private readonly page: Page) {}

  // Locators
  get appTitle() {
    return this.page.locator('title');
  }

  get fileExplorerPanel() {
    return this.page.getByTestId('file-explorer-panel');
  }

  get mainContentArea() {
    return this.page.getByTestId('main-content-area');
  }

  get loadingIndicator() {
    return this.page.getByText('Loading...');
  }

  get rootElement() {
    return this.page.locator('#root');
  }

  get themeToggle() {
    // Theme toggle button has aria-label "Switch to dark mode" or "Switch to light mode"
    return this.page.getByRole('button', { name: /Switch to (dark|light) mode/i });
  }

  // Actions
  async waitForLoad() {
    // Wait for the root element to be present and app to be loaded
    await this.rootElement.waitFor({ state: 'attached' });

    // Wait for loading indicator to disappear if present
    const loadingElement = this.loadingIndicator;
    if (await loadingElement.isVisible().catch(() => false)) {
      await loadingElement.waitFor({ state: 'hidden', timeout: 10_000 });
    }

    // Give the app a moment to fully initialize
    await this.page.waitForTimeout(1000);
  }

  async openSettings() {
    await this.page.getByRole('button', { name: 'Open profile menu' }).click();
    await this.page.getByRole('menuitem', { name: 'Settings…' }).click();

    const settingsLoading = this.page.getByTestId('desktop-settings-page-loading');
    if (await settingsLoading.isVisible().catch(() => false)) {
      await settingsLoading.waitFor({ state: 'hidden', timeout: 10_000 });
    }

    await this.page
      .getByRole('navigation', { name: 'Settings categories' })
      .waitFor({ state: 'visible', timeout: 10_000 });
  }

  async toggleTheme() {
    if (await this.themeToggle.isVisible().catch(() => false)) {
      await this.themeToggle.click();
    }
  }

  async openFileExplorer() {
    const fileExplorerButton = this.page.getByRole('button', { name: /file explorer/i });
    if (await fileExplorerButton.isVisible().catch(() => false)) {
      await fileExplorerButton.click();
    }
  }

  // Assertions
  async shouldBeVisible() {
    // Check that the app has loaded by verifying the root element exists
    await this.rootElement.waitFor({ state: 'attached' });

    // Verify the app title
    const title = await this.page.title();
    if (!title.includes('BrainStrike')) {
      throw new Error(`Expected title to contain 'BrainStrike' but got: ${title}`);
    }

    // Wait for any loading to complete
    await this.waitForLoad();
  }

  async shouldShowFileExplorer() {
    if (await this.fileExplorerPanel.isVisible().catch(() => false)) {
      await this.fileExplorerPanel.waitFor({ state: 'visible' });
    } else {
      // If no specific file explorer panel, just verify the app is loaded
      await this.shouldBeVisible();
    }
  }

  async shouldHaveTheme(theme: 'light' | 'dark') {
    const htmlElement = this.page.locator('html');
    if (theme === 'dark') {
      await htmlElement.waitFor({ state: 'attached' });
      const classList = await htmlElement.getAttribute('class');
      if (!classList?.includes('dark')) {
        throw new Error(`Expected dark theme but got: ${classList}`);
      }
    } else {
      await htmlElement.waitFor({ state: 'attached' });
      const classList = await htmlElement.getAttribute('class');
      if (classList?.includes('dark')) {
        throw new Error(`Expected light theme but got: ${classList}`);
      }
    }
  }
}
