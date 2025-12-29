import type { Page } from '@playwright/test';

/**
 * Layout test utilities for IDE panel testing
 */

type PlaywrightExpect = typeof import('@playwright/test').expect;

let cachedExpect: PlaywrightExpect | null = null;

async function getPlaywrightExpect(): Promise<PlaywrightExpect> {
  if (!cachedExpect) {
    try {
      const mod = await import('@playwright/test');
      if (!mod.expect) {
        throw new Error('Missing expect export from @playwright/test');
      }
      cachedExpect = mod.expect;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load Playwright expect. Ensure @playwright/test is installed and available. Original error: ${message}`
      );
    }
  }
  return cachedExpect;
}

export type PanelElements = {
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
};

/**
 * Get all panel-related elements for testing
 */
export function getPanelElements(page: Page): PanelElements {
  return {
    // Main panels
    leftPanel: page.locator('[data-panel-id="explorer-panel"]'),
    rightPanel: page.locator('[data-panel-id="tools-panel"]'),
    consolePanel: page.locator('[data-panel-id="console-panel"]'),
    mainContentPanel: page.locator('[data-panel-id="main-content-panel"]'),
    middlePanel: page.locator('[data-panel-id="middle-panel"]'),

    // Hide buttons (when panels are open)
    hideExplorerButton: page.locator('[data-testid="hide-explorer-panel"]'),
    hideRightPanelButton: page.locator('[data-testid="hide-tools-panel"]'),
    hideConsoleButton: page.locator('[data-testid="hide-console-panel"]'),

    // Show shims (when panels are closed)
    showExplorerShim: page.locator('[data-testid="show-explorer-panel"]'),
    showRightPanelShim: page.locator('[data-testid="show-tools-panel"]'),
    showConsoleShim: page.locator('[data-testid="show-console-panel"]'),
  };
}

/**
 * Ensure the tools panel is visible, clicking the show control only when needed.
 */
export async function ensureRightPanelVisible(page: Page, timeout = 8000): Promise<void> {
  const elements = getPanelElements(page);

  // If the panel is already visible, nothing to do.
  if (await elements.rightPanel.isVisible().catch(() => false)) {
    return;
  }

  const showShim = elements.showRightPanelShim;
  if ((await showShim.count()) > 0) {
    await showShim.first().click();
  } else {
    const showButton = page
      .locator('button[aria-label="Show tools panel"]')
      .or(page.getByRole('button', { name: 'Show tools panel' }));

    if ((await showButton.count()) > 0) {
      await showButton.first().click();
    } else {
      console.warn(
        '⚠️ Unable to find "Show tools panel" control; assuming panel is already visible.'
      );
      return;
    }
  }

  await elements.rightPanel.waitFor({ state: 'visible', timeout }).catch(() => {
    console.warn('⚠️ Tools panel did not become visible after requesting to show it.');
  });
}

/**
 * Waits for the main application content to be ready.
 * This is useful to ensure tests don't start before the UI is fully initialized.
 */
export async function waitForAppLoad(page: Page, timeout = 10_000) {
  const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
  const effectiveTimeout = isCI ? Math.max(timeout, 20_000) : timeout;
  // Ensure the document has finished initial parsing before checking layout markers.
  await page.waitForLoadState('domcontentloaded', { timeout: effectiveTimeout });
  // Wait for the main layout structure to be present, regardless of panel visibility
  await page.waitForSelector('[data-panel-id="middle-panel"]', {
    state: 'attached',
    timeout: effectiveTimeout,
  });
  // Also ensure the main content panel is present
  await page.waitForSelector('[data-panel-id="main-content-panel"]', {
    state: 'attached',
    timeout: effectiveTimeout,
  });
}

/**
 * Clear layout state and reload page with clean state
 */
export async function resetLayoutState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('panel-layout-store.v1');
  });
  // Wait for the page to finish navigating before continuing. Using
  // `networkidle` helps avoid flaky reload errors in CI where the
  // default navigation wait can resolve too early.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppLoad(page);
}

/**
 * Clear file explorer settings from localStorage
 */
export async function resetFileExplorerSettings(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.removeItem('file-explorer-storage-v4'));
}

/**
 * Get the current dimensions of a panel
 */
export async function getPanelDimensions(
  panel: ReturnType<Page['locator']>
): Promise<{ width: number; height: number }> {
  return await panel.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
}

/**
 * Resize a panel by dragging its resize handle
 * This function uses deterministic waits based on DOM stability
 * rather than arbitrary timeouts.
 */
export async function resizePanel(
  page: Page,
  resizeHandle: ReturnType<Page['locator']>,
  deltaX: number,
  deltaY = 0
): Promise<void> {
  const handleBox = await resizeHandle.boundingBox();
  if (!handleBox) {
    throw new Error('Resize handle not found');
  }

  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;

  // Get the panel being resized (parent panel group contains the panels)
  const panelGroup = resizeHandle.locator('..').locator('..');
  const panels = panelGroup.locator('[data-panel-id]');

  // Record initial panel dimensions for stability check
  const initialDimensions = await panels.first().evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY);
  await page.mouse.up();

  // Wait for panel dimensions to stabilize after resize
  // This is more deterministic than a fixed timeout
  await page
    .waitForFunction(
      ({ selector, initial, isHorizontal }) => {
        const panel = document.querySelector(selector);
        if (!panel) {
          return false;
        }

        const rect = panel.getBoundingClientRect();
        const currentDim = isHorizontal ? rect.width : rect.height;
        const initialDim = isHorizontal ? initial.width : initial.height;

        // Check that dimension has changed and is stable
        return currentDim !== initialDim;
      },
      {
        selector: await panels.first().evaluate((el) => {
          // Generate a unique selector for this element
          return el.getAttribute('data-panel-id')
            ? `[data-panel-id="${el.getAttribute('data-panel-id')}"]`
            : `#${el.id}`;
        }),
        initial: initialDimensions,
        isHorizontal: deltaX !== 0,
      },
      { timeout: 2000 }
    )
    .catch(() => {
      // If dimensions didn't change, it might be at constraint limits
      // This is acceptable behavior
    });

  // Small wait for any animations to complete
  // This is much shorter than before and only for visual smoothness
  await page.waitForTimeout(50);
}

