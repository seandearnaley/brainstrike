import type { Page } from '@playwright/test';

/**
 * Layout test utilities for IDE panel testing
 */

type PlaywrightExpect = typeof import('@playwright/test').expect;

let cachedExpect: PlaywrightExpect | null = null;
const DEFAULT_LOCAL_APP_LOAD_TIMEOUT_MS = 20_000;
const DEFAULT_CI_APP_LOAD_TIMEOUT_MS = 55_000;
const DEFAULT_LOCAL_DATABASE_READY_TIMEOUT_MS = 45_000;
const DEFAULT_CI_DATABASE_READY_TIMEOUT_MS = 55_000;
const DEFAULT_LOCAL_NETWORK_IDLE_TIMEOUT_MS = 2000;
const DEFAULT_CI_NETWORK_IDLE_TIMEOUT_MS = 5000;

export const AGENT_SIDEBAR_PANEL_SELECTOR = [
  '#agent-workspace-explorer-panel',
  '[data-panel-id="agent-workspace-explorer-panel"]',
  '#explorer-panel',
  '[data-panel-id="explorer-panel"]',
].join(', ');

export const AGENT_MAIN_PANEL_SELECTOR = [
  '#agent-workspace-main-content-panel',
  '[data-panel-id="agent-workspace-main-content-panel"]',
  '#main-content-panel',
  '[data-panel-id="main-content-panel"]',
].join(', ');

export const AGENT_MIDDLE_PANEL_SELECTOR = [
  '#agent-workspace-middle-panel',
  '[data-panel-id="agent-workspace-middle-panel"]',
  '#middle-panel',
  '[data-panel-id="middle-panel"]',
].join(', ');

export const AGENT_WORKSPACE_PANEL_SELECTOR = [
  '#agent-workspace-tools-panel',
  '[data-panel-id="agent-workspace-tools-panel"]',
  '#tools-panel',
  '[data-panel-id="tools-panel"]',
].join(', ');

export const CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR = [
  '#context-explorer-tools-panel',
  '[data-panel-id="context-explorer-tools-panel"]',
  '#context-explorer-explorer-panel',
  '[data-panel-id="context-explorer-explorer-panel"]',
  '#explorer-panel',
  '[data-panel-id="explorer-panel"]',
].join(', ');

/**
 * Resolve the resize handle that sits directly between the context explorer tree
 * and the preview area. Nested layouts make global separator ordering unreliable.
 */
export function getContextExplorerLeftResizeHandle(page: Page) {
  return page
    .locator(CONTEXT_EXPLORER_LEFT_PANEL_SELECTOR)
    .locator('xpath=following-sibling::*[@data-separator][1]');
}

export const CONTEXT_EXPLORER_MIDDLE_PANEL_SELECTOR = [
  '#context-explorer-middle-panel',
  '[data-panel-id="context-explorer-middle-panel"]',
  '#middle-panel',
  '[data-panel-id="middle-panel"]',
].join(', ');

export const CONTEXT_EXPLORER_MAIN_PANEL_SELECTOR = [
  '#context-explorer-main-content-panel',
  '[data-panel-id="context-explorer-main-content-panel"]',
  '#main-content-panel',
  '[data-panel-id="main-content-panel"]',
].join(', ');

export const CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR = [
  '#context-explorer-console-panel',
  '[data-panel-id="context-explorer-console-panel"]',
  '#console-panel',
  '[data-panel-id="console-panel"]',
].join(', ');

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logWarn(message: string, context?: Record<string, unknown>): void {
  const contextSuffix = context ? ` ${JSON.stringify(context)}` : '';
  console.warn(`[E2ELayoutHelpers] ${message}${contextSuffix}`);
}

export function resolveWaitForAppLoadTimeout(timeout: number, isCI: boolean): number {
  return isCI
    ? Math.max(timeout, DEFAULT_CI_APP_LOAD_TIMEOUT_MS)
    : Math.max(timeout, DEFAULT_LOCAL_APP_LOAD_TIMEOUT_MS);
}

