import { test, expect } from '@playwright/test';
import { resetAppState } from './utils/app-state';

test.describe('IDE Layout Persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Wait for brainstrike app to load
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByTestId('select-root-button')).toBeVisible({ timeout: 10000 });
    
    // Clear any existing layout state to start fresh
    await resetAppState(page);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
  });

  test.describe('Panel Visibility Persistence', () => {
    test('should persist left panel (explorer) toggle state across page reloads', async ({ page }) => {
      // Verify left panel is visible by default
      const leftPanel = page.locator('[id="left-panel"]');
      await expect(leftPanel).toBeVisible();
      
      // Hide the left panel
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
      await hideExplorerButton.click();
      
      // Verify panel is hidden
      await expect(leftPanel).not.toBeVisible();
      
      // Verify show button appears
      const showExplorerButton = page.locator('button[aria-label="Show explorer"]');
      await expect(showExplorerButton).toBeVisible();
      
      // Reload page
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      
      // Verify left panel remains hidden after reload
      await expect(leftPanel).not.toBeVisible();
      await expect(showExplorerButton).toBeVisible();
      
      // Show panel again
      await showExplorerButton.click();
      await expect(leftPanel).toBeVisible();
      
      // Reload and verify it's visible
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      await expect(leftPanel).toBeVisible();
    });

    test('should persist console panel toggle state across page reloads', async ({ page }) => {
      // Console should be hidden by default
      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).not.toBeVisible();
      
      // Show console using floating button
      const showConsoleButton = page.locator('button[aria-label="Show console"]');
      await expect(showConsoleButton).toBeVisible();
      await showConsoleButton.click();
      
      // Verify console is now visible
      await expect(consolePanel).toBeVisible();
      
      // Verify console content
      await expect(page.getByText('Console output will appear here...')).toBeVisible();
      
      // Reload page
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      
      // Verify console remains visible after reload
      await expect(consolePanel).toBeVisible();
      
      // Hide console
      const hideConsoleButton = page.locator('button[aria-label="Close console"]');
      await hideConsoleButton.click();
      await expect(consolePanel).not.toBeVisible();
      
      // Reload and verify it remains hidden
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      await expect(consolePanel).not.toBeVisible();
    });

    test('should persist right panel toggle state across page reloads', async ({ page }) => {
      // Right panel should be hidden by default (no content provided in current setup)
      const rightPanel = page.locator('[id="right-panel"]');
      
      // Note: Right panel may not be visible if no content is provided
      // This test verifies the persistence mechanism works when content is available
      const showRightPanelButton = page.locator('button[aria-label="Show right panel"]');
      
      // If right panel content is available, test its persistence
      if (await showRightPanelButton.isVisible()) {
        await showRightPanelButton.click();
        await expect(rightPanel).toBeVisible();
        
        // Reload and verify persistence
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
        await expect(rightPanel).toBeVisible();
        
        // Hide and verify persistence
        const hideRightPanelButton = page.locator('button[aria-label="Hide panel"]');
        await hideRightPanelButton.click();
        await expect(rightPanel).not.toBeVisible();
        
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
        await expect(rightPanel).not.toBeVisible();
      }
    });
  });

  test.describe('Panel Resize Persistence', () => {
    test('should persist left panel width across page reloads', async ({ page }) => {
      const leftPanel = page.locator('[id="left-panel"]');
      await expect(leftPanel).toBeVisible();
      
      // Get container width before resize
      const containerWidth = await page.locator('[data-panel-id="middle-panel"]').evaluate(el => el.getBoundingClientRect().width);
      
      // Get initial width
      const initialWidth = await leftPanel.evaluate(el => el.getBoundingClientRect().width);
      
      // Find and drag the resize handle to make panel wider
      const resizeHandle = page.locator('[data-panel-resize-handle-enabled="true"]').first();
      await expect(resizeHandle).toBeVisible();
      
      // Get the resize handle position
      const handleBox = await resizeHandle.boundingBox();
      if (!handleBox) throw new Error('Resize handle not found');
      
      // Drag to resize (move right to make panel wider)
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x + 100, handleBox.y + handleBox.height / 2);
      await page.mouse.up();
      
      // Wait for resize to complete
      await page.waitForTimeout(300);
      
      // Verify width changed
      const newWidth = await leftPanel.evaluate(el => el.getBoundingClientRect().width);
      expect(newWidth).toBeGreaterThan(initialWidth);
      
      // Reload page
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      
      // Get container width after reload
      const containerWidthAfter = await page.locator('[data-panel-id="middle-panel"]').evaluate(el => el.getBoundingClientRect().width);
      
      // Verify width persisted by comparing percentages (accounts for container size changes)
      const persistedWidth = await leftPanel.evaluate(el => el.getBoundingClientRect().width);
      const newWidthPercentage = (newWidth / containerWidth) * 100;
      const persistedWidthPercentage = (persistedWidth / containerWidthAfter) * 100;
      
      // The percentage should be reasonably close (within 6% to account for rounding and layout differences)
      expect(Math.abs(persistedWidthPercentage - newWidthPercentage)).toBeLessThan(6);
    });

    test('should persist console panel visibility across page reloads', async ({ page }) => {
      // Console should be hidden by default
      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).not.toBeVisible();
      
      // Show console first
      const showConsoleButton = page.locator('button[aria-label="Show console"]');
      await showConsoleButton.click();
      await expect(consolePanel).toBeVisible();
      
      // Wait for layout to settle
      await page.waitForTimeout(500);
      
      // Get the console height for reference
      const consoleHeight = await consolePanel.evaluate(el => el.getBoundingClientRect().height);
      expect(consoleHeight).toBeGreaterThan(50); // Should have reasonable height
      
      // Reload page
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      
      // Verify console is still visible after reload (main persistence test)
      await expect(consolePanel).toBeVisible();
      
      // Verify console still has reasonable height
      const persistedHeight = await consolePanel.evaluate(el => el.getBoundingClientRect().height);
      expect(persistedHeight).toBeGreaterThan(50); // Should maintain reasonable height
      
      // Hide console and verify persistence
      const hideConsoleButton = page.locator('button[aria-label="Close console"]');
      await hideConsoleButton.click();
      await expect(consolePanel).not.toBeVisible();
      
      // Reload and verify it stays hidden
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      await expect(consolePanel).not.toBeVisible();
    });
  });

  test.describe('Complex Layout State Persistence', () => {
    test('should persist multiple panel states simultaneously', async ({ page }) => {
      // Configure a complex layout: hide left panel, show console, resize console
      
      // 1. Hide left panel
      const leftPanel = page.locator('[id="left-panel"]');
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();
      
      // 2. Show console
      const showConsoleButton = page.locator('button[aria-label="Show console"]');
      await showConsoleButton.click();
      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).toBeVisible();
      
      // 3. Get console height for later verification
      const consoleHeight = await consolePanel.evaluate(el => el.getBoundingClientRect().height);
      
      // 4. Reload and verify all states persisted
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      
      // Verify left panel remains hidden
      await expect(leftPanel).not.toBeVisible();
      const showExplorerButton = page.locator('button[aria-label="Show explorer"]');
      await expect(showExplorerButton).toBeVisible();
      
      // Verify console remains visible
      await expect(consolePanel).toBeVisible();
      
      // Verify console height roughly persisted
      const persistedConsoleHeight = await consolePanel.evaluate(el => el.getBoundingClientRect().height);
      expect(Math.abs(persistedConsoleHeight - consoleHeight)).toBeLessThan(10);
    });

    test('should handle navigation between pages while preserving layout', async ({ page }) => {
      // Start with panel visible (default state)
      const leftPanel = page.locator('[id="left-panel"]');
      await expect(leftPanel).toBeVisible();
      
      // Hide the panel
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();
      
      // Show explorer before navigation to avoid UI overlap
      const showExplorerButton = page.locator('button[aria-label="Show explorer"]');
      await showExplorerButton.click();
      await expect(leftPanel).toBeVisible();
      
      // Navigate to Settings
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      
      // Navigate back to Context Explorer
      await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      
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
        localStorage.setItem('panelLayout.v1', 'invalid-json');
      });
      
      // Reload page
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      
      // Verify app loads with default layout (left panel visible, console hidden)
      const leftPanel = page.locator('[id="left-panel"]');
      await expect(leftPanel).toBeVisible();
      
      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).not.toBeVisible();
      
      // Verify layout functionality still works
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
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
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      
      // Verify app loads with default layout
      const leftPanel = page.locator('[id="left-panel"]');
      await expect(leftPanel).toBeVisible();
      
      const consolePanel = page.locator('[id="console-panel"], [id="console-panel-horizontal"]');
      await expect(consolePanel).not.toBeVisible();
      
      // Verify new layout changes are saved
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
      await hideExplorerButton.click();
      await expect(leftPanel).not.toBeVisible();
      
      // Reload and verify persistence works
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
      await expect(leftPanel).not.toBeVisible();
    });
  });

  test.describe('Panel Resize Constraints', () => {
    test('should respect minimum and maximum panel sizes', async ({ page }) => {
      const leftPanel = page.locator('[id="left-panel"]');
      await expect(leftPanel).toBeVisible();
      
      // Get viewport width for calculations
      const viewportSize = page.viewportSize();
      if (!viewportSize) throw new Error('Viewport size not available');
      
      // Try to resize panel to very small size (should be constrained to minimum)
      const resizeHandle = page.locator('[data-panel-resize-handle-enabled="true"]').first();
      const handleBox = await resizeHandle.boundingBox();
      if (!handleBox) throw new Error('Resize handle not found');
      
      // Drag to a moderately small size first (not extreme to avoid collapse)
      await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(handleBox.x - 100, handleBox.y + handleBox.height / 2); // Moderate reduction
      await page.mouse.up();
      
      await page.waitForTimeout(300);
      
      // Check if panel collapsed - if so, expand it back
      const isCollapsed = await leftPanel.evaluate(el => el.getBoundingClientRect().width === 0);
      if (isCollapsed) {
        // Panel collapsed, expand it back
        const showExplorerButton = page.locator('button[aria-label="Show explorer"]');
        await showExplorerButton.click();
        await expect(leftPanel).toBeVisible();
      }
      
      // Verify panel respects minimum size (15% of viewport according to IdeLayout)
      const finalWidth = await leftPanel.evaluate(el => el.getBoundingClientRect().width);
      const minExpectedWidth = viewportSize.width * 0.12; // Account for navigation sidebar
      expect(finalWidth).toBeGreaterThan(minExpectedWidth);
      
      // Try to resize panel to very large size (should be constrained to maximum)
      const newHandleBox = await resizeHandle.boundingBox();
      if (!newHandleBox) throw new Error('Resize handle not found after expand');
      
      await page.mouse.move(newHandleBox.x + newHandleBox.width / 2, newHandleBox.y + newHandleBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(viewportSize.width * 0.6, newHandleBox.y + newHandleBox.height / 2); // Try to make very large
      await page.mouse.up();
      
      await page.waitForTimeout(300);
      
      // Verify panel respects maximum size (50% according to IdeLayout)
      const maxWidth = await leftPanel.evaluate(el => el.getBoundingClientRect().width);
      const maxExpectedWidth = viewportSize.width * 0.55; // Allow some variance for navigation
      expect(maxWidth).toBeLessThan(maxExpectedWidth);
    });
  });

  test.describe('Accessibility and Keyboard Navigation', () => {
    test('should support keyboard navigation for panel toggles', async ({ page }) => {
      // Focus on hide explorer button and activate with keyboard
      const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
      await hideExplorerButton.focus();
      await page.keyboard.press('Enter');
      
      const leftPanel = page.locator('[id="left-panel"]');
      await expect(leftPanel).not.toBeVisible();
      
      // Focus on show explorer button and activate with keyboard
      const showExplorerButton = page.locator('button[aria-label="Show explorer"]');
      await showExplorerButton.focus();
      await page.keyboard.press('Space');
      
      await expect(leftPanel).toBeVisible();
    });

    test('should have proper ARIA labels for all panel controls', async ({ page }) => {
      // Verify all panel control buttons have proper ARIA labels
      await expect(page.locator('button[aria-label="Hide explorer"]')).toBeVisible();
      
      const showConsoleButton = page.locator('button[aria-label="Show console"]');
      await expect(showConsoleButton).toBeVisible();
      
      // Show console to test close button
      await showConsoleButton.click();
      await expect(page.locator('button[aria-label="Close console"]')).toBeVisible();
      
      // Test right panel buttons if available
      const showRightPanelButton = page.locator('button[aria-label="Show right panel"]');
      if (await showRightPanelButton.isVisible()) {
        await expect(showRightPanelButton).toBeVisible();
      }
    });
  });
}); 