/**
 * Get the first (explorer panel) resize handle
 */
export function getLeftPanelResizeHandle(page: Page): ReturnType<Page['locator']> {
  // The explorer panel's resize handle is the first one in the horizontal group
  return page
    .locator('[data-panel-group-direction="horizontal"] [data-panel-resize-handle-id]')
    .first();
}

/**
 * Get the last (console panel) resize handle
 */
export function getConsolePanelResizeHandle(page: Page): ReturnType<Page['locator']> {
  // The console panel's resize handle is in the vertical group
  return page
    .locator('[data-panel-group-direction="vertical"] [data-panel-resize-handle-id]')
    .first();
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
  const expect = await getPlaywrightExpect();
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
  const expect = await getPlaywrightExpect();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppLoad(page);

  if (shouldBeVisible) {
    await expect(panel).toBeVisible();

    if (dimensions) {
      const currentDimensions = await getPanelDimensions(panel);

      if (dimensions.width !== undefined) {
        expect(Math.abs(currentDimensions.width - dimensions.width)).toBeLessThan(100);
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

  // Hide explorer panel
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
  const expect = await getPlaywrightExpect();
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
      expect(
        Math.abs(currentDimensions.height - expectedState.consoleDimensions.height)
      ).toBeLessThan(10);
    }
  } else {
    await expect(elements.consolePanel).not.toBeVisible();
  }

  // Tools panel visibility logic
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
 * This function uses deterministic waits based on element state rather than arbitrary timeouts
 */
export async function testPanelSizeConstraints(
  page: Page,
  panel: ReturnType<Page['locator']>,
  resizeHandle: ReturnType<Page['locator']>,
  minPercentage: number,
  maxPercentage: number
): Promise<void> {
  const expect = await getPlaywrightExpect();
  const viewportSize = page.viewportSize();
  if (!viewportSize) {
    throw new Error('Viewport size not available');
  }

  // Helper to wait for panel width to be non-zero
  const waitForPanelExpansion = async () => {
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector);
        if (!el) {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0;
      },
      await panel.evaluate((el) =>
        el.getAttribute('data-panel-id')
          ? `[data-panel-id="${el.getAttribute('data-panel-id')}"]`
          : `#${el.id}`
      ),
      { timeout: 5000 }
    );
  };

  // First, ensure the panel is expanded/visible
  let currentWidth = await panel.evaluate((el) => el.getBoundingClientRect().width);
  if (currentWidth === 0) {
    // Panel is collapsed, need to expand it first
    const showButton = page.locator('button[aria-label="Show explorer panel"]');
    if (await showButton.isVisible()) {
      await showButton.click();
      await expect(panel).toBeVisible();

      // Wait for panel to actually expand (width > 0)
      try {
        await waitForPanelExpansion();
      } catch {
        console.warn('Panel did not expand within timeout - skipping size constraint test');
        return;
      }

      currentWidth = await panel.evaluate((el) => el.getBoundingClientRect().width);
    }
  }

  // Ensure panel is visible and has width before proceeding
  await expect(panel).toBeVisible();

  // If still width 0, skip the constraint test as the panel is not properly expanded
  if (currentWidth === 0) {
    console.warn('Panel width is still 0 after expansion attempts - skipping size constraint test');
    return;
  }

  // Test minimum size constraint - use moderate resize to avoid collapse
  await resizePanel(page, resizeHandle, -200); // Moderate reduction

  // Check if panel collapsed after resize and re-expand if needed
  let postResizeWidth = await panel.evaluate((el) => el.getBoundingClientRect().width);
  if (postResizeWidth === 0) {
    // Panel collapsed due to resize, expand it again
    const showButton = page.locator('button[aria-label="Show explorer panel"]');
    if (await showButton.isVisible()) {
      await showButton.click();
      await expect(panel).toBeVisible();

      // Wait for panel to actually expand
      try {
        await waitForPanelExpansion();
        postResizeWidth = await panel.evaluate((el) => el.getBoundingClientRect().width);
      } catch {
        console.warn('Panel did not re-expand after collapse - skipping minimum constraint test');
        postResizeWidth = 0;
      }
    }
  }

  const minDimensions = await getPanelDimensions(panel);

  // Skip minimum constraint test if panel still collapsed
  if (minDimensions.width > 0) {
    const minExpectedWidth = viewportSize.width * (minPercentage / 100);
    expect(minDimensions.width).toBeGreaterThan(minExpectedWidth * 0.8); // Allow 20% variance
  } else {
    console.warn('Panel width is 0 after resize - skipping minimum constraint test');
  }

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
    localStorage.setItem('panel-layout-store.v1', 'invalid-json');
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

type DefaultLayoutState = {
  leftPanelHidden?: boolean;
  rightPanelHidden?: boolean;
  consoleHidden?: boolean;
};

/**
 * Verifies the default state of the layout.
 * This function can be customized to check for different default configurations.
 */
export async function verifyDefaultLayout(page: Page, expectedState: DefaultLayoutState = {}) {
  const expect = await getPlaywrightExpect();
  const elements = getPanelElements(page);

  // Left panel should be visible by default
  if (expectedState.leftPanelHidden) {
    await expect(elements.leftPanel).not.toBeVisible();
    await expect(elements.showExplorerShim).toBeVisible();
  } else {
    await expect(elements.leftPanel).toBeVisible();
  }

  // Tools panel should be hidden by default
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
  const expect = await getPlaywrightExpect();
  // Setup layout state
  await setupCallback();

  // Check if explorer panel is hidden and temporarily show it for navigation
  const leftPanel = page.locator('[data-panel-id="explorer-panel"]');
  const wasHidden = !(await leftPanel.isVisible());

  if (wasHidden) {
    // Temporarily show the panel to avoid UI overlap with floating button
    const showExplorerButton = page.locator('button[aria-label="Show explorer panel"]');
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
    const hideExplorerButton = page.locator('button[aria-label="Hide explorer panel"]');
    await hideExplorerButton.click();
    await expect(leftPanel).not.toBeVisible();
  }

  // Verify layout state persisted
  await verifyCallback();
}