export function resolveWaitForDatabaseReadyTimeout(timeout: number, isCI: boolean): number {
  return isCI
    ? Math.max(timeout, DEFAULT_CI_DATABASE_READY_TIMEOUT_MS)
    : Math.max(timeout, DEFAULT_LOCAL_DATABASE_READY_TIMEOUT_MS);
}

export function resolveNetworkIdleTimeout(isCI: boolean): number {
  return isCI ? DEFAULT_CI_NETWORK_IDLE_TIMEOUT_MS : DEFAULT_LOCAL_NETWORK_IDLE_TIMEOUT_MS;
}

type DatabaseReadyState = 'connected' | 'disconnected' | 'loading' | 'missing';

interface DatabaseReadinessSnapshot {
  readonly dbPath: string | null;
  readonly hasE2ETestHooks: boolean;
  readonly state: DatabaseReadyState;
  readonly statusText: string | null;
}

export interface WaitForAppLoadOptions {
  readonly timeoutMs?: number;
  readonly waitForDatabase?: boolean;
}

async function readDatabaseReadinessSnapshot(page: Page): Promise<DatabaseReadinessSnapshot> {
  return page.evaluate((): DatabaseReadinessSnapshot => {
    const connected = document.querySelector<HTMLElement>(
      '[data-testid="status-bar-db-connected"]'
    );
    const loading = document.querySelector<HTMLElement>('[data-testid="status-bar-db-loading"]');
    const disconnected = document.querySelector<HTMLElement>(
      '[data-testid="status-bar-db-disconnected"]'
    );
    const statusElement = connected ?? loading ?? disconnected;
    const statusText = statusElement?.textContent?.replace(/\s+/g, ' ').trim() ?? null;
    const e2eHooks = window.__brainstrikeWebE2ETestHooks__;
    const dbPath = typeof e2eHooks?.dbPath === 'string' ? e2eHooks.dbPath : null;

    if (connected) {
      return {
        dbPath,
        hasE2ETestHooks: Boolean(e2eHooks),
        state: 'connected',
        statusText,
      };
    }

    if (loading) {
      return {
        dbPath,
        hasE2ETestHooks: Boolean(e2eHooks),
        state: 'loading',
        statusText,
      };
    }

    if (disconnected) {
      return {
        dbPath,
        hasE2ETestHooks: Boolean(e2eHooks),
        state: 'disconnected',
        statusText,
      };
    }

    return {
      dbPath,
      hasE2ETestHooks: Boolean(e2eHooks),
      state: 'missing',
      statusText,
    };
  });
}

function formatDatabaseReadinessSnapshot(snapshot: DatabaseReadinessSnapshot): string {
  const parts = [`Last observed state was ${snapshot.state}.`];

  if (snapshot.statusText) {
    parts.push(`Status text: ${snapshot.statusText}`);
  }

  parts.push(`E2E hooks present: ${snapshot.hasE2ETestHooks ? 'yes' : 'no'}.`);

  if (snapshot.dbPath) {
    parts.push(`DB path: ${snapshot.dbPath}.`);
  }

  return parts.join(' ');
}

export async function waitForDatabaseReady(page: Page, timeout = 10_000): Promise<void> {
  const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
  const effectiveTimeout = resolveWaitForDatabaseReadyTimeout(timeout, isCI);
  try {
    const connectedHandle = await page.waitForFunction(
      (): boolean => Boolean(document.querySelector('[data-testid="status-bar-db-connected"]')),
      null,
      { timeout: effectiveTimeout }
    );
    await connectedHandle.dispose();
    return;
  } catch (error) {
    const snapshot = await readDatabaseReadinessSnapshot(page).catch(
      (): DatabaseReadinessSnapshot => ({
        dbPath: null,
        hasE2ETestHooks: false,
        state: 'missing',
        statusText: null,
      })
    );

    if (snapshot.state === 'connected') {
      return;
    }

    throw new Error(
      `Database failed to initialize before the app became test-ready. ${formatDatabaseReadinessSnapshot(
        snapshot
      )} Last wait error: ${resolveErrorMessage(error)}`
    );
  }
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
  consolePanel: ReturnType<Page['locator']>;
  hideAgentPanelButton: ReturnType<Page['locator']>;
  hideConsoleButton: ReturnType<Page['locator']>;
  hideRightPanelButton: ReturnType<Page['locator']>;
  leftPanel: ReturnType<Page['locator']>;
  mainContentPanel: ReturnType<Page['locator']>;
  middlePanel: ReturnType<Page['locator']>;
  rightPanel: ReturnType<Page['locator']>;
  showAgentPanelShim: ReturnType<Page['locator']>;
  showConsoleShim: ReturnType<Page['locator']>;
  showRightPanelShim: ReturnType<Page['locator']>;
}

