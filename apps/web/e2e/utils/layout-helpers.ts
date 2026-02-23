import type { Page } from '@playwright/test';

/**
 * Layout test utilities for IDE panel testing
 */

type PlaywrightExpect = typeof import('@playwright/test').expect;
interface ScopedLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

let cachedExpect: PlaywrightExpect | null = null;
let cachedLogger: Promise<ScopedLogger> | null = null;
const DEFAULT_LOCAL_APP_LOAD_TIMEOUT_MS = 20_000;
const DEFAULT_CI_APP_LOAD_TIMEOUT_MS = 55_000;
const DEFAULT_LOCAL_NETWORK_IDLE_TIMEOUT_MS = 2000;
const DEFAULT_CI_NETWORK_IDLE_TIMEOUT_MS = 5000;

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getLogger(): Promise<ScopedLogger> {
  if (!cachedLogger) {
    cachedLogger = import('@brainstrike/utils')
      .then((mod) => mod.createLogger('E2ELayoutHelpers'))
      .catch(() => ({
        warn: () => undefined,
      }));
  }
  return cachedLogger;
}

function logWarn(message: string, context?: Record<string, unknown>): void {
  void getLogger().then((logger) => logger.warn(message, context));
}

export function resolveWaitForAppLoadTimeout(timeout: number, isCI: boolean): number {
  return isCI
    ? Math.max(timeout, DEFAULT_CI_APP_LOAD_TIMEOUT_MS)
    : Math.max(timeout, DEFAULT_LOCAL_APP_LOAD_TIMEOUT_MS);
}

export function resolveNetworkIdleTimeout(isCI: boolean): number {
  return isCI ? DEFAULT_CI_NETWORK_IDLE_TIMEOUT_MS : DEFAULT_LOCAL_NETWORK_IDLE_TIMEOUT_MS;
}

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
 * Note: react-resizable-panels v4 uses id="panel-name" with data-panel="true" as boolean marker
 */
export function getPanelElements(page: Page): PanelElements {
  return {
    // Main panels - v4 uses id attribute for panel identification
    leftPanel: page.locator('#explorer-panel, [data-panel-id="explorer-panel"]'),
    rightPanel: page.locator('#tools-panel, [data-panel-id="tools-panel"]'),
    consolePanel: page.locator(
      '#console-panel, #console-panel-horizontal, [data-panel-id="console-panel"], [data-panel-id="console-panel-horizontal"]'
    ),
    mainContentPanel: page.locator('#main-content-panel, [data-panel-id="main-content-panel"]'),
    middlePanel: page.locator('#middle-panel, [data-panel-id="middle-panel"]'),

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
      logWarn('Unable to find "Show tools panel" control; assuming panel is already visible.');
      return;
    }
  }

  await elements.rightPanel.waitFor({ state: 'visible', timeout }).catch(() => {
    logWarn('Tools panel did not become visible after requesting to show it.');
  });
}

/**
 * Waits for the main application content to be ready.
 * This is useful to ensure tests don't start before the UI is fully initialized.
 *
 * In CI with vite preview (production build), React needs time to hydrate after
 * the initial HTML loads. This function handles the full hydration cycle.
 */
