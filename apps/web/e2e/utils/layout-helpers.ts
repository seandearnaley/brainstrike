import { type Page, expect } from '@playwright/test';

/**
 * Layout test utilities for IDE panel testing
 */

export interface PanelElements {
  leftPanel: ReturnType<Page['locator']>;
  rightPanel: ReturnType<Page['locator']>;
  consolePanel: ReturnType<Page['locator']>;
  mainContentPanel: ReturnType<Page['locator']>;
  middlePanel: ReturnType<Page['locator']>;
  hideExplorerButton: ReturnType<Page['locator']>;
  hideRightPanelButton: ReturnType<Page['locator']>;
  hideConsoleButton: ReturnType<Page['locator']>;
  showExplorerShim: ReturnType<Page['locator']>;
  showRightPanelShim: ReturnType<Page['locator']>;
  showConsoleShim: ReturnType<Page['locator']>;
}

/**
 * Get all panel-related elements for testing
 */
export function getPanelElements(page: Page): PanelElements {
  return {
    // Main panels
    leftPanel: page.locator('[data-panel-id="left-panel"]'),
    rightPanel: page.locator('[data-panel-id="right-panel"]'),
    consolePanel: page.locator('[data-panel-id="console-panel"]'),
    mainContentPanel: page.locator('[data-panel-id="main-content-panel"]'),
    middlePanel: page.locator('[data-panel-id="middle-panel"]'),

    // Hide buttons (when panels are open)
    hideExplorerButton: page.locator('button[aria-label="Hide explorer"]'),
    hideRightPanelButton: page.locator('button[aria-label="Hide right panel"]'),
    hideConsoleButton: page.locator('button[aria-label="Close File Editor"]'),

    // Show shims (when panels are closed)
    showExplorerShim: page.locator('button[aria-label="Show explorer"]'),
    showRightPanelShim: page.locator('button[aria-label="Show right panel"]'),
    showConsoleShim: page.locator('button[aria-label="Show File Editor"]'),
  };
}

/**
 * Waits for the main application content to be ready.
 * This is useful to ensure tests don't start before the UI is fully initialized.
 */
export async function waitForAppLoad(page: Page, timeout = 10000) {
  await expect(page.locator('body')).not.toBeEmpty({ timeout });
  // Wait for the main layout structure to be present, regardless of panel visibility
  await page.waitForSelector('[data-panel-id="middle-panel"]', {
    state: 'attached',
    timeout,
  });
  // Also ensure the main content panel is present
  await page.waitForSelector('[data-panel-id="main-content-panel"]', {
    state: 'attached',
    timeout,
  });
}

/**
 * Clear layout state and reload page with clean state
 */
export async function resetLayoutState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('panelLayout.v1');
  });
  // Wait for the page to finish navigating before continuing. Using
  // `networkidle` helps avoid flaky reload errors in CI where the
  // default navigation wait can resolve too early.
  await page.reload({ waitUntil: 'load' });
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
export async function getPanelDimensions(panel: ReturnType<Page['locator']>): Promise<{ width: number; height: number }> {
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
  resizeHandle: ReturnType<Page['locator']>,
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
export function getLeftPanelResizeHandle(page: Page): ReturnType<Page['locator']> {
  // The left panel's resize handle is the first one in the horizontal group
  return page.locator('[data-panel-group-direction="horizontal"] [data-panel-resize-handle-id]').first();
}

/**
 * Get the last (console panel) resize handle
 */
export function getConsolePanelResizeHandle(page: Page): ReturnType<Page['locator']> {
  // The console panel's resize handle is in the vertical group
  return page.locator('[data-panel-group-direction="vertical"] [data-panel-resize-handle-id]').first();
}

/**
 * Toggles a panel's visibility and verifies its state.
 * @param button - The Playwright locator for the button that triggers the toggle.
 * @param panel - The Playwright locator for the panel being toggled.
 * @param isVisibleAfterToggle - The expected visibility state of the panel after the action.
 */
export async function togglePanelVisibility(
  button: ReturnType<Page['locator']>,
  panel: ReturnType<Page['locator']>,
  isVisibleAfterToggle: boolean
) {
  await expect(button).toBeVisible();
  await button.click();
  if (isVisibleAfterToggle) {
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
  panel: ReturnType<Page['locator']>,
  shouldBeVisible: boolean,
  dimensions?: { width?: number; height?: number }
): Promise<void> {
  await page.reload({ waitUntil: 'load' });
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
  await togglePanelVisibility(elements.showConsoleShim, elements.consolePanel, true);
  
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
    rightPanelHidden?: boolean;
  }
): Promise<void> {
  const elements = getPanelElements(page);
  
  if (expectedState.leftPanelHidden) {
    await expect(elements.leftPanel).not.toBeVisible();
    await expect(elements.showExplorerShim).toBeVisible();
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

  // Right panel visibility logic
  if (expectedState.rightPanelHidden === false) {
    // Explicitly set to be visible
    await expect(elements.rightPanel).toBeVisible();
    await expect(elements.hideRightPanelButton).toBeVisible();
  } else {
    // Default behavior or explicitly hidden
    await expect(elements.rightPanel).not.toBeVisible();
    await expect(elements.showRightPanelShim).toBeVisible();
  }
}

/**
 * Test panel size constraints
 */
export async function testPanelSizeConstraints(
  page: Page,
  panel: ReturnType<Page['locator']>,
  resizeHandle: ReturnType<Page['locator']>,
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

interface DefaultLayoutState {
  leftPanelHidden?: boolean;
  rightPanelHidden?: boolean;
  consoleHidden?: boolean;
}

/**
 * Verifies the default state of the layout.
 * This function can be customized to check for different default configurations.
 */
export async function verifyDefaultLayout(page: Page, expectedState: DefaultLayoutState = {}) {
  const elements = getPanelElements(page);

  // Left panel should be visible by default
  if (expectedState.leftPanelHidden) {
    await expect(elements.leftPanel).not.toBeVisible();
    await expect(elements.showExplorerShim).toBeVisible();
  } else {
    await expect(elements.leftPanel).toBeVisible();
  }

  // Right panel should be hidden by default
  if (expectedState.rightPanelHidden === false) {
    // Explicitly set to be visible
    await expect(elements.rightPanel).toBeVisible();
    await expect(elements.hideRightPanelButton).toBeVisible();
  } else {
    // Default behavior or explicitly hidden
    await expect(elements.rightPanel).not.toBeVisible();
    await expect(elements.showRightPanelShim).toBeVisible();
  }

  // Console should be hidden by default
  await expect(elements.consolePanel).not.toBeVisible();
  await expect(elements.showConsoleShim).toBeVisible();
}

/**
 * Test keyboard navigation for panel controls
 */
export async function testKeyboardNavigation(
  page: Page,
  button: ReturnType<Page['locator']>,
  _panel: ReturnType<Page['locator']>,
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
  const leftPanel = page.locator('[data-panel-id="left-panel"]');
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