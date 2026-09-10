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

export const CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR = [
  '#context-explorer-tools-panel',
  '[data-panel-id="context-explorer-tools-panel"]',
  '#tools-panel',
  '[data-panel-id="tools-panel"]',
].join(', ');

export function getContextExplorerRightResizeHandle(page: Page) {
  return page
    .locator(CONTEXT_EXPLORER_RIGHT_PANEL_SELECTOR)
    .locator('xpath=preceding-sibling::*[@data-separator][1]');
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
    consolePanel: page.locator(CONTEXT_EXPLORER_CONSOLE_PANEL_SELECTOR),

    // Hide buttons (when panels are open)
    hideAgentPanelButton: page.locator('[data-testid="hide-threads-panel"]'),
    hideConsoleButton: page.locator('[data-testid="hide-console-panel"]'),
    hideRightPanelButton: page.locator('[data-testid="hide-workspace-panel"]'),
    // Main panels - v4 uses id attribute for panel identification
    leftPanel: page.locator(AGENT_SIDEBAR_PANEL_SELECTOR),
    mainContentPanel: page.locator(AGENT_MAIN_PANEL_SELECTOR),
    middlePanel: page.locator(AGENT_MIDDLE_PANEL_SELECTOR),
    rightPanel: page.locator(AGENT_WORKSPACE_PANEL_SELECTOR),

    // Show shims (when panels are closed)
    showAgentPanelShim: page.locator('[data-testid="show-threads-panel"]'),
    showConsoleShim: page.locator('[data-testid="show-console-panel"]'),
    showRightPanelShim: page.locator('[data-testid="show-workspace-panel"]'),
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
          error: errorMessage,
          timeoutMs: networkIdleTimeout,
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
        error: errorMessage,
        isCI,
        selector: `${AGENT_MAIN_PANEL_SELECTOR}, ${CONTEXT_EXPLORER_MAIN_PANEL_SELECTOR}`,
        timeoutMs: effectiveTimeout,
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
    .getByRole('button', { exact: true, name: 'Context Explorer' })
    .and(page.locator('[aria-current="page"]'));
}

export async function waitForContextExplorerPage(page: Page, timeout = 15_000): Promise<void> {
  const expect = await getPlaywrightExpect();
  await expect(contextExplorerActiveNavLocator(page)).toBeVisible({ timeout });
}

/**
 * Single source of truth for how Settings is reached.
 *
 * Settings is a full nav-rail route like Notes/Git/Browser (BST-1668 — the
 * #1626 profile-launched modal is gone): `RootLayoutContent` keeps the
 * `/settings` entry in `navigationItems`, ordered last, and mounts the page
 * through the same keep-mounted route wrapper as the other tabs
 * (`data-testid="settings-route"`). The account menu's "Settings…" entry still
 * exists and lands on the same route.
 *
 * Keep every Settings-launching path routed through these helpers so a future UI
 * change only has to update one place.
 */
export function profileMenuButtonLocator(page: Page) {
  return page.getByRole('button', { exact: true, name: 'Open profile menu' });
}

export function settingsMenuItemLocator(page: Page) {
  return page.getByRole('menuitem', { name: /^Settings/ });
}

/**
 * The app's left nav rail (`NavigationSidebar`, `aria-label="Main navigation"`).
 * Every rail-item locator is scoped here so a settings category, a status-bar
 * control or an empty-state CTA that happens to be named "Settings" or
 * "Context Explorer" can never turn a navigation into a strict-mode violation.
 */
export function mainNavigationLocator(page: Page) {
  return page.getByRole('navigation', { exact: true, name: 'Main navigation' });
}

/** The rail destinations specs navigate to. */
export type MainNavigationItem = 'Context Explorer' | 'Settings';

/** ONE definition of a rail item's button — scoped to the rail landmark. */
export function mainNavigationButtonLocator(page: Page, label: MainNavigationItem) {
  return mainNavigationLocator(page).getByRole('button', { exact: true, name: label });
}

/**
 * The page's own `h1`. The settings route is `display: none` whenever another
 * tab is active (keep-mounted, hidden), so the heading's visibility doubles as
 * the on/off-route signal.
 */
export function settingsHeadingLocator(page: Page) {
  return page.getByRole('heading', { exact: true, level: 1, name: 'Settings' });
}

export async function isSettingsPageOpen(page: Page): Promise<boolean> {
  return page.getByTestId('settings-route').isVisible();
}

/**
 * Every Radix floating surface that participates in the DismissableLayer stack.
 * Portals append at mount, so the LAST match in document order is the layer
 * that opened most recently.
 */
const FLOATING_LAYER_SELECTOR = [
  '[data-slot="dialog-content"]',
  '[data-slot="select-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="context-menu-content"]',
].join(', ');

type LayerReadiness =
  | 'no-modal-beneath'
  | 'not-registered'
  | 'not-topmost'
  | 'ready'
  | 'target-missing';

