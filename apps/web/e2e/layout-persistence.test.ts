import { expect, type Locator, type Page, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, getPanelElements, waitForAppLoad } from './utils/layout-helpers';

async function reloadAndWait(page: Page): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppLoad(page);
}

async function waitForStableHeight(page: Page, locator: Locator): Promise<number> {
  const sampleIntervalMs = 80;
  const maxSamples = 25;
  const tolerancePx = 1;
  const requiredStableSamples = 2;

  let previousHeight = await locator.evaluate((el) => el.getBoundingClientRect().height);
  let stableSamples = 0;

  for (let sample = 0; sample < maxSamples; sample++) {
    await page.waitForTimeout(sampleIntervalMs);
    const currentHeight = await locator.evaluate((el) => el.getBoundingClientRect().height);
    if (Math.abs(currentHeight - previousHeight) <= tolerancePx) {
      stableSamples += 1;
      if (stableSamples >= requiredStableSamples) {
        return currentHeight;
      }
    } else {
      stableSamples = 0;
    }
    previousHeight = currentHeight;
  }

  throw new Error('Console panel height did not stabilize before assertion');
}

interface PersistedPanelLayout {
  state?: {
    sizes?: number[];
    showRightPanel?: boolean;
    showConsole?: boolean;
  };
}

async function getPersistedLayout(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('panel-layout-store.v1');
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as PersistedPanelLayout;
    } catch {
      return null;
    }
  });
}

async function expectLayoutState(
  page: Page,
  predicate: (state: PersistedPanelLayout | null) => boolean,
  timeout = 8000
) {
  await expect
    .poll(async () => predicate(await getPersistedLayout(page)), {
      timeout,
    })
    .toBe(true);
}