/**
 * Get all panel-related elements for testing
 * Note: react-resizable-panels v4 uses id="panel-name" with data-panel="true" as boolean marker
 */
export function getPanelElements(page: Page): PanelElements {
  return {
    // Main panels - v4 uses id attribute for panel identification
    leftPanel: page.locator(AGENT_SIDEBAR_PANEL_SELECTOR),
    rightPanel: page.locator(AGENT_WORKSPACE_PANEL_SELECTOR),
    consolePanel: page.locator(CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR),
    mainContentPanel: page.locator(AGENT_MAIN_PANEL_SELECTOR),
    middlePanel: page.locator(AGENT_MIDDLE_PANEL_SELECTOR),

    // Hide buttons (when panels are open)
    hideAgentPanelButton: page.locator('[data-testid="hide-threads-panel"]'),
    hideRightPanelButton: page.locator('[data-testid="hide-workspace-panel"]'),
    hideConsoleButton: page.locator('[data-testid="hide-console-panel"]'),

    // Show shims (when panels are closed)
    showAgentPanelShim: page.locator('[data-testid="show-threads-panel"]'),
    showRightPanelShim: page.locator('[data-testid="show-workspace-panel"]'),
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
      .locator('button[aria-label="Show workspace panel"]')
      .or(page.getByRole('button', { name: 'Show workspace panel' }));

    if ((await showButton.count()) > 0) {
      await showButton.first().click();
    } else {
      logWarn('Unable to find right-panel show control; assuming panel is already visible.');
      return;
    }
  }

  await elements.rightPanel.waitFor({ state: 'visible', timeout }).catch(() => {
    logWarn('Right panel did not become visible after requesting to show it.');
  });
}

/**
 * Waits for the main application content to be ready.
 * This is useful to ensure tests don't start before the UI is fully initialized.
 *
 * In CI with vite preview (production build), React needs time to hydrate after
 * the initial HTML loads. This function handles the full hydration cycle.
 */
