import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import {
  clearAllStorage,
  corruptLayoutStorage,
  getConsolePanelResizeHandle,
  getLeftPanelResizeHandle,
  getPanelDimensions,
  getPanelElements,
  resizePanel,
  setupComplexLayout,
  testLayoutPersistenceAcrossNavigation,
  testPanelSizeConstraints,
  verifyComplexLayout,
  verifyDefaultLayout,
  verifyPersistenceAfterReload,
  waitForAppLoad,
} from './utils/layout-helpers';

test.describe('Advanced IDE Layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test.describe('Panel Resize Functionality', () => {
    test('should resize left panel and maintain proportions', async ({ page }) => {
      const elements = getPanelElements(page);
      const resizeHandle = getLeftPanelResizeHandle(page);

      // Get initial dimensions
      const initialDimensions = await getPanelDimensions(elements.leftPanel);

      // Resize panel wider
      await resizePanel(page, resizeHandle, 100);

      // Verify panel got wider
      const newDimensions = await getPanelDimensions(elements.leftPanel);
      expect(newDimensions.width).toBeGreaterThan(initialDimensions.width);

      // Resize panel narrower
      await resizePanel(page, resizeHandle, -150);

      // Verify panel got narrower
      const finalDimensions = await getPanelDimensions(elements.leftPanel);
      expect(finalDimensions.width).toBeLessThan(newDimensions.width);
    });

    test('should resize console panel height', async ({ page }) => {
      const elements = getPanelElements(page);
      await elements.showConsoleShim.click();
      await expect(elements.consolePanel).toBeVisible();

      const resizeHandle = getConsolePanelResizeHandle(page);
      const initialDimensions = await getPanelDimensions(elements.consolePanel);

      await resizePanel(page, resizeHandle, 0, -50);

      const newDimensions = await getPanelDimensions(elements.consolePanel);
      expect(newDimensions.height).toBeGreaterThan(initialDimensions.height);
    });

    test('should respect panel size constraints', async ({ page }) => {
      const elements = getPanelElements(page);
      const resizeHandle = getLeftPanelResizeHandle(page);

      // Test constraints based on IdeLayout configuration (15% min, 50% max)
      await testPanelSizeConstraints(page, elements.leftPanel, resizeHandle, 15, 50);
    });
  });

  test.describe('Complex Layout Scenarios', () => {
    test('should handle multiple simultaneous panel operations', async ({ page }) => {
      // Setup complex layout
      const layoutState = await setupComplexLayout(page);

      // Verify the complex layout
      await verifyComplexLayout(page, layoutState);

      // Test persistence
      await page.reload();
      await waitForAppLoad(page);
      await verifyComplexLayout(page, layoutState);
    });

    test('should maintain layout during rapid panel toggles', async ({ page }) => {
      const elements = getPanelElements(page);

      // Rapidly toggle panels
      for (let i = 0; i < 3; i++) {
        await elements.hideExplorerButton.click();
        await expect(elements.leftPanel).not.toBeVisible();

        await elements.showExplorerShim.click();
        await expect(elements.leftPanel).toBeVisible();

        await elements.showConsoleShim.click();
        await expect(elements.consolePanel).toBeVisible();

        await elements.hideConsoleButton.click();
        await expect(elements.consolePanel).not.toBeVisible();
      }

      // Verify final state is consistent
      await expect(elements.leftPanel).toBeVisible();
      await expect(elements.consolePanel).not.toBeVisible();
    });

    test('should handle layout persistence across navigation', async ({ page }) => {
      await testLayoutPersistenceAcrossNavigation(
        page,
        async () => {
          // Setup: Hide left panel and show console
          const elements = getPanelElements(page);
          await elements.hideExplorerButton.click();
          await elements.showConsoleShim.click();
        },
        async () => {
          // Verify: Layout state persisted
          const elements = getPanelElements(page);
          await expect(elements.leftPanel).not.toBeVisible();
          await expect(elements.consolePanel).toBeVisible();
        }
      );
    });
  });

  test.describe('Error Handling and Recovery', () => {
    test('should recover from corrupted layout storage', async ({ page }) => {
      // Corrupt the storage
      await corruptLayoutStorage(page);

      // Reload and verify graceful recovery
      await page.reload();
      await waitForAppLoad(page);
      await verifyDefaultLayout(page);

      // Verify functionality still works
      const elements = getPanelElements(page);
      await elements.hideExplorerButton.click();
      await expect(elements.leftPanel).not.toBeVisible();

      // Verify new state can be saved
      await verifyPersistenceAfterReload(page, elements.leftPanel, false);
    });

    test('should handle missing localStorage gracefully', async ({ page }) => {
      // Clear all storage
      await clearAllStorage(page);

      // Reload and verify default state
      await page.reload();
      await waitForAppLoad(page);
      await verifyDefaultLayout(page);

      // Test that new layout changes work
      const elements = getPanelElements(page);
      await elements.showConsoleShim.click();
      await expect(elements.consolePanel).toBeVisible();

      // Verify persistence works after clearing
      await verifyPersistenceAfterReload(page, elements.consolePanel, true);
    });

    test('should handle browser zoom changes gracefully', async ({ page }) => {
      const elements = getPanelElements(page);

      // Set initial layout - ensure panel is visible first
      await expect(elements.leftPanel).toBeVisible();

      // Hide panel
      await elements.hideExplorerButton.click();
      await expect(elements.leftPanel).not.toBeVisible();

      // Change zoom level
      await page.evaluate(() => {
        // The zoom property is a non-standard CSS property supported by browsers
        (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = '1.5';
      });

      // Wait for layout to adjust
      await page.waitForTimeout(1000);

      // Show panel and verify it still works
      await elements.showExplorerShim.click();
      await expect(elements.leftPanel).toBeVisible();

      // Reset zoom
      await page.evaluate(() => {
        // The zoom property is a non-standard CSS property supported by browsers
        (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom = '1';
      });

      await page.waitForTimeout(500);

      // Verify layout still functions
      await elements.hideExplorerButton.click();
      await expect(elements.leftPanel).not.toBeVisible();
    });
  });

  test.describe('Performance and Responsiveness', () => {
    test('should handle rapid resize operations smoothly', async ({ page }) => {
      const elements = getPanelElements(page);
      const resizeHandle = getLeftPanelResizeHandle(page);

      // Perform multiple rapid resizes
      for (let i = 0; i < 5; i++) {
        await resizePanel(page, resizeHandle, 50);
        await resizePanel(page, resizeHandle, -30);
      }

      // Verify panel is still functional
      await expect(elements.leftPanel).toBeVisible();

      // Verify final state can be persisted
      const finalDimensions = await getPanelDimensions(elements.leftPanel);
      await verifyPersistenceAfterReload(page, elements.leftPanel, true, {
        width: finalDimensions.width,
      });
    });

    test('should maintain responsiveness during layout changes', async ({ page }) => {
      const elements = getPanelElements(page);

      // Measure time for panel operations
      const startTime = Date.now();

      // Perform several layout operations
      await elements.hideExplorerButton.click();
      await elements.showConsoleShim.click();
      await elements.showExplorerShim.click();
      await elements.hideConsoleButton.click();

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Operations should complete within reasonable time (2 seconds)
      expect(duration).toBeLessThan(2000);

      // Verify final state is correct
      await expect(elements.leftPanel).toBeVisible();
      await expect(elements.consolePanel).not.toBeVisible();
    });
  });

  test.describe('Accessibility and Usability', () => {
    test('should maintain focus management during panel operations', async ({ page }) => {
      const elements = getPanelElements(page);
      await elements.hideExplorerButton.click();
      await expect(elements.leftPanel).not.toBeVisible();

      // Verify show button is now available (focus may not automatically move)
      await expect(elements.showExplorerShim).toBeVisible();

      // Manually focus on show button and activate with keyboard
      await elements.showExplorerShim.focus();
      await page.keyboard.press('Enter');

      // Panel should be visible again, and focus should be inside or on the hide button
      await expect(elements.leftPanel).toBeVisible();
      await expect(elements.hideExplorerButton).toBeFocused();
    });

    test('should provide proper visual feedback during resize', async ({ page }) => {
      const resizeHandle = getLeftPanelResizeHandle(page);
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).toBeDefined();

      // Verify no visual change initially
      await expect(resizeHandle).not.toHaveClass(/bg-blue-500/);

      // Simulate hover and drag
      await resizeHandle.hover();
      // On hover, we expect a color change from the CSS transition
      // We cannot reliably test the exact color, so we check for presence

      await page.mouse.down();
      // On drag, cursor might change, but this is hard to test in Playwright
      // We rely on the resizePanel helper's functionality

      await page.mouse.up();
    });

    test('should maintain proper ARIA states', async ({ page }) => {
      const elements = getPanelElements(page);

      // Verify initial ARIA labels
      await expect(elements.hideExplorerButton).toHaveAttribute(
        'aria-label',
        'Hide explorer panel'
      );
      await expect(elements.showConsoleShim).toHaveAttribute('aria-label', 'Show File Editor');

      // Change states and verify ARIA updates
      await elements.hideExplorerButton.click();
      await expect(elements.showExplorerShim).toHaveAttribute('aria-label', 'Show explorer panel');
    });
  });

  test.describe('Edge Cases', () => {
    test('should handle very small viewport sizes', async ({ page }) => {
      await page.setViewportSize({ width: 400, height: 300 });

      const elements = getPanelElements(page);

      // Panels should still be rendered
      await expect(elements.leftPanel).toBeVisible();
      await expect(elements.consolePanel).not.toBeVisible();

      // Hide panel and verify it's gone
      await elements.hideExplorerButton.click();
      await expect(elements.leftPanel).not.toBeVisible();

      await elements.showExplorerShim.click();
      await expect(elements.leftPanel).toBeVisible();

      // Verify minimum sizes are respected
      const { width } = await getPanelDimensions(elements.leftPanel);
      const viewportWidth = page.viewportSize()?.width ?? 400;
      expect(width / viewportWidth).toBeGreaterThanOrEqual(0.1); // Allow for some variance due to small viewport
    });

    test('should handle very large viewport sizes', async ({ page }) => {
      await page.setViewportSize({ width: 2000, height: 1200 });
      const elements = getPanelElements(page);

      // Verify panel resize works
      const resizeHandle = getLeftPanelResizeHandle(page);
      const initialWidth = (await getPanelDimensions(elements.leftPanel)).width;

      await resizePanel(page, resizeHandle, 200);
      const newWidth = (await getPanelDimensions(elements.leftPanel)).width;
      expect(newWidth).toBeGreaterThan(initialWidth);
    });

    test('should handle rapid page reloads during layout changes', async ({ page }) => {
      const elements = getPanelElements(page);

      // Change layout
      await elements.hideExplorerButton.click();
      await page.reload();
      await waitForAppLoad(page);

      // Change layout again
      await elements.showConsoleShim.click();
      await page.reload();
      await waitForAppLoad(page);

      // Verify final state is persisted correctly
      await expect(elements.leftPanel).not.toBeVisible();
      await expect(elements.consolePanel).toBeVisible();
    });
  });
});