/**
 * Waits until Radix has registered `targetSelector` as the topmost layer, so a
 * dismissal aimed at it cannot be routed somewhere else.
 *
 * `DismissableLayer` keeps its stack in a module-level `Set` that it mutates in
 * an EFFECT but reads during RENDER, so a freshly mounted layer paints one
 * frame at `index === -1`: `pointer-events: none` on the layer that just
 * opened. Keyboard dismissal keys off the same stack, so an Escape inside that
 * window goes to the layer UNDERNEATH. While Settings was a modal (#1626 until
 * BST-1668) that closed the whole modal and unmounted the nested surface with
 * it — both panels vanished and the assertion saw zero. Measured on the old
 * `settings-modal-layering` spec: the pre-settle snapshot appeared in 3 of 6
 * runs and correlated exactly with the failure.
 *
 * Readiness is `pointer-events: auto` ON THE TARGET, not a shape imposed on the
 * whole stack. Radix computes `index >= indexOf(highestLayerWithOutsidePointer
 * EventsDisabled)`, so an unregistered layer resolves `none` and a registered
 * one resolves `auto` — for modal and NON-modal layers alike. Requiring "every
 * layer beneath is none" would be wrong: `Popover` is a bare
 * `PopoverPrimitive.Root` (`packages/ui/src/popover.tsx`), i.e. Radix's default
 * `modal={false}`, so it never disables outside pointer events and the dialog
 * under it keeps `auto` forever. `DialogContent`, `SelectContent` and
 * `DropdownMenu` (Radix default `modal={true}`) do disable them.
 *
 * Naming the target is what keeps this from passing vacuously: a predicate over
 * "whatever currently matches" is satisfied by the dialog alone whenever the
 * new layer has not mounted yet — precisely the window it exists to close.
 *
 * When `targetSelector` can match more than one open layer (nested dialogs both
 * carry `data-slot="dialog-content"`), the caller must first assert the new one
 * exists — `expect(panels).toHaveCount(2)` — because "last match" cannot tell
 * "not open yet" from "open".
 *
 * Two known limits, neither reachable from the current callers:
 * - "last match is topmost" assumes the layer PORTALS to `document.body`.
 *   `packages/ui/src/model-picker/model-picker.tsx:86` deliberately sets
 *   `portal={false}` to stay inside the parent Dialog's RemoveScroll allow-list;
 *   such a layer sits inside its dialog in document order, so with two dialogs
 *   open the ordering premise breaks.
 * - Radix submenu surfaces (`*-sub-content`) are not listed: they are not
 *   separate DismissableLayers, and adding them unverified would be guesswork.
 */
export async function waitForFloatingLayerStack(
  page: Page,
  targetSelector: string,
  timeout = 5000
): Promise<void> {
  const readiness = (): Promise<LayerReadiness> =>
    page.evaluate(
      ([all, target]: readonly string[]): LayerReadiness => {
        const layers = Array.from(document.querySelectorAll(all as string));
        // LAST match, not first: the target is by definition the most recently
        // opened layer, and a slot like `dialog-content` matches every dialog on
        // screen. `querySelector` would resolve to the one UNDERNEATH.
        const node = Array.from(document.querySelectorAll(target as string)).at(-1);
        if (!node) {
          return 'target-missing';
        }
        if (layers.at(-1) !== node) {
          return 'not-topmost';
        }
        // Radix sets this while ANY layer disables outside pointer events. With
        // no such layer the `auto` check below is trivially true and would wait
        // on nothing, so say that instead of reporting a false ready.
        // Radix sets this while ANY layer disables outside pointer events, and
        // only then does it write `pointerEvents` on the layers themselves. With
        // no such layer there is no signal at all, so say that rather than
        // reporting a false ready.
        if (document.body.style.pointerEvents !== 'none') {
          return 'no-modal-beneath';
        }
        // Radix's OWN bookkeeping, read from the inline style it writes on the
        // layer node — not the computed value. Computed style is not a
        // registration signal: `model-picker.tsx` hardcodes `pointer-events-auto`
        // on its PopoverContent, which would read `auto` before registration,
        // and a `portal={false}` layer inherits whatever its ancestor dialog has.
        return (node as HTMLElement).style.pointerEvents === 'auto' ? 'ready' : 'not-registered';
      },
      [FLOATING_LAYER_SELECTOR, targetSelector] as const
    );

  const deadline = Date.now() + timeout;
  let last: LayerReadiness = 'target-missing';

  while (Date.now() < deadline) {
    // Deliberately not `waitForFunction`: its rejection is indistinguishable
    // from a navigation tearing down the execution context, and reporting that
    // as a layer-ownership defect sends the next reader down the wrong path.
    last = await readiness();
    if (last === 'ready') {
      return;
    }
    if (last === 'no-modal-beneath') {
      throw new Error(
        `waitForFloatingLayerStack("${targetSelector}") needs a modal layer open beneath the target — ` +
          'Radix only assigns pointer-events while some layer disables outside pointer events, so ' +
          'there is no readiness signal to wait on here and the wait would pass vacuously.'
      );
    }
    await page.waitForTimeout(25);
  }

  const measured = await page.evaluate(
    (selector: string) =>
      Array.from(document.querySelectorAll(selector)).map((layer) => ({
        inlinePointerEvents: (layer as HTMLElement).style.pointerEvents || '(unset)',
        slot: layer.getAttribute('data-slot'),
        zIndex: globalThis.getComputedStyle(layer).zIndex,
      })),
    FLOATING_LAYER_SELECTOR
  );

  const reason: Record<Exclude<LayerReadiness, 'no-modal-beneath' | 'ready'>, string> = {
    'not-registered': `"${targetSelector}" is topmost but never gained pointer-events. A PERMANENT stall here is a real layer-ownership defect, not a timing problem.`,
    'not-topmost': `"${targetSelector}" is open but is not the last floating layer in document order — something opened above it.`,
    'target-missing': `Nothing matched "${targetSelector}" — the interaction that should have opened it probably did not.`,
  };

  throw new Error(
    `waitForFloatingLayerStack("${targetSelector}") gave up after ${timeout}ms: ${reason[last]} ` +
      `Measured layers: ${JSON.stringify(measured)}.`
  );
}