export async function waitForAppLoad(
  page: Page,
  options: WaitForAppLoadOptions = {}
): Promise<void> {
  const { timeoutMs = 10_000, waitForDatabase = true } = options;
  const isCI = process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true';
  // Contract:
  // - Local runs use a 20s floor to tolerate hydration + initial panel layout.
  // - CI runs use a 55s floor for slower runners and production bundle startup.
  // Caller-provided timeout can only raise these floors, never lower them.
  const effectiveTimeout = resolveWaitForAppLoadTimeout(timeoutMs, isCI);
  const panelReadySelector = [
    AGENT_MIDDLE_PANEL_SELECTOR,
    AGENT_MAIN_PANEL_SELECTOR,
    CONTEXT_EXPLORER_MIDDLE_PANEL_SELECTOR,
    CONTEXT_EXPLORER_MAIN_PANEL_SELECTOR,
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

  if (waitForDatabase) {
    // Best-effort wait for network to settle - important for production builds
    // that may have deferred script loading. Shell-only tests intentionally skip
    // this because greenfield DB worker startup keeps background network work
    // alive and can consume the entire Playwright test budget.
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
  }

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
    .waitForSelector(`${AGENT_MAIN_PANEL_SELECTOR}, ${CONTEXT_EXPLORER_MAIN_PANEL_SELECTOR}`, {
      state: 'attached',
      timeout: effectiveTimeout,
    })
    .catch((error) => {
      const errorMessage = resolveErrorMessage(error);
      logWarn('Main content panel selector did not attach after primary readiness check.', {
        selector: `${AGENT_MAIN_PANEL_SELECTOR}, ${CONTEXT_EXPLORER_MAIN_PANEL_SELECTOR}`,
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

  if (waitForDatabase) {
    await waitForDatabaseReady(page, timeoutMs);
  }
}

/**
 * Locator for the Context Explorer sidebar nav button when it is the active page.
 * The sidebar sets `aria-current="page"` on the active nav item — a stable,
 * semantically meaningful landmark that survives UI redesigns.
 */
export function contextExplorerActiveNavLocator(page: Page) {
  return page
    .getByRole('button', { name: 'Context Explorer', exact: true })
    .and(page.locator('[aria-current="page"]'));
}

export async function waitForContextExplorerPage(page: Page, timeout = 15_000): Promise<void> {
  const expect = await getPlaywrightExpect();
  await expect(contextExplorerActiveNavLocator(page)).toBeVisible({ timeout });
}

export async function waitForSettingsPage(page: Page, timeout = 15_000): Promise<void> {
  const expect = await getPlaywrightExpect();
  const loadingFallback = page.getByTestId('web-settings-page-loading');

  if (await loadingFallback.isVisible().catch(() => false)) {
    await expect(loadingFallback).not.toBeVisible({ timeout });
  }

  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({
    timeout,
  });
}

export async function activateSidebarNavigation(
  page: Page,
  label: 'Context Explorer' | 'Settings'
): Promise<void> {
  const expect = await getPlaywrightExpect();
  const navigationButton = page.getByRole('button', { name: label, exact: true });
  await expect(navigationButton).toBeVisible();
  await expect(navigationButton).toBeEnabled();
  // Playwright's native click retries kept racing this sidebar's rerender path.
  // These assertions intentionally cover the most important actionability checks
  // before we dispatch the click event deterministically.
  await navigationButton.dispatchEvent('click');
}

/**
 * Clear layout state and reload page with clean state
 */
export async function resetLayoutState(
  page: Page,
  options: WaitForAppLoadOptions = {}
): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('brainstrike.agent-sidebar-tab.v1');
    localStorage.removeItem('panel-layout-store.v1');
    localStorage.removeItem('context-explorer-layout-store.v1');
    localStorage.removeItem('tools-panel.v1');
  });
  // Wait for the page to finish navigating before continuing.
  // Using 'load' to ensure JS bundles are loaded before checking React elements.
  await page.reload({ waitUntil: 'load' });
  await waitForAppLoad(page, options);
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
  await expect(button).toBeEnabled();
  // Dispatch directly because restored layouts can leave shim toggles under sticky
  // containers even when Playwright considers them visible and stable.
  await button.dispatchEvent('click');
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
    localStorage.setItem('context-explorer-layout-store.v1', 'invalid-json');
  });
}

interface DefaultLayoutState {
  consoleHidden?: boolean;
  leftPanelHidden?: boolean;
  rightPanelHidden?: boolean;
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
    await expect(elements.showAgentPanelShim).toBeVisible();
  } else {
    await expect(elements.leftPanel).toBeVisible();
  }

  // Workspace panel is visible by default in the promoted agent shell.
  if (expectedState.rightPanelHidden) {
    await expect(elements.rightPanel).not.toBeVisible();
    await expect(elements.showRightPanelShim).toBeVisible();
  } else {
    await expect(elements.rightPanel).toBeVisible();
    await expect(elements.hideRightPanelButton).toBeVisible();
  }

  // The legacy console/file-editor panel is optional: workspace-tabs promotes file
  // tabs into the main Context Explorer surface, so newer builds do not render the
  // console panel or its show shim at all.
  if ((await elements.consolePanel.count()) > 0) {
    await expect(elements.consolePanel).not.toBeVisible();
  }
  if ((await elements.showConsoleShim.count()) > 0) {
    await expect(elements.showConsoleShim).toBeVisible();
  }
}
