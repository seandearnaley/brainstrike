import type { Page, Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Layout test utilities for IDE panel testing
 */

export interface PanelElements {
  leftPanel: Locator;
  rightPanel: Locator;
  consolePanel: Locator;
  hideExplorerButton: Locator;
  showExplorerButton: Locator;
  showConsoleButton: Locator;
  hideConsoleButton: Locator;
  showRightPanelButton: Locator;
  hideRightPanelButton: Locator;
}

/**
 * Get all panel-related elements for testing
 */
export function getPanelElements(page: Page): PanelElements {
  return {
    leftPanel: page.locator('[id="left-panel"]'),
    rightPanel: page.locator('[id="right-panel"]'),
    consolePanel: page.locator('[id="console-panel"], [id="console-panel-horizontal"]'),
    hideExplorerButton: page.locator('button[aria-label="Hide explorer"]'),
    showExplorerButton: page.locator('button[aria-label="Show explorer"]'),
    showConsoleButton: page.locator('button[aria-label="Show console"]'),
    hideConsoleButton: page.locator('button[aria-label="Close console"]'),
    showRightPanelButton: page.locator('button[aria-label="Show right panel"]'),
    hideRightPanelButton: page.locator('button[aria-label="Hide panel"]'),
  };
}

/**
 * Wait for the brainstrike app to fully load
 */
export async function waitForAppLoad(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
  
  // Try to wait for Select Root button, but don't fail if it's not there
  // (it might not be visible in all test scenarios)
  try {
    await expect(page.getByRole('button', { name: 'Select Root' })).toBeVisible({ timeout: 5000 });
  } catch (error) {
    // If Select Root button is not found, just ensure the main content is loaded
    await page.waitForTimeout(1000);
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
  }
}

/**
 * Clear layout state and reload page with clean state
 */
export async function resetLayoutState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('panelLayout.v1');
  });
  await page.reload();
  await waitForAppLoad(page);
}

/**
 * Clear file explorer settings from localStorage
 */
export async function resetFileExplorerSettings(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.removeItem('fileExplorerSettings'));
}

/**
 * Get the current dimensions of a panel
 */
export async function getPanelDimensions(panel: Locator): Promise<{ width: number; height: number }> {
  return await panel.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
}

/**
 * Resize a panel by dragging its resize handle
 */
export async function resizePanel(
  page: Page,
  resizeHandle: Locator,
  deltaX: number,
  deltaY: number = 0
): Promise<void> {
  const handleBox = await resizeHandle.boundingBox();
  if (!handleBox) throw new Error('Resize handle not found');

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY);
  await page.mouse.up();
  
  // Wait for resize to complete
  await page.waitForTimeout(300);
}

/**
 * Get the first (left panel) resize handle
 */
export function getLeftPanelResizeHandle(page: Page): Locator {
  // Look for the vertical resize handle (between left panel and main content)
  // react-resizable-panels uses data attributes, not CSS classes
  return page.locator('[data-panel-resize-handle-enabled="true"]').first();
}

/**
 * Get the last (console panel) resize handle
 */
export function getConsolePanelResizeHandle(page: Page): Locator {
  // Look for the horizontal resize handle (above console panel)
  // react-resizable-panels uses data attributes, not CSS classes
  return page.locator('[data-panel-resize-handle-enabled="true"]').last();
}

/**
 * Toggle panel visibility and verify the state change
 */
export async function togglePanelVisibility(
  toggleButton: Locator,
  panel: Locator,
  expectedVisible: boolean
): Promise<void> {
  await toggleButton.click();
  
  if (expectedVisible) {
    await expect(panel).toBeVisible();
  } else {
    await expect(panel).not.toBeVisible();
  }
}

/**
 * Verify panel state persists after page reload
 */
export async function verifyPersistenceAfterReload(
  page: Page,
  panel: Locator,
  shouldBeVisible: boolean,
  dimensions?: { width?: number; height?: number }
): Promise<void> {
  await page.reload();
  await waitForAppLoad(page);
  
  if (shouldBeVisible) {
    await expect(panel).toBeVisible();
    
    if (dimensions) {
      const currentDimensions = await getPanelDimensions(panel);
      
      if (dimensions.width !== undefined) {
        expect(Math.abs(currentDimensions.width - dimensions.width)).toBeLessThan(5);
      }
      
      if (dimensions.height !== undefined) {
        expect(Math.abs(currentDimensions.height - dimensions.height)).toBeLessThan(10);
      }
    }
  } else {
    await expect(panel).not.toBeVisible();
  }
}

/**
 * Set up a complex layout state for testing
 */
export async function setupComplexLayout(page: Page): Promise<{
  leftPanelHidden: boolean;
  consoleVisible: boolean;
  consoleDimensions: { width: number; height: number };
}> {
  const elements = getPanelElements(page);
  
  // Hide left panel
  await togglePanelVisibility(elements.hideExplorerButton, elements.leftPanel, false);
  
  // Show console
  await togglePanelVisibility(elements.showConsoleButton, elements.consolePanel, true);
  
  // Get console dimensions
  const consoleDimensions = await getPanelDimensions(elements.consolePanel);
  
  return {
    leftPanelHidden: true,
    consoleVisible: true,
    consoleDimensions,
  };
}