/**
 * Navigate onto the Settings route via the nav rail. Throws when Settings is
 * already the active route so a spec cannot drift out of sync with the UI and
 * keep passing on a redundant open.
 */
export async function openSettingsPage(page: Page): Promise<void> {
  if (await isSettingsPageOpen(page)) {
    throw new Error(
      'openSettingsPage(page) was called while Settings is already the active route. Drop the redundant open, or leaveSettingsPage(page) first.'
    );
  }

  await activateSidebarNavigation(page, 'Settings');
}

/**
 * Leave the Settings route for the Context Explorer and wait for the settings
 * page to be hidden. Throws when Settings is not the active route so callers
 * cannot silently drift out of sync with the UI.
 *
 * Settings is a keep-mounted route, so "leaving" hides the page rather than
 * unmounting it — a spec that needs a fresh settings page must reload.
 */
export async function leaveSettingsPage(page: Page, timeout = 15_000): Promise<void> {
  const expect = await getPlaywrightExpect();

  if (!(await isSettingsPageOpen(page))) {
    throw new Error(
      'leaveSettingsPage(page) was called while Settings is not the active route. Remove the redundant call, or open Settings first.'
    );
  }

  const heading = settingsHeadingLocator(page);
  await expect(heading).toBeVisible({ timeout });

  await activateSidebarNavigation(page, 'Context Explorer');
  await expect(heading).not.toBeVisible({ timeout });
}

export async function waitForSettingsPage(page: Page, timeout = 15_000): Promise<void> {
  const expect = await getPlaywrightExpect();
  const loadingFallback = page.getByTestId('web-settings-page-loading');

  if (await loadingFallback.isVisible().catch(() => false)) {
    await expect(loadingFallback).not.toBeVisible({ timeout });
  }

  await expect(settingsHeadingLocator(page)).toBeVisible({
    timeout,
  });
}

/**
 * Assert the Appearance settings section is the ACTIVE category and return
 * its locator. SettingsPageContent renders only the active category (selected
 * from the `#settings/<id>` hash, first category as the fallback), so specs
 * that assume Appearance must say so here — a default-category change then
 * fails at this named point instead of one interaction later.
 */
export async function waitForAppearanceSection(page: Page) {
  const expect = await getPlaywrightExpect();
  const appearanceSection = page.getByTestId('settings-category-appearance');
  await expect(appearanceSection).toBeVisible();
  return appearanceSection;
}

/**
 * Click a theme button inside the Appearance section. Scoped to the section
 * so the nav sidebar's theme toggle can never match; dispatchEvent because a
 * plain click can land on the focus ring while the route settles. The ONE
 * appearance-theme flow both theme specs share (review finding on #2138 —
 * previously three near-verbatim copies).
 */
export async function activateAppearanceThemeButton(
  page: Page,
  label: 'Dark' | 'Light' | 'System'
): Promise<void> {
  const expect = await getPlaywrightExpect();
  const appearanceSection = await waitForAppearanceSection(page);
  const themeButton = appearanceSection.getByRole('button', { exact: true, name: label });
  await expect(themeButton).toBeVisible();
  await themeButton.dispatchEvent('click');
}

/**
 * Select a palette card inside the Appearance section. Cards are radios in
 * the "Theme" radiogroup; dispatchEvent for the same reason as the mode
 * buttons (a plain click can land on the focus ring while the route settles).
 */
export async function activateAppearanceThemeCard(
  page: Page,
  label: 'Brainstrike' | 'Ember' | 'Tide' | 'Orchid'
): Promise<void> {
  const expect = await getPlaywrightExpect();
  const appearanceSection = await waitForAppearanceSection(page);
  const card = appearanceSection.getByRole('radio', { exact: true, name: label });
  await expect(card).toBeVisible();
  await card.dispatchEvent('click');
}

/**
 * Activate a sidebar navigation destination. Settings is a rail item like the
 * rest (BST-1668); {@link openSettingsPage} is this plus the redundant-open
 * guard, and is what specs should call.
 */
export async function activateSidebarNavigation(
  page: Page,
  label: MainNavigationItem
): Promise<void> {
  const expect = await getPlaywrightExpect();

  const navigationButton = mainNavigationButtonLocator(page, label);
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
