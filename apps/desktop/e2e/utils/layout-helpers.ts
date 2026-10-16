import { type BrowserContext, expect, type Locator, type Page } from '@playwright/test';
import { loadElectronHelpers } from './load-electron-helpers';

/**
 * Expands the activity in `region` unless it already is: activity is collapsed
 * by default, and a delegation's card (its "Open … conversation" button) is inside it.
 */
export async function ensureActivityExpanded(region: Locator): Promise<void> {
  const expand = region.getByRole('button', { exact: true, name: 'Expand activity' });
  const collapse = region.getByRole('button', { exact: true, name: 'Collapse activity' });
  await expect(expand.or(collapse)).toBeVisible();
  if (await expand.count()) {
    await expand.click();
    return;
  }
  await expect(collapse).toBeVisible();
}

const isVerboseE2eLoggingEnabled = process.env['BRAINSTRIKE_E2E_VERBOSE'] === '1';

function verboseLog(...args: unknown[]): void {
  if (!isVerboseE2eLoggingEnabled) {
    return;
  }
  console.log(...args);
}

/**
 * The app's middle panel, named by the prefix `IdeLayout` derives its panel ids
 * from. `agent-workspace-layout.tsx` passes `panelIdPrefix="agent-workspace"`;
 * the bare `#middle-panel` is the unprefixed default, kept for any surface that
 * renders `IdeLayout` without a prefix.
 *
 * NOT `#context-explorer-middle-panel`: BST-2018 removed the nested explorer
 * layout, so that id no longer renders anywhere (pinned by
 * `root-layout-content.test.tsx`, which asserts no `IdeLayout` is given the
 * `context-explorer` prefix). The web helpers' AGENT_MIDDLE_PANEL_SELECTOR is
 * the same set.
 */
const AGENT_MIDDLE_PANEL_SELECTOR = [
  '#agent-workspace-middle-panel',
  '[data-panel-id="agent-workspace-middle-panel"]',
  '#middle-panel',
  '[data-panel-id="middle-panel"]',
].join(', ');

async function waitForAppReadyInHelpers(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
}

/**
 * Layout test utilities for Desktop E2E panel testing
 * Adapted from web E2E helpers for Electron-specific needs
 *
 * Note: react-resizable-panels v4 uses id="panel-name" with data-panel="true" as boolean marker
 * instead of custom data-panel-id attributes. Use #panel-name selectors.
 */

async function ensureExplorerVisible(page: Page): Promise<void> {
  const explorerSection = page.locator('[data-testid="explorer-section"]');
  const isExplorerVisible = await explorerSection.isVisible().catch(() => false);
  if (isExplorerVisible) {
    return;
  }

  const explorerButton = page
    .getByRole('button', { name: /context explorer/i })
    .or(page.getByRole('link', { name: /context explorer/i }))
    .or(page.getByRole('button', { name: /explorer/i }))
    .or(page.getByRole('link', { name: /explorer/i }));

  if ((await explorerButton.count()) > 0) {
    await explorerButton.first().click();
    await explorerSection.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
      console.warn('⚠️ Explorer section did not become visible after navigation click.');
    });
  }
}

async function ensureAgentSidebarVisible(page: Page): Promise<Locator> {
  await ensureExplorerVisible(page);
  const sidebarPanel = page.locator('#agent-workspace-explorer-panel');
  const showSidebarButton = page
    .locator('[data-testid="show-threads-panel"]')
    .or(page.getByRole('button', { name: 'Show library panel' }))
    .or(page.locator('button[aria-label="Show library panel"]'));
  const hideSidebarButton = page
    .locator('[data-testid="hide-threads-panel"]')
    .or(page.getByRole('button', { name: 'Hide library panel' }))
    .or(page.locator('button[aria-label="Hide library panel"]'));

  const panelBox = await sidebarPanel.boundingBox().catch(() => null);
  const sidebarVisible = Boolean(panelBox && panelBox.width > 5 && panelBox.height > 5);

  if (!sidebarVisible) {
    if ((await showSidebarButton.count()) > 0) {
      verboseLog('👉 Showing agent sidebar...');
      await showSidebarButton.first().click();
    } else if ((await hideSidebarButton.count()) > 0) {
      verboseLog('👉 Re-toggling agent sidebar to expand...');
      await hideSidebarButton.first().click();
      await showSidebarButton.first().click();
    } else {
      console.warn('⚠️ Library panel controls not found; waiting for panel to appear.');
    }
  }

  await sidebarPanel.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
    console.warn('⚠️ Library panel did not become visible after request.');
  });

  return sidebarPanel;
}

