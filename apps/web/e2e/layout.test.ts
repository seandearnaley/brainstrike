import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import {
  AGENT_MAIN_PANEL_SELECTOR,
  AGENT_MIDDLE_PANEL_SELECTOR,
  AGENT_SIDEBAR_PANEL_SELECTOR,
  AGENT_WORKSPACE_PANEL_SELECTOR,
  CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR,
  CONTEXT_EXPLORER_MAIN_PANEL_SELECTOR,
  CONTEXT_EXPLORER_MIDDLE_PANEL_SELECTOR,
  corruptLayoutStorage,
  ensureRightPanelVisible,
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
    await home.goto({ waitForDatabase: false });

    // Ensure the main content area is visible
    await expect(page.locator('main')).toBeVisible();

    // Verify the page title is for Context Explorer by default and visible
    await expect(home.contextExplorerPageMarker).toBeVisible();
    // Ensure the Settings H1 is in the DOM but not visible
    await expect(home.settingsHeading).not.toBeVisible();
  });

  test('should have working sidebar navigation', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto({ waitForDatabase: false });

    // Ensure both buttons are present initially
    await expect(home.contextExplorerNavButton).toBeVisible();
    await expect(home.settingsNavButton).toBeVisible();

    // Initial state: Context Explorer is active, Settings is not
    await expect(home.contextExplorerPageMarker).toBeVisible();
    await expect(home.settingsHeading).not.toBeVisible();

    // Ensure Settings button is enabled, then click
    await expect(home.settingsNavButton).toBeEnabled({ timeout: 10_000 });
    await home.settingsNavButton.click();

    // Verify the Settings page content is visible and Context Explorer is not
    await waitForSettingsPage(page);
    await expect(home.contextExplorerPageMarker).not.toBeVisible();

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
      await waitForAppLoad(page, { waitForDatabase: false });
      await resetAppState(page);
      await page.reload();
      await waitForAppLoad(page, { waitForDatabase: false });
    });

    test('should display default panel layout correctly', async ({ page }) => {
      await verifyDefaultLayout(page);
    });

    test('should recover from corrupted layout storage on reload', async ({ page }) => {
      await corruptLayoutStorage(page);
      await page.reload();
      await waitForAppLoad(page, { waitForDatabase: false });
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
      await waitForAppLoad(page, { waitForDatabase: false });
      await verifyDefaultLayout(page);
    });

    test('should allow toggling left panel visibility', async ({ page }) => {
      const elements = getPanelElements(page);

      // Initially visible
      await expect(elements.leftPanel).toBeVisible();

      // Hide panel
      await togglePanelVisibility(elements.hideAgentPanelButton, elements.leftPanel, false);
      await expect(elements.showAgentPanelShim).toBeVisible();

      // Show panel again
      await togglePanelVisibility(elements.showAgentPanelShim, elements.leftPanel, true);
    });

    test('should render workspace tab host in the main Context Explorer surface', async ({
      page,
    }) => {
      await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
      await expect(page.getByRole('tabpanel', { name: /context explorer/i })).toBeVisible();
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);
    });

    test('should have resizable panels', async ({ page }) => {
      // Verify the main left/right panel divider is present.
      // In current react-resizable-panels markup, this separator is vertical.
      const verticalResizeHandles = page.locator('[role="separator"][aria-orientation="vertical"]');
      await expect(verticalResizeHandles.first()).toBeVisible();

      // The workspace-tabs surface removed the nested console/file-editor panel, so
      // only the main left/right shell divider is required here.
      await expect(page.locator('[data-testid="show-console-panel"]')).toHaveCount(0);
    });

    test('should maintain panel structure integrity', async ({ page }) => {
      const elements = getPanelElements(page);
      await ensureRightPanelVisible(page);
      await elements.hideRightPanelButton.click();
      await elements.showRightPanelShim.click();

      // Verify all main layout containers exist
      // The app now uses an outer agent workspace shell plus a nested context explorer layout.
      await expect(page.locator(AGENT_SIDEBAR_PANEL_SELECTOR)).toBeAttached();
      await expect(page.locator(AGENT_MIDDLE_PANEL_SELECTOR)).toBeAttached();
      await expect(page.locator(AGENT_WORKSPACE_PANEL_SELECTOR)).toBeAttached();
      await expect(page.locator(AGENT_MAIN_PANEL_SELECTOR)).toBeAttached();
      await expect(page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR)).toBeAttached();
      await expect(page.locator(CONTEXT_EXPLORER_MIDDLE_PANEL_SELECTOR)).toBeAttached();
      await expect(page.locator(CONTEXT_EXPLORER_MAIN_PANEL_SELECTOR)).toBeAttached();
      await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeAttached();

      // Verify the shell still exposes the expected nested resizable groups.
      // The exact count can vary with wrapper groups created by the panel library,
      // but the promoted shell must still include the outer workspace plus the
      // inner horizontal and vertical explorer groups.
      expect(await page.locator('[data-group]').count()).toBeGreaterThanOrEqual(3);
    });

    test('should handle rapid panel visibility changes', async ({ page }) => {
      const elements = getPanelElements(page);

      await elements.hideAgentPanelButton.click();
      await expect(elements.showAgentPanelShim).toBeVisible();

      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);

      await elements.showAgentPanelShim.click();
      await expect(elements.leftPanel).toBeVisible();

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