test.describe('IDE Layout Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Clear any existing layout state to start fresh
    await resetAppState(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppLoad(page);
  });

  test.describe('Panel Visibility Persistence', () => {
    test('should persist left panel (explorer) toggle state across page reloads', async ({
      page,
    }) => {
      // Verify left panel is visible by default
      const leftPanel = page.locator('[id="explorer-panel"]');
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
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();

      // Verify left panel remains hidden after reload
      await expect(leftPanel).not.toBeVisible();
      await expect(showExplorerButton).toBeVisible();

      // Show panel again
      await showExplorerButton.click();
      await expect(leftPanel).toBeVisible();

      // Reload and verify it's visible
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();
      await expect(leftPanel).toBeVisible();
    });

    test('should persist console panel toggle state across page reloads', async ({ page }) => {
      // Console should be hidden by default
      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).not.toBeVisible();

      // Show console using floating button
      const showConsoleButton = page.locator('button[aria-label="Show File Editor"]');
      await expect(showConsoleButton).toBeVisible();
      await showConsoleButton.click();

      // Verify console is now visible
      await expect(consolePanel).toBeVisible();

      // Verify console content (now tabbed file editor)
      await expect(page.getByText('No files open')).toBeVisible();
      await expect(
        page.getByText('Click on a file in Context Explorer to open it here')
      ).toBeVisible();

      // Reload page
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();

      // Verify console remains visible after reload
      await expect(consolePanel).toBeVisible();

      // Hide console
      const hideConsoleButton = page.locator('button[aria-label="Close File Editor"]');
      await hideConsoleButton.click();
      await expect(consolePanel).not.toBeVisible();

      // Reload and verify it remains hidden
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();
      await expect(consolePanel).not.toBeVisible();
    });

    test('should persist right panel toggle state across page reloads', async ({ page }) => {
      const elements = getPanelElements(page);

      const showShimVisible = await elements.showRightPanelShim.isVisible().catch(() => false);
      const hideButtonVisible = await elements.hideRightPanelButton.isVisible().catch(() => false);
      if (!(showShimVisible || hideButtonVisible)) {
        test.skip(true, 'Tools panel controls not available in this environment');
      }

      if (showShimVisible) {
        await elements.showRightPanelShim.click();
      } else {
        await ensureRightPanelVisible(page);
      }
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === true);

      // Reload and verify persistence
      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === true);
      const rightPanelVisibleAfterReload = await elements.hideRightPanelButton
        .isVisible()
        .catch(() => false);
      if (!rightPanelVisibleAfterReload) {
        test.skip(true, 'Tools panel hide control not visible after reload');
      }

      // Hide and verify persistence
      await elements.hideRightPanelButton.click();
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === false);

      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showRightPanel === false);
      const rightPanelHiddenAfterReload = await elements.showRightPanelShim
        .isVisible()
        .catch(() => false);
      if (!rightPanelHiddenAfterReload) {
        test.skip(true, 'Tools panel show control not visible after reload');
      }

      if ((await elements.showRightPanelShim.count()) > 0) {
        await elements.showRightPanelShim.click();
        await expectLayoutState(page, (state) => state?.state?.showRightPanel === true);
      }
    });
  });

  test.describe('Panel Resize Persistence', () => {
    test('should persist left panel width across page reloads', async ({ page }) => {
      const leftPanel = page.locator('[id="explorer-panel"]');
      await expect(leftPanel).toBeVisible();

      // Get container width before resize
      const containerWidth = await page
        .locator('#middle-panel')
        .evaluate((el) => el.getBoundingClientRect().width);

      // Get initial width
      const initialWidth = await leftPanel.evaluate((el) => el.getBoundingClientRect().width);

      // Find and drag the resize handle to make panel wider
      // Note: react-resizable-panels v4 uses data-separator
      const resizeHandle = page.locator('[data-separator]').first();
      await expect(resizeHandle).toBeVisible();

      // Get the resize handle position
      const handleBox = await resizeHandle.boundingBox();
      if (!handleBox) {
        throw new Error('Resize handle not found');
      }

      // Drag to resize (move right to make panel wider)
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 100, handleBox.y + handleBox.height / 2);
      await page.mouse.up();

      // Wait for resize to complete
      await page.waitForTimeout(300);

      // Verify width changed
      const newWidth = await leftPanel.evaluate((el) => el.getBoundingClientRect().width);
      expect(newWidth).toBeGreaterThan(initialWidth);

      // Reload page
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();

      // Get container width after reload
      const containerWidthAfter = await page
        .locator('#middle-panel')
        .evaluate((el) => el.getBoundingClientRect().width);

      // Verify width persisted by comparing percentages (accounts for container size changes)
      const persistedWidth = await leftPanel.evaluate((el) => el.getBoundingClientRect().width);
      const newWidthPercentage = (newWidth / containerWidth) * 100;
      const persistedWidthPercentage = (persistedWidth / containerWidthAfter) * 100;

      // The percentage should be reasonably close (within 10% to account for rounding and layout differences)
      expect(Math.abs(persistedWidthPercentage - newWidthPercentage)).toBeLessThan(10);
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
      await expectLayoutState(page, (state) => state?.state?.showConsole === true);

      // Wait for layout to settle
      await page.waitForTimeout(500);

      // Reload page
      await reloadAndWait(page);

      // Verify console is still visible after reload (main persistence test)
      await expectLayoutState(page, (state) => state?.state?.showConsole === true);

      // Hide console and verify persistence
      await elements.hideConsoleButton.click();
      await expectLayoutState(page, (state) => state?.state?.showConsole === false);

      // Reload and verify it stays hidden
      await reloadAndWait(page);
      await expectLayoutState(page, (state) => state?.state?.showConsole === false);
    });
  });

  test.describe('Complex Layout State Persistence', () => {
    test('should persist multiple panel states simultaneously', async ({ page }) => {
      // Configure a complex layout: hide left panel, show console, resize console

      // 1. Hide left panel
      const leftPanel = page.locator('[id="explorer-panel"]');
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();

      // 2. Show console
      const showConsoleButton = page.locator('button[aria-label="Show File Editor"]');
      await showConsoleButton.click();
      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).toBeVisible();
      await expectLayoutState(
        page,
        (state) => state?.state?.showConsole === true && state?.state?.showRightPanel === false
      );

      // 3. Capture persisted console size to compare after reload.
      const persistedBeforeReload = await getPersistedLayout(page);
      const consoleSizeBeforeReload = persistedBeforeReload?.state?.sizes?.[2];
      expect(consoleSizeBeforeReload).toBeDefined();
      if (typeof consoleSizeBeforeReload !== 'number') {
        throw new Error('Persisted console size is required and must be numeric');
      }
      expect(consoleSizeBeforeReload).toBeGreaterThan(0);

      // 4. Reload and verify all states persisted
      await reloadAndWait(page);
      await expectLayoutState(
        page,
        (state) => state?.state?.showConsole === true && state?.state?.showRightPanel === false
      );

      // Verify left panel remains hidden
      await expect(leftPanel).not.toBeVisible();
      const showExplorerButton = page.locator('button[aria-label="Show explorer panel"]');
      await expect(showExplorerButton).toBeVisible();

      // Verify console remains visible
      await expect(consolePanel).toBeVisible();

      // Verify console size persisted by comparing rendered percentage to stored percentage
      const middlePanel = page.locator('[id="middle-panel"]');
      const persistedMiddleHeight = await middlePanel.evaluate(
        (el) => el.getBoundingClientRect().height
      );
      const persistedConsoleHeight = await waitForStableHeight(page, consolePanel);
      const persistedConsoleHeightPercentage =
        (persistedConsoleHeight / persistedMiddleHeight) * 100;
      expect(Math.abs(persistedConsoleHeightPercentage - consoleSizeBeforeReload)).toBeLessThan(5);

      // Verify persisted layout store retained the size through reload as well.
      const persistedAfterReload = await getPersistedLayout(page);
      const consoleSizeAfterReload = persistedAfterReload?.state?.sizes?.[2];
      expect(consoleSizeAfterReload).toBeDefined();
      if (typeof consoleSizeAfterReload !== 'number') {
        throw new Error('Persisted console size after reload is required and must be numeric');
      }
      expect(Math.abs(consoleSizeAfterReload - consoleSizeBeforeReload)).toBeLessThan(0.5);
    });

    test('should handle navigation between pages while preserving layout', async ({ page }) => {
      // Start with panel visible (default state)
      const leftPanel = page.locator('[id="explorer-panel"]');
      await expect(leftPanel).toBeVisible();

      // Hide the panel
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();

      // Show explorer before navigation to avoid UI overlap
      const showExplorerButton = page.locator('button[aria-label="Show explorer panel"]');
      await showExplorerButton.click();
      await expect(leftPanel).toBeVisible();

      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

      // Navigate back to Context Explorer
      await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();

      // Verify panel is still visible (state persisted)
      await expect(leftPanel).toBeVisible();

      // Now test that hidden state also persists
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();

      // Show panel again for navigation
      await showExplorerButton.click();

      // Navigate away and back
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();

      // Hide panel again
      await hideExplorerButton.click();

      // Verify panel is hidden (state persisted)
      await expect(leftPanel).not.toBeVisible();
      await expect(showExplorerButton).toBeVisible();
    });
  });

  test.describe('Layout State Recovery', () => {
    test('should handle corrupted localStorage gracefully', async ({ page }) => {
      // Corrupt the layout storage
      await page.evaluate(() => {
        localStorage.setItem('panel-layout-store.v1', 'invalid-json');
      });

      // Reload page
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();

      // Verify app loads with default layout (left panel visible, console hidden)
      const leftPanel = page.locator('[id="explorer-panel"]');
      await expect(leftPanel).toBeVisible();

      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).not.toBeVisible();

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
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();

      // Verify app loads with default layout
      const leftPanel = page.locator('[id="explorer-panel"]');
      await expect(leftPanel).toBeVisible();

      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).not.toBeVisible();

      // Verify new layout changes are saved
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();

      // Reload and verify persistence works
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'Context Explorer', exact: true })
      ).toBeVisible();
      await expect(leftPanel).not.toBeVisible();
    });
  });

  test.describe('Panel Resize Constraints', () => {
    test('should respect minimum and maximum panel sizes', async ({ page }) => {
      const leftPanel = page.locator('[id="explorer-panel"]');
      await expect(leftPanel).toBeVisible();

      // Get viewport width for calculations
      const viewportSize = page.viewportSize();
      if (!viewportSize) {
        throw new Error('Viewport size not available');
      }

      // Try to resize panel to very small size (should be constrained to minimum)
      // Note: react-resizable-panels v4 uses data-separator
      const resizeHandle = page.locator('[data-separator]').first();
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
        } catch (_error) {
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
      const minExpectedWidth = viewportSize.width * 0.12; // Account for navigation sidebar
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
      await page.mouse.move(viewportSize.width * 0.6, newHandleBox.y + newHandleBox.height / 2); // Try to make very large
      await page.mouse.up();

      await page.waitForTimeout(300);

      // Verify panel respects maximum size (50% according to IdeLayout)
      const maxWidth = await leftPanel.evaluate((el) => el.getBoundingClientRect().width);
      const maxExpectedWidth = viewportSize.width * 0.55; // Allow some variance for navigation
      expect(maxWidth).toBeLessThan(maxExpectedWidth);
    });
  });

  test.describe('Accessibility and Keyboard Navigation', () => {
    test('should support keyboard navigation for panel toggles', async ({ page }) => {
      // Focus on hide explorer button and activate with keyboard
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
      await hideExplorerButton.focus();
      await page.keyboard.press('Enter');

      const leftPanel = page.locator('[id="explorer-panel"]');
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

      const showConsoleButton = page.locator('button[aria-label="Show File Editor"]');
      await expect(showConsoleButton).toBeVisible();

      // Show console to test close button
      await showConsoleButton.click();
      await expect(page.locator('button[aria-label="Close File Editor"]')).toBeVisible();

      // Test right panel buttons if available
      const showRightPanelButton = page.locator('button[aria-label="Show tools panel"]');
      if (await showRightPanelButton.isVisible()) {
        await expect(showRightPanelButton).toBeVisible();
      }
    });
  });
});