export async function ensureAssistantShellVisible(page: Page): Promise<Locator> {
  await ensureExplorerVisible(page);
  const assistantShell = page.locator('[data-testid="assistant-chat-card"]');
  try {
    // The assistant is the explorer route's primary surface, not a collapsible side panel,
    // so there is no show/hide control to click here. Visibility is purely route-driven.
    await assistantShell.waitFor({ state: 'visible', timeout: 12_000 });
  } catch {
    throw new Error(
      `Assistant shell did not become visible after navigating to Context Explorer (current URL: ${page.url()}).`
    );
  }
  return assistantShell;
}

export async function ensureMockWorkspaceOpen(page: Page): Promise<void> {
  await ensureExplorerVisible(page);

  const responsiveExplorerActions = page
    .getByRole('button', { name: /view filters/i })
    .or(page.getByRole('button', { name: /more explorer actions/i }))
    .filter({ visible: true });
  if (await responsiveExplorerActions.isVisible().catch(() => false)) {
    return;
  }

  // The real toolbar button is FileExplorerStrings.addFolderToWorkspace
  // ('Add Folder to Workspace'); '^browse$' is a legacy exact-match fallback.
  // It MUST stay anchored: an unanchored /browse/i also matches the 'Browser'
  // nav-rail item (BST-1174), and .first() would then click Browser and
  // navigate away from the explorer instead of adding a root.
  const selectRootButton = page
    .getByRole('button', { name: /add folder to workspace|^browse$/i })
    .first();
  await selectRootButton.waitFor({ state: 'visible', timeout: 10_000 });
  await selectRootButton.click();
  await responsiveExplorerActions.waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Navigate to and show the database demo panel in the right panel
 */
export async function showDatabaseDemoPanel(
  page: Page,
  options?: { tabTimeoutMs?: number; panelTimeoutMs?: number }
): Promise<Page> {
  let activePage = await resolveActivePage(page);
  verboseLog('🗄️ Navigating to database demo panel...');
  const tabTimeoutMs = options?.tabTimeoutMs ?? 10_000;
  const panelTimeoutMs = options?.panelTimeoutMs ?? 45_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    activePage = await resolveActivePage(activePage);
    await waitForAppReadyInHelpers(activePage);
    await activePage
      .locator(AGENT_MIDDLE_PANEL_SELECTOR)
      .waitFor({ state: 'attached', timeout: tabTimeoutMs });

    activePage = await resolveActivePage(activePage);
    await ensureAgentSidebarVisible(activePage);

    const databaseTabTrigger = activePage
      .getByTestId('database-tab-trigger')
      .or(activePage.getByRole('tab', { name: 'Collections' }));
    await databaseTabTrigger.waitFor({ state: 'visible', timeout: tabTimeoutMs });
    await databaseTabTrigger.click();

    if (!activePage.isClosed()) {
      // Wait a moment for panel to stabilize
      try {
        await activePage.waitForTimeout(500);
      } catch (error) {
        if (activePage.isClosed()) {
          activePage = await resolveActivePage(activePage);
          await ensureAgentSidebarVisible(activePage);
        } else {
          throw error;
        }
      }
    }

    verboseLog('🗂️ Waiting for database sidebar tab...');
    await activePage
      .locator('[data-testid="database-panel"]')
      .waitFor({ state: 'visible', timeout: tabTimeoutMs });

    // Loading placeholders are observations, not terminal states. Returning while
    // one is visible lets callers race controls that have not mounted yet.
    verboseLog('⏳ Waiting for a terminal database panel state...');
    const databasePanel = activePage.locator('[data-testid="database-demo-panel"]');
    const readyControl = databasePanel.getByRole('button', {
      exact: true,
      name: 'Refresh',
    });
    const errorPanel = activePage.locator('[data-testid="db-init-error"]');
    const terminalState = readyControl.or(errorPanel).filter({ visible: true });
    const loadingDatabaseCard = activePage.getByText(/Loading PGlite database/i);
    const loadingTabFallback = activePage.getByText(/Loading DB UI/i);

    try {
      await terminalState.first().waitFor({ state: 'visible', timeout: panelTimeoutMs });

      const hasReadyControl = await readyControl.isVisible();
      const hasErrorPanel = await errorPanel.isVisible();
      const hasLoadingCard = await loadingDatabaseCard.isVisible().catch(() => false);
      const hasLoadingFallback = await loadingTabFallback.isVisible().catch(() => false);

      if (hasReadyControl && !hasErrorPanel) {
        verboseLog('✅ Database demo panel is visible and ready');
        return activePage;
      }

      if (hasErrorPanel && !hasReadyControl) {
        const errorText = await errorPanel.textContent();
        verboseLog('⚠️ Database initialization failed:', errorText);
        return activePage;
      }

      throw new Error(
        `Expected exactly one visible terminal database state (ready control: ${hasReadyControl}; error: ${hasErrorPanel}; loading database: ${hasLoadingCard}; loading tab: ${hasLoadingFallback}).`
      );
    } catch (waitError) {
      if (activePage.isClosed() && attempt < 1) {
        console.warn('⚠️ Active window closed; retrying database panel lookup.');
        continue;
      }

      if (!(waitError instanceof Error) || waitError.name !== 'TimeoutError') {
        throw waitError;
      }

      console.warn('⚠️ Database panel did not reach a terminal state within timeout.');
      const bodyText = await activePage
        .locator('body')
        .textContent()
        .catch(() => 'Could not get body text');
      verboseLog('Current page content snippet:', bodyText?.slice(0, 500));

      throw waitError;
    }
  }

  throw new Error('Database panel navigation exhausted without reaching a terminal state.');
}

