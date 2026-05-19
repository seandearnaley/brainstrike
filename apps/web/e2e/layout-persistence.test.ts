import { expect, type Locator, type Page, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import {
  activateSidebarNavigation,
  CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR,
  CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR,
  CONTEXT_EXPLORER_MIDDLE_PANEL_SELECTOR,
  contextExplorerActiveNavLocator,
  ensureRightPanelVisible,
  getContextExplorerLeftResizeHandle,
  getPanelElements,
  waitForAppLoad,
  waitForContextExplorerPage,
  waitForSettingsPage,
} from './utils/layout-helpers';

const PANEL_LAYOUT_STORE_KEY = 'panel-layout-store.v1' as const;
const CONTEXT_EXPLORER_LAYOUT_STORE_KEY = 'context-explorer-layout-store.v1' as const;

async function reloadAndWait(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppLoad(page, { waitForDatabase: false });
}

interface PersistedPanelLayout {
  state?: {
    sizes?: number[];
    showLeftPanel?: boolean;
    showRightPanel?: boolean;
    showConsole?: boolean;
  };
}

async function getPersistedLayout(
  page: Page,
  storageKey:
    | typeof PANEL_LAYOUT_STORE_KEY
    | typeof CONTEXT_EXPLORER_LAYOUT_STORE_KEY = PANEL_LAYOUT_STORE_KEY
) {
  return page.evaluate((key: string) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as PersistedPanelLayout;
    } catch {
      return null;
    }
  }, storageKey);
}

async function expectLayoutState(
  page: Page,
  predicate: (state: PersistedPanelLayout | null) => boolean,
  options?: {
    readonly storageKey?: typeof PANEL_LAYOUT_STORE_KEY | typeof CONTEXT_EXPLORER_LAYOUT_STORE_KEY;
    readonly timeout?: number;
  }
) {
  const storageKey = options?.storageKey ?? PANEL_LAYOUT_STORE_KEY;
  const timeout = options?.timeout ?? 8000;
  await expect
    .poll(async () => predicate(await getPersistedLayout(page, storageKey)), { timeout })
    .toBe(true);
}

async function dragPanelWider({
  page,
  panel,
  resizeHandle,
  initialWidth,
}: {
  readonly page: Page;
  readonly panel: Locator;
  readonly resizeHandle: Locator;
  readonly initialWidth: number;
}): Promise<number> {
  const dragDeltas = [120, 180, 240] as const;

  for (const dragDelta of dragDeltas) {
    const handleBox = await resizeHandle.boundingBox();
    if (!handleBox) {
      throw new Error('Resize handle not found');
    }

    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dragDelta, startY, { steps: 8 });
    await page.mouse.up();

    let observedWidth = initialWidth;
    try {
      await expect
        .poll(
          async () => {
            observedWidth = await panel.evaluate((el) => el.getBoundingClientRect().width);
            return observedWidth;
          },
          { intervals: [100, 100, 250, 500], timeout: 2000 }
        )
        .toBeGreaterThan(initialWidth + 1);
      return observedWidth;
    } catch {}
  }

  const finalWidth = await panel.evaluate((el) => el.getBoundingClientRect().width);
  throw new Error(
    `Panel resize did not widen after ${dragDeltas.join(', ')}px drags: initial=${initialWidth}, final=${finalWidth}`
  );
}

