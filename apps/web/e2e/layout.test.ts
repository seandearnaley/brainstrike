import { expect, test } from '@playwright/test';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import {
  AGENT_MAIN_PANEL_SELECTOR,
  AGENT_MIDDLE_PANEL_SELECTOR,
  AGENT_SIDEBAR_PANEL_SELECTOR,
  AGENT_WORKSPACE_PANEL_SELECTOR,
  CONTEXT_EXPLORER_MAIN_PANEL_SELECTOR,
  CONTEXT_EXPLORER_MIDDLE_PANEL_SELECTOR,
  CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR,
  corruptLayoutStorage,
  ensureRightPanelVisible,
  getPanelElements,
  togglePanelVisibility,
  verifyDefaultLayout,
  waitForAppLoad,
  waitForContextExplorerPage,
} from './utils/layout-helpers';

test.describe('Application Layout', () => {
  test('should render the main layout correctly', { tag: '@web-smoke' }, async ({ page }) => {
    const home = new HomePage(page);
    await home.goto({ waitForDatabase: false });

    // Ensure the main content area is visible
    await expect(page.locator('main')).toBeVisible();

    // Verify the page title is for Context Explorer by default and visible
    await expect(home.contextExplorerPageMarker).toBeVisible();
    // Ensure the Settings H1 is in the DOM but not visible
    await expect(home.settingsHeading).not.toBeVisible();
  });

  test('should open Settings from the profile menu and return to the workspace', {
    tag: '@web-smoke',
  }, async ({ page }) => {
    const home = new HomePage(page);
    await home.goto({ waitForDatabase: false });

    // Settings is not a sidebar destination — it launches from the profile menu.
    await expect(home.contextExplorerNavButton).toBeVisible();
    await expect(home.profileMenuButton).toBeVisible();

    // Initial state: Context Explorer is active, Settings is closed
    await expect(home.contextExplorerPageMarker).toBeVisible();
    await expect(home.settingsHeading).not.toBeVisible();

    await expect(home.profileMenuButton).toBeEnabled({ timeout: 10_000 });
    await home.navigateToSettings();

    // Settings is a keep-mounted route (BST-1668): the explorer route is
    // `display: none` underneath it, so its active-page marker is hidden.
    await expect(home.contextExplorerPageMarker).not.toBeVisible();

    await home.leaveSettings();

    // Verify Context Explorer is active again
    await waitForContextExplorerPage(page);
    await expect(home.settingsHeading).not.toBeVisible();
  });

  test('should load prompts in the agent sidebar without leaving the workspace', async ({
    page,
  }) => {
    // The workbench region only mounts once the lazily-initialized database is
    // ready, which can take the full CI DB-init budget (~55s). Stay on the fast
    // functional path (goto without a DB-readiness wait, per the e2e readiness
    // contract) and let the region assertion absorb the background init instead;
    // the connected manager renders its loading placeholder in the meantime.
    test.setTimeout(120_000);
    const home = new HomePage(page);
    await home.goto({ waitForDatabase: false });

    const promptsTab = page.getByTestId('prompts-tab-trigger');
    await expect(promptsTab).toBeVisible({ timeout: 10_000 });
    await promptsTab.click();

    await expect(page.getByRole('region', { name: 'Prompt workbench' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(home.contextExplorerPageMarker).toBeVisible();
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
              showConsole: false,
              showLeftPanel: true,
              showRightPanel: false,
              sizes: [-10, 20, 'NaN'],
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

    test('should render the Files workspace app surface with its tab in the header strip', async ({
      page,
    }) => {
      await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
      // BST-1258: the app tab is labeled "Files"; its tabpanel takes that name.
      await expect(page.getByRole('tabpanel', { name: /files/i })).toBeVisible();
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

    test('aligns workspace headers and lets the Library resize from 180px through 70%', async ({
      page,
    }) => {
      const libraryPanel = page.locator(AGENT_SIDEBAR_PANEL_SELECTOR).first();
      const libraryResizeHandle = page.getByRole('separator', { name: 'Resize Library panel' });
      const handleBox = await libraryResizeHandle.boundingBox();
      if (!handleBox) {
        throw new Error('Library resize handle has no geometry');
      }

      const headerGeometry = await Promise.all([
        page
          .locator('#agent-workspace-explorer-panel [data-testid="left-panel-header"]')
          .first()
          .boundingBox(),
        page.getByTestId('assistant-thread-tab-strip').boundingBox(),
        page
          .locator('#agent-workspace-tools-panel [data-testid="right-panel-header"]')
          .first()
          .boundingBox(),
      ]);
      if (headerGeometry.some((box) => box === null)) {
        throw new Error('A primary workspace header has no geometry');
      }
      const headerBoxes = headerGeometry.filter((box) => box !== null);
      // All panel chrome sits on the 36px (h-9) rhythm established by #1732; the
      // class-name lock lives in packages/ui ide-layout.test.tsx.
      expect(Math.max(...headerBoxes.map((box) => box.height))).toBeLessThanOrEqual(36.5);
      expect(Math.min(...headerBoxes.map((box) => box.height))).toBeGreaterThanOrEqual(35.5);
      expect(
        Math.max(...headerBoxes.map((box) => box.y)) - Math.min(...headerBoxes.map((box) => box.y))
      ).toBeLessThanOrEqual(1);

      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        (page.viewportSize()?.width ?? 1440) - 2,
        handleBox.y + handleBox.height / 2,
        { steps: 24 }
      );
      await page.mouse.up();

      const maximumPercent = await libraryPanel.evaluate((panel) => {
        const group = panel.closest('[data-group]');
        if (!group) {
          throw new Error('Library panel group is missing');
        }
        return (panel.getBoundingClientRect().width / group.getBoundingClientRect().width) * 100;
      });
      expect(maximumPercent).toBeGreaterThanOrEqual(68);
      expect(maximumPercent).toBeLessThanOrEqual(70.5);

      const maximumHandleBox = await libraryResizeHandle.boundingBox();
      if (!maximumHandleBox) {
        throw new Error('Library resize handle disappeared after expansion');
      }
      const libraryGroupLeft = await libraryPanel.evaluate((panel) => {
        const group = panel.closest('[data-group]');
        if (!group) {
          throw new Error('Library panel group is missing');
        }
        return group.getBoundingClientRect().left;
      });
      await page.mouse.move(
        maximumHandleBox.x + maximumHandleBox.width / 2,
        maximumHandleBox.y + maximumHandleBox.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(
        libraryGroupLeft + 140,
        maximumHandleBox.y + maximumHandleBox.height / 2,
        { steps: 24 }
      );
      await page.mouse.up();

      const minimumWidth = await libraryPanel.evaluate(
        (panel) => panel.getBoundingClientRect().width
      );
      expect(minimumWidth).toBeGreaterThanOrEqual(179);
      expect(minimumWidth).toBeLessThanOrEqual(181);
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
      await expect(page.locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR)).toBeAttached();
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