/**
 * Wait for the database demo panel to be fully initialized and ready
 */
export async function waitForDatabaseReady(page: Page): Promise<Page> {
  const activePage = await resolveActivePage(page);
  await waitForAppReadyInHelpers(activePage);
  const errorPanel = activePage.locator('[data-testid="db-init-error"]');
  const databasePanel = activePage.locator('[data-testid="database-demo-panel"]');
  const refreshButton = databasePanel.getByRole('button', {
    exact: true,
    name: 'Refresh',
  });
  const statusConnected = activePage.locator('[data-testid="status-bar-db-connected"]');
  const statusDisconnected = activePage.locator('[data-testid="status-bar-db-disconnected"]');
  const statusLoading = activePage.locator('[data-testid="status-bar-db-loading"]');
  const loadingIndicator = activePage.getByText(/Loading PGlite database/i);

  if (await errorPanel.isVisible()) {
    verboseLog('⚠️ Database is in error state - skipping database readiness checks');
    return activePage;
  }

  if (await refreshButton.isVisible()) {
    verboseLog('✅ Database panel is ready and interactive');
    return activePage;
  }

  try {
    await refreshButton
      .or(errorPanel)
      .or(statusConnected)
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    const bodyText = await activePage
      .locator('body')
      .textContent()
      .catch(() => 'Could not get body text');
    throw new Error(
      `Database readiness signals not found (connected status, Refresh control, or database error; loading status: ${await statusLoading.isVisible()}; disconnected status: ${await statusDisconnected.isVisible()}; loading panel: ${await loadingIndicator.isVisible()}). Body snippet: ${bodyText?.slice(0, 300)}`,
      { cause: error }
    );
  }

  if (await errorPanel.isVisible()) {
    verboseLog('⚠️ Database entered an error state during initialization');
    return activePage;
  }

  if (await databasePanel.isVisible()) {
    try {
      await refreshButton
        .or(errorPanel)
        .filter({ visible: true })
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 });
    } catch (error) {
      const bodyText = await activePage
        .locator('body')
        .textContent()
        .catch(() => 'Could not get body text');
      throw new Error(
        `Mounted database panel stayed non-interactive (Refresh control or database error not found; loading panel: ${await loadingIndicator.isVisible()}). Body snippet: ${bodyText?.slice(0, 300)}`,
        { cause: error }
      );
    }

    if (await errorPanel.isVisible()) {
      verboseLog('⚠️ Database entered an error state while its panel was loading');
      return activePage;
    }

    await refreshButton.waitFor({ state: 'visible', timeout: 20_000 });
    verboseLog('✅ Database panel is ready and interactive');
    return activePage;
  }

  await statusConnected.waitFor({ state: 'visible', timeout: 20_000 });
  verboseLog('✅ Database is connected without mounting the Collections panel');
  return activePage;
}

export async function resolveRefreshButton(
  page: Page,
  options?: { timeoutMs?: number }
): Promise<{ page: Page; button: Locator }> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  let activePage = await resolveActivePage(page);

  const resolveButton = () => activePage.locator('button:has-text("Refresh")').first();
  const errorPanel = activePage.locator('[data-testid="db-init-error"]');
  const loadingIndicator = activePage.getByText(/Loading PGlite database/i);
  const loadingTabFallback = activePage.getByText(/Loading DB UI/i);

  const waitForButton = async (): Promise<Locator> => {
    const refreshButton = resolveButton();
    await refreshButton.waitFor({ state: 'visible', timeout: timeoutMs });
    return refreshButton;
  };

  try {
    return { button: await waitForButton(), page: activePage };
  } catch {
    if (await errorPanel.isVisible().catch(() => false)) {
      return { button: resolveButton(), page: activePage };
    }

    try {
      if (await loadingTabFallback.isVisible({ timeout: 1000 })) {
        await loadingTabFallback.waitFor({ state: 'hidden', timeout: timeoutMs });
      }
    } catch {
      // ignore and proceed to the loading indicator
    }

    try {
      if (await loadingIndicator.isVisible({ timeout: 1000 })) {
        await loadingIndicator.waitFor({ state: 'hidden', timeout: timeoutMs });
      }
    } catch {
      // ignore and proceed
    }

    try {
      return { button: await waitForButton(), page: activePage };
    } catch {
      console.warn('⚠️ Refresh button not visible, reopening database panel...');
      const reopened = await showDatabaseDemoPanel(activePage);
      activePage = await waitForDatabaseReady(reopened);
      const refreshButton = activePage.locator('button:has-text("Refresh")').first();
      await refreshButton.waitFor({ state: 'visible', timeout: timeoutMs });
      return { button: refreshButton, page: activePage };
    }
  }
}