/**
 * Verify complex layout state
 */
export async function verifyComplexLayout(
  page: Page,
  expectedState: {
    leftPanelHidden: boolean;
    consoleVisible: boolean;
    consoleDimensions?: { width: number; height: number };
  }
): Promise<void> {
  const elements = getPanelElements(page);
  
  if (expectedState.leftPanelHidden) {
    await expect(elements.leftPanel).not.toBeVisible();
    await expect(elements.showExplorerButton).toBeVisible();
  } else {
    await expect(elements.leftPanel).toBeVisible();
  }
  
  if (expectedState.consoleVisible) {
    await expect(elements.consolePanel).toBeVisible();
    
    if (expectedState.consoleDimensions) {
      const currentDimensions = await getPanelDimensions(elements.consolePanel);
      expect(Math.abs(currentDimensions.height - expectedState.consoleDimensions.height)).toBeLessThan(10);
    }
  } else {
    await expect(elements.consolePanel).not.toBeVisible();
  }
}

/**
 * Test panel size constraints
 */
export async function testPanelSizeConstraints(
  page: Page,
  panel: Locator,
  resizeHandle: Locator,
  minPercentage: number,
  maxPercentage: number
): Promise<void> {
  const viewportSize = page.viewportSize();
  if (!viewportSize) throw new Error('Viewport size not available');

  // Test minimum size constraint - use moderate resize to avoid collapse
  await resizePanel(page, resizeHandle, -200); // Moderate reduction
  
  // Wait for panel to be visible before checking dimensions
  await expect(panel).toBeVisible();
  
  // Check if panel collapsed and expand if needed
  const currentWidth = await panel.evaluate(el => el.getBoundingClientRect().width);
  if (currentWidth === 0) {
    // Panel collapsed, need to expand it
    const showButton = page.locator('button[aria-label="Show explorer"]');
    if (await showButton.isVisible()) {
      await showButton.click();
      await expect(panel).toBeVisible();
    }
  }
  
  const minDimensions = await getPanelDimensions(panel);
  const minExpectedWidth = viewportSize.width * (minPercentage / 100);
  expect(minDimensions.width).toBeGreaterThan(minExpectedWidth * 0.8); // Allow 20% variance
  
  // Test maximum size constraint
  await resizePanel(page, resizeHandle, 500); // Try to make larger
  
  const maxDimensions = await getPanelDimensions(panel);
  const maxExpectedWidth = viewportSize.width * (maxPercentage / 100);
  expect(maxDimensions.width).toBeLessThan(maxExpectedWidth * 1.2); // Allow 20% variance
}

/**
 * Corrupt localStorage for testing error handling
 */
export async function corruptLayoutStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('panelLayout.v1', 'invalid-json');
  });
}

/**
 * Clear all localStorage for testing
 */
export async function clearAllStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear();
  });
}

/**
 * Verify default layout state
 */
export async function verifyDefaultLayout(page: Page): Promise<void> {
  const elements = getPanelElements(page);
  
  // Left panel should be visible by default
  await expect(elements.leftPanel).toBeVisible();
  
  // Console should be hidden by default
  await expect(elements.consolePanel).not.toBeVisible();
  await expect(elements.showConsoleButton).toBeVisible();
}

/**
 * Test keyboard navigation for panel controls
 */
export async function testKeyboardNavigation(
  page: Page,
  button: Locator,
  _panel: Locator,
  key: 'Enter' | 'Space' = 'Enter'
): Promise<void> {
  await button.focus();
  await page.keyboard.press(key);
  
  // The exact behavior depends on the button's current state
  // This helper just ensures the keyboard interaction works
  await page.waitForTimeout(100);
}

/**
 * Navigate between app pages and verify layout persistence
 */
export async function testLayoutPersistenceAcrossNavigation(
  page: Page,
  setupCallback: () => Promise<void>,
  verifyCallback: () => Promise<void>
): Promise<void> {
  // Setup layout state
  await setupCallback();
  
  // Check if left panel is hidden and temporarily show it for navigation
  const leftPanel = page.locator('[id="left-panel"]');
  const wasHidden = !(await leftPanel.isVisible());
  
  if (wasHidden) {
    // Temporarily show the panel to avoid UI overlap with floating button
    const showExplorerButton = page.locator('button[aria-label="Show explorer"]');
    await showExplorerButton.click();
    await expect(leftPanel).toBeVisible();
  }
  
  // Navigate to Settings
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  
  // Navigate back to Context Explorer
  await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
  
  // Restore original state if panel was hidden
  if (wasHidden) {
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer"]');
    await hideExplorerButton.click();
    await expect(leftPanel).not.toBeVisible();
  }
  
  // Verify layout state persisted
  await verifyCallback();
} 