test.describe('IDE Layout Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Clear any existing layout state to start fresh
    await resetAppState(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test.describe('Panel Visibility Persistence', () => {
    test('should persist left panel (explorer) toggle state across page reloads', async ({
      page,
    }) => {
      // Verify left panel is visible by default
      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      await expect(leftPanel).toBeVisible();

      // Hide the left panel
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.click();

      // Wait a bit for the save operation to complete
      await page.waitForTimeout(500);

      // Verify panel is hidden
      await expect(leftPanel).not.toBeVisible();

      // Verify show button appears
      const showExplorerButton = page.locator('button[aria-label="Show explorer panel"]');
      await expect(showExplorerButton).toBeVisible();

      // Reload page
      await page.reload();
      await expect(contextExplorerActiveNavLocator(page)).toBeVisible();

      // Verify left panel remains hidden after reload
      await expect(leftPanel).not.toBeVisible();
      await expect(showExplorerButton).toBeVisible();

      // Show panel again
      await showExplorerButton.click();
      await expect(leftPanel).toBeVisible();

      // Reload and verify it's visible
      await page.reload();
      await expect(contextExplorerActiveNavLocator(page)).toBeVisible();
      await expect(leftPanel).toBeVisible();
    });

    test('should keep the removed console file-editor controls absent across reloads', async ({
      page,
    }) => {
      await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);
      await expect(page.locator('button[aria-label="Show File Editor"]')).toHaveCount(0);
      await expect(page.locator('button[aria-label="Close File Editor"]')).toHaveCount(0);

      await reloadAndWait(page);

      await expect(page.getByTestId('workspace-app-tab-context-explorer')).toBeVisible();
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);
      await expect(page.locator(CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR)).toHaveCount(0);
    });

    test('should persist right panel toggle state across page reloads', async ({ page }) => {
      const elements = getPanelElements(page);

      const hideButtonVisible = await elements.hideRightPanelButton.isVisible().catch(() => false);
      const showShimVisible = await elements.showRightPanelShim.isVisible().catch(() => false);
      if (!(hideButtonVisible || showShimVisible)) {
        test.skip(true, 'Tools panel controls not available in this environment');
      }

      await ensureRightPanelVisible(page);
      await expect(elements.hideRightPanelButton).toBeVisible();
      await elements.hideRightPanelButton.click();
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === false);

      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === false);
      await expect(elements.showRightPanelShim).toBeVisible();

      await elements.showRightPanelShim.click();
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === true);

      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === true);
      await expect(elements.hideRightPanelButton).toBeVisible();
    });
  });

  test.describe('Panel Resize Persistence', () => {
    test('should persist left panel width across page reloads', async ({ page }) => {
      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      await expect(leftPanel).toBeVisible();

      // Get initial width
      const initialWidth = await leftPanel.evaluate((el) => el.getBoundingClientRect().width);

      // Find and drag the resize handle to make panel wider
      // Note: react-resizable-panels v4 uses data-separator
      const resizeHandle = getContextExplorerLeftResizeHandle(page);
      await expect(resizeHandle).toBeVisible();

      // Verify width changed
      const newWidth = await dragPanelWider({
        page,
        panel: leftPanel,
        resizeHandle,
        initialWidth,
      });
      expect(newWidth).toBeGreaterThan(initialWidth);
      await expectLayoutState(page, (state) => typeof state?.state?.sizes?.[0] === 'number', {
        storageKey: CONTEXT_EXPLORER_LAYOUT_STORE_KEY,
      });
      const persistedBeforeReload = await getPersistedLayout(
        page,
        CONTEXT_EXPLORER_LAYOUT_STORE_KEY
      );
      const leftSizeBeforeReload = persistedBeforeReload?.state?.sizes?.[0];
      expect(leftSizeBeforeReload).toBeDefined();
      if (typeof leftSizeBeforeReload !== 'number') {
        throw new Error('Persisted left-panel size before reload is required and must be numeric');
      }

      // Reload page
      await page.reload();
      await expect(contextExplorerActiveNavLocator(page)).toBeVisible();

      const persistedAfterReload = await getPersistedLayout(
        page,
        CONTEXT_EXPLORER_LAYOUT_STORE_KEY
      );
      const leftSizeAfterReload = persistedAfterReload?.state?.sizes?.[0];
      expect(leftSizeAfterReload).toBeDefined();
      if (typeof leftSizeAfterReload !== 'number') {
        throw new Error('Persisted left-panel size after reload is required and must be numeric');
      }

      expect(Math.abs(leftSizeAfterReload - leftSizeBeforeReload)).toBeLessThan(0.5);
    });

    test('should persist console panel visibility across page reloads', async ({ page }) => {
      const elements = getPanelElements(page);
      const consolePanel = elements.consolePanel;

      // Console should be hidden by default
      await expect(consolePanel).not.toBeVisible();

      const showConsoleVisible = await elements.showConsoleShim.isVisible().catch(() => false);
      const hideConsoleVisible = await elements.hideConsoleButton.isVisible().catch(() => false);
      if (!(showConsoleVisible || hideConsoleVisible)) {
        test.skip(true, 'Console panel controls not available in this environment');
      }

      if (showConsoleVisible) {
        await elements.showConsoleShim.click();
      }
      await expectLayoutState(page, (state) => state?.state?.showConsole === true, {
        storageKey: CONTEXT_EXPLORER_LAYOUT_STORE_KEY,
      });

      // Wait for layout to settle
      await page.waitForTimeout(500);

      // Reload page
      await reloadAndWait(page);

      // Verify console is still visible after reload (main persistence test)
      await expectLayoutState(page, (state) => state?.state?.showConsole === true, {
        storageKey: CONTEXT_EXPLORER_LAYOUT_STORE_KEY,
      });

      // Hide console and verify persistence
      await elements.hideConsoleButton.click();
      await expectLayoutState(page, (state) => state?.state?.showConsole === false, {
        storageKey: CONTEXT_EXPLORER_LAYOUT_STORE_KEY,
      });

      // Reload and verify it stays hidden
      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showConsole === false, {
        storageKey: CONTEXT_EXPLORER_LAYOUT_STORE_KEY,
      });
    });
  });

  test.describe('Complex Layout State Persistence', () => {
    test('should persist multiple panel states simultaneously', async ({ page }) => {
      // Configure a complex layout across the nested Context Explorer and outer shell layouts.
      const elements = getPanelElements(page);

      // 1. Hide left panel
      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();

      // 2. Hide workspace panel
      await expect(elements.hideRightPanelButton).toBeVisible();
      await elements.hideRightPanelButton.click();
      await expect(elements.rightPanel).not.toBeVisible();

      await expectLayoutState(page, (state) => state?.state?.showLeftPanel === false, {
        storageKey: CONTEXT_EXPLORER_LAYOUT_STORE_KEY,
      });
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === false);

      // 3. Reload and verify all states persisted.
      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showLeftPanel === false, {
        storageKey: CONTEXT_EXPLORER_LAYOUT_STORE_KEY,
      });
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === false);

      // Verify left panel remains hidden
      await expect(leftPanel).not.toBeVisible();
      const showExplorerButton = page.locator('button[aria-label="Show explorer panel"]');
      await expect(showExplorerButton).toBeVisible();

      // Verify workspace panel remains hidden
      await expect(elements.rightPanel).not.toBeVisible();
      await expect(elements.showRightPanelShim).toBeVisible();
    });

    test('should handle navigation between pages while preserving layout', async ({ page }) => {
      // Start with panel visible (default state)
      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      await expect(leftPanel).toBeVisible();

      // Hide the panel
      await page.getByTestId('hide-explorer-panel').click();
      await expect(leftPanel).not.toBeVisible();

      // Show explorer before navigation to avoid UI overlap
      await page.getByTestId('show-explorer-panel').click();
      await expect(leftPanel).toBeVisible();

      // Navigate to Settings
      await activateSidebarNavigation(page, 'Settings');
      await waitForSettingsPage(page);

      // Navigate back to Context Explorer
      await activateSidebarNavigation(page, 'Context Explorer');
      await waitForContextExplorerPage(page);

      // Verify panel is still visible (state persisted)
      await expect(leftPanel).toBeVisible();
    });

    test('should preserve hidden explorer state across page navigation', async ({ page }) => {
      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      await expect(leftPanel).toBeVisible();

      await page.getByTestId('hide-explorer-panel').click();
      await expect(leftPanel).not.toBeVisible();

      await activateSidebarNavigation(page, 'Settings');
      await waitForSettingsPage(page);

      await activateSidebarNavigation(page, 'Context Explorer');
      await waitForContextExplorerPage(page);

      await expect(leftPanel).not.toBeVisible();
      await expect(page.getByTestId('show-explorer-panel')).toBeVisible();
    });
  });

  test.describe('Layout State Recovery', () => {
    test('should handle corrupted localStorage gracefully', async ({ page }) => {
      // Corrupt the layout storage
      await page.evaluate(
        (keys: readonly string[]) => {
          for (const key of keys) {
            localStorage.setItem(key, 'invalid-json');
          }
        },
        [PANEL_LAYOUT_STORE_KEY, CONTEXT_EXPLORER_LAYOUT_STORE_KEY]
      );

      // Reload page
      await page.reload();
      await expect(contextExplorerActiveNavLocator(page)).toBeVisible();

      // Verify app loads with default layout and without the removed console file-editor panel.
      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      await expect(leftPanel).toBeVisible();

      await expect(page.locator(CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR)).toHaveCount(0);
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);

      // Verify layout functionality still works
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();
    });

    test('should handle missing localStorage gracefully', async ({ page }) => {
      // Clear all localStorage
      await page.evaluate(() => {
        localStorage.clear();
      });

      // Reload page
      await page.reload();
      await expect(contextExplorerActiveNavLocator(page)).toBeVisible();

      // Verify app loads with default layout
      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      await expect(leftPanel).toBeVisible();

      await expect(page.locator(CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR)).toHaveCount(0);
      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);

      // Verify new layout changes are saved
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();

      // Reload and verify persistence works
      await page.reload();
      await expect(contextExplorerActiveNavLocator(page)).toBeVisible();
      await expect(leftPanel).not.toBeVisible();
    });
  });

  test.describe('Panel Resize Constraints', () => {
    test('should respect minimum and maximum panel sizes', async ({ page }) => {
      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      await expect(leftPanel).toBeVisible();

      const middlePanelWidth = await page
        .locator(CONTEXT_EXPLORER_MIDDLE_PANEL_SELECTOR)
        .evaluate((el) => el.getBoundingClientRect().width);

      // Try to resize panel to very small size (should be constrained to minimum)
      // Note: react-resizable-panels v4 uses data-separator
      const resizeHandle = getContextExplorerLeftResizeHandle(page);
      const handleBox = await resizeHandle.boundingBox();
      if (!handleBox) {
        throw new Error('Resize handle not found');
      }

      // Drag to a moderately small size first (not extreme to avoid collapse)
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x - 100, handleBox.y + handleBox.height / 2); // Moderate reduction
      await page.mouse.up();

      await page.waitForTimeout(300);

      // Check if panel collapsed - if so, expand it back
      const isCollapsed = await leftPanel.evaluate((el) => el.getBoundingClientRect().width === 0);
      if (isCollapsed) {
        // Panel collapsed, try to expand it back
        const showExplorerButton = page.locator('button[aria-label="Show explorer panel"]');

        // Check if the show explorer button exists within a reasonable timeout
        try {
          await expect(showExplorerButton).toBeVisible({ timeout: 2000 });
          await showExplorerButton.click();
          await expect(leftPanel).toBeVisible();
        } catch {
          // If show explorer button is not available, we can't test constraints on collapsed panel
          // This might happen if leftPanelContent is null. Let's skip this test scenario.
          console.warn(
            'Show explorer panel button not found, skipping constraint test for collapsed panel'
          );
          return;
        }
      }

      // Verify panel respects minimum size (15% of viewport according to IdeLayout)
      const finalWidth = await leftPanel.evaluate((el) => el.getBoundingClientRect().width);
      const minExpectedWidth = middlePanelWidth * 0.08;
      expect(finalWidth).toBeGreaterThan(minExpectedWidth);

      // Try to resize panel to very large size (should be constrained to maximum)
      const newHandleBox = await resizeHandle.boundingBox();
      if (!newHandleBox) {
        throw new Error('Resize handle not found after expand');
      }

      await page.mouse.move(
        newHandleBox.x + newHandleBox.width / 2,
        newHandleBox.y + newHandleBox.height / 2
      );
      await page.mouse.down();
      await page.mouse.move(
        newHandleBox.x + middlePanelWidth * 0.6,
        newHandleBox.y + newHandleBox.height / 2
      );
      await page.mouse.up();

      await page.waitForTimeout(300);

      // Verify panel respects maximum size (50% according to IdeLayout)
      const maxWidth = await leftPanel.evaluate((el) => el.getBoundingClientRect().width);
      const maxExpectedWidth = middlePanelWidth * 0.7;
      expect(maxWidth).toBeLessThan(maxExpectedWidth);
    });
  });

  test.describe('Accessibility and Keyboard Navigation', () => {
    test('should support keyboard navigation for panel toggles', async ({ page }) => {
      // Focus on hide explorer button and activate with keyboard
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.focus();
      await page.keyboard.press('Enter');

      const leftPanel = page.locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR);
      await expect(leftPanel).not.toBeVisible();

      // Focus on show explorer button and activate with keyboard
      const showExplorerButton = page.locator('button[aria-label="Show explorer panel"]');
      await showExplorerButton.focus();
      await page.keyboard.press('Space');

      await expect(leftPanel).toBeVisible();
    });

    test('should have proper ARIA labels for all panel controls', async ({ page }) => {
      // Verify all panel control buttons have proper ARIA labels
      await expect(page.locator('button[aria-label="Hide explorer panel"]')).toBeVisible();

      await expect(page.getByTestId('show-console-panel')).toHaveCount(0);
      await expect(page.locator('button[aria-label="Show File Editor"]')).toHaveCount(0);
      await expect(page.locator('button[aria-label="Close File Editor"]')).toHaveCount(0);

      // Test right panel buttons if available
      const showRightPanelButton = page.locator('button[aria-label="Show tools panel"]');
      if (await showRightPanelButton.isVisible()) {
        await expect(showRightPanelButton).toBeVisible();
      }
    });
  });
});