export async function waitForAppLoad(page: Page, timeout = 10_000) {
  const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
  // Contract:
  // - Local runs use a 20s floor to tolerate hydration + initial panel layout.
  // - CI runs use a 55s floor for slower runners and production bundle startup.
  // Caller-provided timeout can only raise these floors, never lower them.
  const effectiveTimeout = resolveWaitForAppLoadTimeout(timeout, isCI);
  const panelReadySelector = [
    '#middle-panel',
    '[data-panel-id="middle-panel"]',
    '#main-content-panel',
    '[data-panel-id="main-content-panel"]',
    'h1:has-text("Context Explorer")',
  ].join(', ');

  // Collect console errors and network failures in CI for debugging
  // Set up listeners BEFORE waiting for load states to capture all events
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];

  if (isCI) {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(`[${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`[pageerror] ${err.message}`);
    });
    page.on('requestfailed', (request) => {
      networkFailures.push(`${request.failure()?.errorText ?? 'unknown'}: ${request.url()}`);
    });
  }

  // Wait for the page to fully load, including JS execution
  // Using 'load' instead of 'domcontentloaded' to ensure JS has loaded
  await page.waitForLoadState('load', { timeout: effectiveTimeout });

  // Best-effort wait for network to settle - important for production builds
  // that may have deferred script loading. Use short timeout since apps with
  // background workers often never reach networkidle state.
  const networkIdleTimeout = resolveNetworkIdleTimeout(isCI);
  await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout }).catch((error) => {
    // networkidle timeout is expected when app has background activity - continue
    if (isCI) {
      const errorMessage = resolveErrorMessage(error);
      console.warn(
        `[waitForAppLoad] networkidle wait exceeded ${networkIdleTimeout}ms; continuing. ${errorMessage}`
      );
      logWarn('waitForAppLoad networkidle timeout', {
        timeoutMs: networkIdleTimeout,
        error: errorMessage,
      });
    }
  });

  // Wait for the main layout structure to be present
  // Note: react-resizable-panels v4 uses id="panel-name" with data-panel="true" as boolean marker
  try {
    await page.waitForSelector(panelReadySelector, {
      state: 'attached',
      timeout: effectiveTimeout,
    });
  } catch (error) {
    // Debug: Log page content on failure to help diagnose CI issues
    if (isCI) {
      const bodyHTML = await page.evaluate(
        () => document.body?.innerHTML?.slice(0, 1000) || 'no body'
      );
      const hasRoot = await page.evaluate(() => !!document.getElementById('root'));
      const rootContent = await page.evaluate(
        () => document.getElementById('root')?.innerHTML?.slice(0, 500) || 'empty'
      );
      const scriptTags = await page.evaluate(() =>
        Array.from(document.querySelectorAll('script')).map((s) => ({
          src: s.src || '[inline]',
          type: s.type || 'text/javascript',
        }))
      );
      console.error('[waitForAppLoad] Debug info on failure:');
      console.error(`  hasRoot: ${hasRoot}`);
      console.error(`  rootContent: ${rootContent}`);
      console.error(`  bodyHTML: ${bodyHTML}`);
      console.error(`  scriptTags: ${JSON.stringify(scriptTags)}`);
      console.error(
        `  consoleErrors (${consoleErrors.length}): ${consoleErrors.join('; ') || 'none'}`
      );
      console.error(
        `  networkFailures (${networkFailures.length}): ${networkFailures.join('; ') || 'none'}`
      );
    }
    throw error;
  }

  // Also ensure the main content panel is present when panel IDs are available.
  await page
    .waitForSelector('#main-content-panel, [data-panel-id="main-content-panel"]', {
      state: 'attached',
      timeout: effectiveTimeout,
    })
    .catch((error) => {
      const errorMessage = resolveErrorMessage(error);
      logWarn('Main content panel selector did not attach after primary readiness check.', {
        selector: '#main-content-panel, [data-panel-id="main-content-panel"]',
        timeoutMs: effectiveTimeout,
        isCI,
        error: errorMessage,
      });
      if (isCI) {
        console.warn(
          `[waitForAppLoad] main-content selector missing after readiness check (timeout ${effectiveTimeout}ms). ${errorMessage}`
        );
      }
      // Some environments expose the main shell without explicit panel IDs.
      // The readiness selector above already validated visible app content.
    });
}

/**
 * Clear layout state and reload page with clean state
 */
export async function resetLayoutState(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('panel-layout-store.v1');
  });
  // Wait for the page to finish navigating before continuing.
  // Using 'load' to ensure JS bundles are loaded before checking React elements.
  await page.reload({ waitUntil: 'load' });
  await waitForAppLoad(page);
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
 * Corrupt localStorage for testing error handling
 */
export async function corruptLayoutStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('panel-layout-store.v1', 'invalid-json');
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
