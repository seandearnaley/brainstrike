import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import {
  corruptLayoutStorage,
  getPanelElements,
  togglePanelVisibility,
  verifyDefaultLayout,
  waitForAppLoad,
  waitForContextExplorerPage,
  waitForSettingsPage,
} from './utils/layout-helpers';

test.describe('Application Layout', { tag: '@smoke' }, () => {
  test('should render the main layout correctly', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    // Ensure the main content area is visible
    await expect(page.locator('main')).toBeVisible();

    // Verify the page title is for Context Explorer by default and visible
    await expect(home.contextExplorerHeading).toBeVisible();
    // Ensure the Settings H1 is in the DOM but not visible
    await expect(home.settingsHeading).not.toBeVisible();
  });

  test('should have working sidebar navigation', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();

    // Ensure both buttons are present initially
    await expect(home.contextExplorerNavButton).toBeVisible();
    await expect(home.settingsNavButton).toBeVisible();

    // Initial state: Context Explorer is active, Settings is not
    await expect(home.contextExplorerHeading).toBeVisible();
    await expect(home.settingsHeading).not.toBeVisible();

    // Ensure Settings button is enabled, then click
    await expect(home.settingsNavButton).toBeEnabled({ timeout: 10_000 });
    await home.settingsNavButton.click();

    // Verify the Settings page content is visible and Context Explorer is not
    await waitForSettingsPage(page);
    await expect(home.contextExplorerHeading).not.toBeVisible();

    // Ensure Context Explorer button is enabled, then click to navigate back
    await expect(home.contextExplorerNavButton).toBeEnabled({ timeout: 10_000 });
    await home.contextExplorerNavButton.click();

    // Verify Context Explorer is active again
    await waitForContextExplorerPage(page);
    await expect(home.settingsHeading).not.toBeVisible();
  });

  test('should load prompts without hanging fallbacks', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await waitForAppLoad(page);

    const promptsNavButton = page
      .getByRole('button', { name: /prompts/i })
      .or(page.getByRole('link', { name: /prompts/i }))
      .first();
    await expect(promptsNavButton).toBeVisible({ timeout: 10_000 });
    await promptsNavButton.click();

    await expect(page.getByRole('heading', { name: /prompt library/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Loading prompts/i)).toHaveCount(0);
  });

  test.describe('Panel Layout Basics', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await waitForAppLoad(page);
      await resetAppState(page);
      await page.reload();
      await waitForAppLoad(page);
    });

    test('should display default panel layout correctly', async ({ page }) => {
      await verifyDefaultLayout(page);
    });

    test('should recover from corrupted layout storage on reload', async ({ page }) => {
      await corruptLayoutStorage(page);
      await page.reload();
      await waitForAppLoad(page);
      await verifyDefaultLayout(page);
    });

    test('should normalize invalid persisted sizes on reload', async ({ page }) => {
      await page.evaluate(() => {
        localStorage.setItem(
          'panel-layout-store.v1',
          JSON.stringify({
            state: {
              sizes: [-10, 20, 'NaN'],
              showLeftPanel: true,
              showRightPanel: false,
              showConsole: false,
            },
            version: 2,
          })
        );
      });

      await page.reload();
      await waitForAppLoad(page);
      await verifyDefaultLayout(page);
    });

    test('should allow toggling left panel visibility', async ({ page }) => {
      const elements = getPanelElements(page);

      // Initially visible
      await expect(elements.leftPanel).toBeVisible();

      // Hide panel
      await togglePanelVisibility(elements.hideExplorerButton, elements.leftPanel, false);
      await expect(elements.showExplorerShim).toBeVisible();

      // Show panel again
      await togglePanelVisibility(elements.showExplorerShim, elements.leftPanel, true);
    });

    test('should allow toggling console panel visibility', async ({ page }) => {
      const elements = getPanelElements(page);

      // Initially hidden
      await expect(elements.consolePanel).not.toBeVisible();
      await expect(elements.showConsoleShim).toBeVisible();

      // Show console (now tabbed file editor)
      await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);
      await expect(page.getByText('No files open')).toBeVisible();
      await expect(
        page.getByText('Click on a file in Context Explorer to open it here')
      ).toBeVisible();

      // Hide console
      await togglePanelVisibility(elements.hideConsoleButton, elements.consolePanel, false);
    });

    test('should have resizable panels', async ({ page }) => {
      const elements = getPanelElements(page);

      // Verify the main left/right panel divider is present.
      // In current react-resizable-panels markup, this separator is vertical.
      const verticalResizeHandles = page.locator('[role="separator"][aria-orientation="vertical"]');
      await expect(verticalResizeHandles.first()).toBeVisible();

      // Show console to get vertical resize handle
      await elements.showConsoleShim.click();
      await expect(elements.consolePanel).toBeVisible();

      // Console divider between main content and console is horizontal.
      const horizontalResizeHandles = page.locator(
        '[role="separator"][aria-orientation="horizontal"]'
      );
      await expect(horizontalResizeHandles.first()).toBeVisible();
    });

    test('should maintain panel structure integrity', async ({ page }) => {
      const elements = getPanelElements(page);
      await elements.showConsoleShim.click();
      await elements.showRightPanelShim.click(); // Show tools panel first since it's hidden by default
      await elements.hideRightPanelButton.click(); // Now we can hide it
      await elements.showRightPanelShim.click(); // And show it again

      // Verify all main layout containers exist
      // Note: react-resizable-panels v4 uses id="panel-name" with data-panel="true" as boolean marker
      await expect(page.locator('#explorer-panel')).toBeAttached();
      await expect(page.locator('#middle-panel')).toBeAttached();
      await expect(page.locator('#tools-panel')).toBeAttached();
      await expect(page.locator('#main-content-panel')).toBeAttached();
      await expect(page.locator('#console-panel')).toBeAttached();

      // Verify panel group structure using correct data attributes.
      // The app layout contract is two resizable groups:
      // - Outer horizontal (left / middle / right)
      // - Inner vertical (main / console)
      // The tools panel content is not itself a resizable panel group.
      await expect(page.locator('[data-group]')).toHaveCount(2);
    });

    test('should handle rapid panel visibility changes', async ({ page }) => {
      const elements = getPanelElements(page);

      await elements.hideExplorerButton.click();
      await expect(elements.showExplorerShim).toBeVisible();

      await elements.showConsoleShim.click();
      await expect(elements.consolePanel).toBeVisible();

      await elements.showExplorerShim.click();
      await expect(elements.leftPanel).toBeVisible();

      await elements.hideConsoleButton.click();
      await expect(elements.consolePanel).not.toBeVisible();

      await verifyDefaultLayout(page);

      const layoutState = await page.evaluate(() => localStorage.getItem('panel-layout-store.v1'));
      expect(layoutState).not.toBeNull();

      const parsed = JSON.parse(layoutState ?? '{}') as {
        state?: { sizes?: unknown[] };
      };
      const sizes = Array.isArray(parsed.state?.sizes) ? parsed.state?.sizes : [];

      for (const size of sizes) {
        const numeric = typeof size === 'number' ? size : Number.NaN;
        expect(Number.isFinite(numeric)).toBe(true);
        expect(numeric).toBeGreaterThanOrEqual(0);
        expect(numeric).toBeLessThanOrEqual(100);
      }
    });
  });
});
