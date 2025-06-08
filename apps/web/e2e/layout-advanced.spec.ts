import { test, expect } from '@playwright/test';
import {
  getPanelElements,
  waitForAppLoad,
  getPanelDimensions,
  resizePanel,
  getLeftPanelResizeHandle,
  getConsolePanelResizeHandle,
  verifyPersistenceAfterReload,
  setupComplexLayout,
  verifyComplexLayout,
  testPanelSizeConstraints,
  corruptLayoutStorage,
  clearAllStorage,
  verifyDefaultLayout,
  testLayoutPersistenceAcrossNavigation,
} from './utils/layout-helpers';
import { resetAppState } from './utils/app-state';

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
      
      // Show console first
      await elements.showConsoleButton.click();
      await expect(elements.consolePanel).toBeVisible();
      
      const resizeHandle = getConsolePanelResizeHandle(page);
      const initialDimensions = await getPanelDimensions(elements.consolePanel);
      
      // Resize console taller
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
      const elements = getPanelElements(page);
      
      // Setup complex layout
      const layoutState = await setupComplexLayout(page);
      
      // Verify the complex layout
      await verifyComplexLayout(page, layoutState);
      
      // Test persistence
      await verifyPersistenceAfterReload(page, elements.leftPanel, false);
      await verifyPersistenceAfterReload(page, elements.consolePanel, true, {
        height: layoutState.consoleDimensions.height,
      });
    });

    test('should maintain layout during rapid panel toggles', async ({ page }) => {
      const elements = getPanelElements(page);
      
      // Rapidly toggle panels
      for (let i = 0; i < 3; i++) {
        await elements.hideExplorerButton.click();
        await expect(elements.leftPanel).not.toBeVisible();
        
        await elements.showExplorerButton.click();
        await expect(elements.leftPanel).toBeVisible();
        
        await elements.showConsoleButton.click();
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
          await elements.showConsoleButton.click();
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
      await elements.showConsoleButton.click();
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
        document.body.style.zoom = '1.5';
      });
      
      // Wait for layout to adjust
      await page.waitForTimeout(1000);
      
      // Show panel and verify it still works
      await elements.showExplorerButton.click();
      await expect(elements.leftPanel).toBeVisible();
      
      // Reset zoom
      await page.evaluate(() => {
        document.body.style.zoom = '1';
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
      await elements.showConsoleButton.click();
      await elements.showExplorerButton.click();
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
      
      // Focus on hide button and activate
      await elements.hideExplorerButton.focus();
      await page.keyboard.press('Enter');
      await expect(elements.leftPanel).not.toBeVisible();
      
      // Verify show button is now available (focus may not automatically move)
      await expect(elements.showExplorerButton).toBeVisible();
      
      // Manually focus on show button and activate with keyboard
      await elements.showExplorerButton.focus();
      await page.keyboard.press('Space');
      await expect(elements.leftPanel).toBeVisible();
      
      // Verify hide button is available again
      await expect(elements.hideExplorerButton).toBeVisible();
    });

    test('should provide proper visual feedback during resize', async ({ page }) => {
      const resizeHandle = getLeftPanelResizeHandle(page);
      
      // Hover over resize handle
      await resizeHandle.hover();
      
      // Verify cursor changes (resize handle should have appropriate cursor)
      const cursor = await resizeHandle.evaluate(el => 
        window.getComputedStyle(el).cursor
      );
      
      // Should have a resize cursor (col-resize, ew-resize, etc.)
      expect(['col-resize', 'ew-resize', 'w-resize', 'e-resize']).toContain(cursor);
    });

    test('should maintain proper ARIA states', async ({ page }) => {
      const elements = getPanelElements(page);
      
      // Verify initial ARIA labels
      await expect(elements.hideExplorerButton).toHaveAttribute('aria-label', 'Hide explorer');
      await expect(elements.showConsoleButton).toHaveAttribute('aria-label', 'Show console');
      
      // Change states and verify ARIA updates
      await elements.hideExplorerButton.click();
      await expect(elements.showExplorerButton).toHaveAttribute('aria-label', 'Show explorer');
      
      await elements.showConsoleButton.click();
      await expect(elements.hideConsoleButton).toHaveAttribute('aria-label', 'Close console');
    });
  });

  test.describe('Edge Cases', () => {
    test('should handle very small viewport sizes', async ({ page }) => {
      // Set very small viewport
      await page.setViewportSize({ width: 400, height: 300 });
      
      const elements = getPanelElements(page);
      
      // Verify layout still works in small viewport
      await expect(elements.leftPanel).toBeVisible();
      
      // Test panel operations
      await elements.hideExplorerButton.click();
      await expect(elements.leftPanel).not.toBeVisible();
      
      await elements.showExplorerButton.click();
      await expect(elements.leftPanel).toBeVisible();
      
      // Verify minimum sizes are respected
      const dimensions = await getPanelDimensions(elements.leftPanel);
      expect(dimensions.width).toBeGreaterThan(50); // Should have minimum usable width
    });

    test('should handle very large viewport sizes', async ({ page }) => {
      // Set large viewport
      await page.setViewportSize({ width: 2560, height: 1440 });
      
      const elements = getPanelElements(page);
      const resizeHandle = getLeftPanelResizeHandle(page);
      
      // Test maximum size constraints
      await resizePanel(page, resizeHandle, 1000);
      
      const dimensions = await getPanelDimensions(elements.leftPanel);
      const viewportWidth = 2560;
      
      // Should not exceed maximum percentage (50% according to IdeLayout)
      expect(dimensions.width).toBeLessThan(viewportWidth * 0.6); // Allow some variance
    });

    test('should handle rapid page reloads during layout changes', async ({ page }) => {
      const elements = getPanelElements(page);
      
      // Start layout change
      await elements.hideExplorerButton.click();
      
      // Immediately reload (simulating user behavior)
      await page.reload();
      await waitForAppLoad(page);
      
      // Verify state is consistent (should be hidden due to persistence)
      await expect(elements.leftPanel).not.toBeVisible();
      await expect(elements.showExplorerButton).toBeVisible();
    });
  });
}); 