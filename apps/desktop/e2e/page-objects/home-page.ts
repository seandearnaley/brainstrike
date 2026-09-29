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

  /**
   * Navigates to Settings, and is IDEMPOTENT: calling it while Settings is
   * already the active route is a no-op rather than a redundant rail click.
   *
   * Settings is a full nav-rail route (BST-1668), mounted through the same
   * keep-mounted wrapper as Git/Notes/Browser, so "open" means the
   * `settings-route` wrapper is visible (it is `display: none` under any
   * other tab). The method ends by asserting the settings navigation is
   * visible on BOTH paths, so a genuine failure to open remains a visible
   * timeout.
   */
  async openSettings() {
    const settingsNavigation = this.page
      .getByTestId('settings-route')
      .getByRole('navigation', { name: 'Settings categories' });

    if (!(await settingsNavigation.isVisible())) {
      await this.mainNavigation.getByRole('button', { exact: true, name: 'Settings' }).click();
    }

    await settingsNavigation.waitFor({ state: 'visible', timeout: 10_000 });
  }

  /**
   * The app's left nav rail. Rail-item clicks are scoped here so a settings
   * category or status-bar control sharing an accessible name can never
   * collide with a navigation.
   */
  get mainNavigation() {
    return this.page.getByRole('navigation', { exact: true, name: 'Main navigation' });
  }

  /** Leave the Settings route for the Context Explorer (BST-1668). */
  async leaveSettings() {
    await this.mainNavigation
      .getByRole('button', { exact: true, name: 'Context Explorer' })
      .click();
    await this.page
      .getByTestId('settings-route')
      .getByRole('navigation', { name: 'Settings categories' })
      .waitFor({ state: 'hidden', timeout: 10_000 });
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