/** Clear retained desktop content through the visible action and join its new document. */
export async function clearDatabaseRecords(page: Page): Promise<Page> {
  const activePage = await showDatabaseDemoPanel(await resolveActivePage(page));
  const clear = activePage.getByRole('button', { exact: true, name: 'Clear Database' });
  if (!(await clear.isVisible())) {
    await activePage.getByRole('button', { name: /Import settings/i }).click();
  }
  await expect(clear).toBeEnabled();
  await clear.click();
  // Main's reset coordinator reloads the same WebContents after physical owner
  // retirement. Subscribe before confirmation: the old document disappearing is
  // not proof that the replacement catalog has mounted.
  await Promise.all([
    activePage.waitForEvent('domcontentloaded'),
    activePage
      .getByRole('dialog')
      .getByRole('button', { exact: true, name: 'Clear Database' })
      .click(),
  ]);
  await waitForAppReadyInHelpers(activePage);
  await verifyClearedDesktopContent(activePage);
  return activePage;
}

export async function verifyClearedDesktopContent(page: Pick<Page, 'evaluate'>): Promise<void> {
  const remaining = await page.evaluate(async () => {
    if (!window.sourceFiles) {
      throw new Error('Canonical source capability missing after content clear');
    }
    return await window.sourceFiles.list().then((result) => {
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.value;
    });
  });
  expect(remaining).toEqual([]);
}

async function resolveActivePage(page: Page): Promise<Page> {
  if (!page.isClosed()) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      return page;
    } catch {
      if (!page.isClosed()) {
        // Ignore load state errors when the page is still alive; it may already be ready.
        return page;
      }
    }
  }

  console.warn('⚠️ Existing window closed; waiting for replacement...');
  const context = page.context();
  return waitForReplacementPage(context, page);
}

async function waitForReplacementPage(
  context: BrowserContext,
  closedPage: Page,
  timeoutMs = 15_000
): Promise<Page> {
  const browser = context.browser();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const contexts = browser ? browser.contexts() : [context];
    for (const ctx of contexts) {
      for (const candidate of ctx.pages()) {
        if (candidate === closedPage || candidate.isClosed()) {
          continue;
        }
        try {
          await candidate.waitForLoadState('domcontentloaded', { timeout: 5000 });
        } catch {
          // Ignore load-state errors; page may already be interactive.
        }
        return candidate;
      }
    }
    await sleep(200);
  }

  throw new Error('Unable to locate an active window after restart');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Get database panel elements for testing
 */
export function getDatabasePanelElements(page: Page) {
  return {
    connectionStatus: page
      .locator('[data-testid="status-bar-db-connected"]')
      .or(page.locator('[data-testid="status-bar-db-disconnected"]'))
      .or(page.locator('[data-testid="status-bar-db-loading"]'))
      .first(),
    // No import control here: the trigger lives in the explorer's selection
    // action bar (see utils/explorer-import.ts). No row/delete-button locators
    // either: the Collections tab has had no record table since BST-1213.
    panel: page.locator('[data-testid="database-demo-panel"]'),
    refreshButton: page.locator('button:has-text("Refresh")'),
    storageInfo: page.locator('text=NodeFS:').or(page.locator('text=IndexedDB')),
  };
}

/**
 * Reset database state for testing by navigating to panel and clearing all records
 */
export async function resetDatabaseForTest(page: Page): Promise<Page> {
  console.log('🔄 Resetting database state for test...');

  try {
    // Navigate to database panel
    let activePage = await showDatabaseDemoPanel(page);
    activePage = await waitForDatabaseReady(activePage);

    // Clear all existing records
    activePage = await clearDatabaseRecords(activePage);

    console.log('✅ Database reset completed');
    return activePage;
  } catch (error) {
    console.log('❌ Error during database reset:', error);
    throw error;
  }
}
