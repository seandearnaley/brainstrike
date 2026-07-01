import type { BrowserContext, Locator, Page } from '@playwright/test';
import { loadElectronHelpers } from './load-electron-helpers';

const isVerboseE2eLoggingEnabled = process.env['BRAINSTRIKE_E2E_VERBOSE'] === '1';
const DATABASE_PANEL_LOADING_TEXT = /^Loading database\.\.\.$/i;
const DATABASE_TAB_LOADING_TEST_ID = 'database-tab-loading';

function verboseLog(...args: unknown[]): void {
  if (!isVerboseE2eLoggingEnabled) {
    return;
  }
  console.log(...args);
}

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
    .or(page.getByRole('button', { name: 'Show agent panel' }))
    .or(page.locator('button[aria-label="Show agent panel"]'));
  const hideSidebarButton = page
    .locator('[data-testid="hide-threads-panel"]')
    .or(page.getByRole('button', { name: 'Hide agent panel' }))
    .or(page.locator('button[aria-label="Hide agent panel"]'));

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
      console.warn('⚠️ Agent sidebar controls not found; waiting for panel to appear.');
    }
  }

  await sidebarPanel.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
    console.warn('⚠️ Agent sidebar did not become visible after request.');
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

  const filtersButton = page.getByRole('button', { name: /view filters/i });
  if (await filtersButton.isVisible().catch(() => false)) {
    return;
  }

  const selectRootButton = page
    .getByRole('button', { name: /add folder to workspace|browse/i })
    .first();
  await selectRootButton.waitFor({ state: 'visible', timeout: 10_000 });
  await selectRootButton.click();
  await filtersButton.waitFor({ state: 'visible', timeout: 15_000 });
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
      .locator('#context-explorer-middle-panel, #middle-panel')
      .waitFor({ state: 'attached', timeout: tabTimeoutMs })
      .catch(() => {});

    activePage = await resolveActivePage(activePage);
    await ensureAgentSidebarVisible(activePage);

    const databaseTabTrigger = activePage
      .getByTestId('database-tab-trigger')
      .or(activePage.getByRole('tab', { name: 'Database' }));
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
      .waitFor({ state: 'visible', timeout: tabTimeoutMs })
      .catch(() => {
        console.warn('⚠️ Database panel did not become visible after selecting the database tab.');
      });

    // Wait for either the database demo panel OR the database error to be visible
    verboseLog('⏳ Waiting for database panel or error to be visible...');
    const loadingDatabaseCard = activePage.getByText(DATABASE_PANEL_LOADING_TEXT);
    const loadingTabFallback = activePage.getByTestId(DATABASE_TAB_LOADING_TEST_ID);

    // Wait for either the success state or error state
    // Increased timeout for fresh Electron restarts where database may take longer to initialize
    try {
      await Promise.race([
        activePage.locator('[data-testid="database-demo-panel"]').waitFor({
          state: 'visible',
          timeout: panelTimeoutMs,
        }),
        activePage.locator('[data-testid="db-init-error"]').waitFor({
          state: 'visible',
          timeout: panelTimeoutMs,
        }),
        loadingDatabaseCard.waitFor({
          state: 'visible',
          timeout: panelTimeoutMs,
        }),
        loadingTabFallback.waitFor({
          state: 'visible',
          timeout: panelTimeoutMs,
        }),
      ]);

      // Check which state we're in
      const hasSuccessPanel = await activePage
        .locator('[data-testid="database-demo-panel"]')
        .isVisible();
      const hasErrorPanel = await activePage.locator('[data-testid="db-init-error"]').isVisible();
      const hasLoadingCard = await loadingDatabaseCard.isVisible().catch(() => false);
      const hasLoadingFallback = await loadingTabFallback.isVisible().catch(() => false);

      if (hasSuccessPanel) {
        verboseLog('✅ Database demo panel is visible and ready');
      } else if (hasErrorPanel) {
        const errorText = await activePage.locator('[data-testid="db-init-error"]').textContent();
        verboseLog('⚠️ Database initialization failed:', errorText);
        verboseLog('✅ Database error panel is visible (this is expected in E2E environment)');
      } else if (hasLoadingCard) {
        verboseLog('⏳ Database still initializing (loading card visible)');
      } else if (hasLoadingFallback) {
        verboseLog('⏳ Database tab chunk still loading (fallback visible)');
      }

      return activePage;
    } catch (waitError) {
      console.warn('⚠️ Database panel did not appear within timeout, checking current state...');
      const bodyText = await activePage
        .locator('body')
        .textContent()
        .catch(() => 'Could not get body text');
      verboseLog('Current page content snippet:', bodyText?.slice(0, 500));

      if (attempt < 1 && activePage.isClosed()) {
        console.warn('⚠️ Active window closed; retrying database panel lookup.');
        continue;
      }

      if (attempt < 1) {
        await activePage.waitForTimeout(1000);
        continue;
      }

      throw waitError;
    }
  }

  return activePage;
}

/**
 * Wait for the database demo panel to be fully initialized and ready
 */
export async function waitForDatabaseReady(page: Page): Promise<Page> {
  const activePage = await resolveActivePage(page);
  await waitForAppReadyInHelpers(activePage);
  const errorPanel = activePage.locator('[data-testid="db-init-error"]');
  const successPanel = activePage.locator('[data-testid="database-demo-panel"]');
  const loadingTabFallback = activePage.getByTestId(DATABASE_TAB_LOADING_TEST_ID);
  // Check if we're in error state or success state
  const hasErrorPanel = await errorPanel.isVisible().catch(() => false);
  const hasSuccessPanel = await successPanel.isVisible().catch(() => false);

  if (hasErrorPanel) {
    verboseLog('⚠️ Database is in error state - skipping database readiness checks');
    return activePage; // Don't wait for database operations if we're in error state
  }

  if (!hasSuccessPanel) {
    // Wait for the database demo panel to be visible if it's not already
    // We race against the error panel to avoid waiting for timeout if error occurs
    await Promise.race([
      successPanel.waitFor({
        state: 'visible',
        timeout: 15_000,
      }),
      errorPanel.waitFor({
        state: 'visible',
        timeout: 15_000,
      }),
      loadingTabFallback.waitFor({
        state: 'visible',
        timeout: 15_000,
      }),
    ]).catch(() => {
      // Ignore timeout errors here, we'll check visibility next
    });
  }

  if (await errorPanel.isVisible().catch(() => false)) {
    console.log('⚠️ Database entered error state during initialization - skipping readiness checks');
    return activePage;
  }

  // Wait for any loading states to complete
  const loadingIndicator = activePage.getByText(DATABASE_PANEL_LOADING_TEXT);
  try {
    // If loading indicator is visible, wait for it to disappear
    if (await loadingIndicator.isVisible({ timeout: 1000 })) {
      console.log('⏳ Waiting for database to finish loading...');
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 30_000 });
    }
  } catch {
    // Loading indicator might not appear if database loads quickly
    console.log('⚡ Database loaded quickly or loading indicator not found');
  }

  try {
    if (await loadingTabFallback.isVisible({ timeout: 1000 })) {
      console.log('⏳ Waiting for database tab chunk to finish loading...');
      await Promise.race([
        successPanel.waitFor({ state: 'visible', timeout: 20_000 }),
        errorPanel.waitFor({ state: 'visible', timeout: 20_000 }),
        loadingTabFallback.waitFor({ state: 'hidden', timeout: 20_000 }),
      ]);
    }
  } catch {
    console.log('⚡ Database tab chunk loaded quickly or fallback not found');
  }

  const statusConnected = activePage.locator('[data-testid="status-bar-db-connected"]');
  const statusDisconnected = activePage.locator('[data-testid="status-bar-db-disconnected"]');
  const statusLoading = activePage.locator('[data-testid="status-bar-db-loading"]');
  const refreshButton = activePage.locator('button:has-text("Refresh")');

  // Wait for connection status to be ready (either success or failure indicator)
  try {
    await Promise.race([
      statusConnected.waitFor({ state: 'visible', timeout: 20_000 }),
      statusDisconnected.waitFor({ state: 'visible', timeout: 20_000 }),
      statusLoading.waitFor({ state: 'visible', timeout: 20_000 }),
      refreshButton.waitFor({ state: 'visible', timeout: 20_000 }),
      errorPanel.waitFor({ state: 'visible', timeout: 20_000 }),
    ]);
  } catch {
    const bodyText = await activePage
      .locator('body')
      .textContent()
      .catch(() => 'Could not get body text');
    throw new Error(
      `Database readiness signals not found (status bar, refresh button, or error). Body snippet: ${bodyText?.slice(0, 300)}`
    );
  }

  if (await errorPanel.isVisible().catch(() => false)) {
    console.log('⚠️ Database is in error state after status check - skipping readiness checks');
    return activePage;
  }

  if (await statusLoading.isVisible().catch(() => false)) {
    try {
      await Promise.race([
        statusConnected.waitFor({ state: 'visible', timeout: 20_000 }),
        statusDisconnected.waitFor({ state: 'visible', timeout: 20_000 }),
        refreshButton.waitFor({ state: 'visible', timeout: 20_000 }),
        errorPanel.waitFor({ state: 'visible', timeout: 20_000 }),
      ]);
    } catch {
      const bodyText = await activePage
        .locator('body')
        .textContent()
        .catch(() => 'Could not get body text');
      throw new Error(
        `Database stayed in loading state without resolving (connected/disconnected/refresh). Body snippet: ${bodyText?.slice(0, 300)}`
      );
    }
  }

  if (await errorPanel.isVisible().catch(() => false)) {
    verboseLog('⚠️ Database is in error state after loading - skipping readiness checks');
    return activePage;
  }

  // Additional wait to ensure database operations are ready
  if (!activePage.isClosed()) {
    await activePage.waitForTimeout(2000); // Increased from 1s to 2s
  }

  // Final check: ensure the panel is interactive
  try {
    await refreshButton.waitFor({ state: 'visible', timeout: 5000 });
    verboseLog('✅ Database panel is ready and interactive');
  } catch {
    console.warn('⚠️ Refresh button not found, database panel might not be fully loaded');
  }

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
  const loadingIndicator = activePage.getByText(DATABASE_PANEL_LOADING_TEXT);
  const loadingTabFallback = activePage.getByTestId(DATABASE_TAB_LOADING_TEST_ID);

  const waitForButton = async (): Promise<Locator> => {
    const refreshButton = resolveButton();
    await refreshButton.waitFor({ state: 'visible', timeout: timeoutMs });
    return refreshButton;
  };

  try {
    return { page: activePage, button: await waitForButton() };
  } catch {
    if (await errorPanel.isVisible().catch(() => false)) {
      return { page: activePage, button: resolveButton() };
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
      return { page: activePage, button: await waitForButton() };
    } catch {
      console.warn('⚠️ Refresh button not visible, reopening database panel...');
      const reopened = await showDatabaseDemoPanel(activePage);
      activePage = await waitForDatabaseReady(reopened);
      const refreshButton = activePage.locator('button:has-text("Refresh")').first();
      await refreshButton.waitFor({ state: 'visible', timeout: timeoutMs });
      return { page: activePage, button: refreshButton };
    }
  }
}

/**
 * Clear all records from the database for testing using bulk delete
 */
export async function clearDatabaseRecords(page: Page): Promise<Page> {
  let activePage = await resolveActivePage(page);
  try {
    verboseLog('🧹 Starting efficient database record cleanup...');

    if (await isDatabaseErrorState(activePage)) {
      verboseLog('ℹ️ Database in error state; skipping record cleanup.');
      return activePage;
    }

    // Try using the bulk delete API (available in Electron environment)
    verboseLog('🚀 Attempting bulk delete via Electron API...');
    try {
      const result = await activePage.evaluate(async () => {
        // Check if we're in Electron and have the API available
        if (typeof window !== 'undefined' && (window as any).electronAPI?.db?.clearAll) {
          return await (window as any).electronAPI.db.clearAll('CONFIRM_CLEAR_DATABASE');
        }
        return { success: false, message: 'Bulk delete API not available' };
      });

      if (result.success) {
        verboseLog(`✅ Bulk delete successful: ${result.message}`);
        const remainingCount = await activePage.evaluate(async () => {
          const api = (
            window as unknown as {
              electronAPI?: {
                db?: { query?: (sql: string) => Promise<{ rows: { count: number }[] }> };
              };
            }
          ).electronAPI;
          if (!api?.db?.query) {
            return null;
          }
          const result = await api.db.query('SELECT COUNT(*)::int AS count FROM file_records');
          return result.rows[0]?.count ?? null;
        });

        if (typeof remainingCount === 'number') {
          verboseLog(`📊 Records remaining after bulk delete (API): ${remainingCount}`);
          if (remainingCount === 0) {
            verboseLog('✅ Database cleanup completed successfully');
            return activePage;
          }
        } else {
          console.warn('⚠️ Could not verify record count via API after bulk delete');
        }

        verboseLog('⚠️ Records still remain, continuing with UI cleanup...');
      } else {
        console.warn(`⚠️ Bulk delete failed: ${result.message}, falling back to UI deletion`);
      }
    } catch (bulkError) {
      console.warn('⚠️ Bulk delete API failed, falling back to UI deletion:', bulkError);
    }

    // Fallback to UI-based deletion (much slower but works in all environments)
    verboseLog('🔄 Using UI-based deletion fallback...');
    activePage = await clearDatabaseRecordsViaUI(activePage);
    return activePage;
  } catch (error) {
    console.error('❌ Database cleanup failed:', error);
    throw error;
  }
}

/**
 * Clear records via UI interaction (fallback method)
 */
async function clearDatabaseRecordsViaUI(page: Page): Promise<Page> {
  let activePage = await resolveActivePage(page);
  if (activePage.isClosed()) {
    activePage = await resolveActivePage(page);
  }

  if (await isDatabaseErrorState(activePage)) {
    console.log('ℹ️ Database in error state; UI cleanup skipped.');
    return activePage;
  }

  let refresh = await resolveRefreshButton(activePage, { timeoutMs: 20_000 });
  activePage = refresh.page;
  let refreshButton = refresh.button;

  // First refresh to ensure we see all current records
  console.log('🔄 Refreshing records...');
  try {
    await refreshButton.click({ timeout: 5000 });
    if (!activePage.isClosed()) {
      await activePage.waitForTimeout(800);
    }
  } catch {
    console.warn('⚠️ Refresh click failed; reinitializing panel...');
    refresh = await resolveRefreshButton(activePage);
    activePage = refresh.page;
    refreshButton = refresh.button;
    await refreshButton.click({ timeout: 5000 });
    if (!activePage.isClosed()) {
      await activePage.waitForTimeout(800);
    }
  }

  // Check initial record count
  const initialCount = await activePage.locator('tbody tr').count();
  console.log(`📊 Found ${initialCount} records to clear via UI`);

  if (initialCount === 0) {
    console.log('✅ No records to clear');
    return activePage;
  }

  // Limit UI deletion to prevent crashes from too many records
  const maxUIDeletes = 50;
  if (initialCount > maxUIDeletes) {
    console.warn(
      `⚠️ Too many records (${initialCount}) for safe UI deletion. Consider using bulk delete API.`
    );
    throw new Error(
      `Cannot safely delete ${initialCount} records via UI. Use bulk delete instead.`
    );
  }

  // Delete records one by one with better error handling
  let attempts = 0;
  const maxAttempts = Math.min(initialCount + 3, maxUIDeletes);

  while (attempts < maxAttempts) {
    try {
      const deleteButtons = activePage.locator('tbody tr button[title="Remove record"]');
      const count = await deleteButtons.count();

      if (count === 0) {
        console.log('✅ All records cleared via UI');
        break;
      }

      console.log(`🗑️ Deleting record via UI (${attempts + 1}/${maxAttempts}), ${count} remaining`);

      // Click the first delete button
      await deleteButtons.first().click();
      await page.waitForTimeout(300);

      attempts++;
    } catch (error) {
      console.warn(`⚠️ Error during UI deletion attempt ${attempts + 1}:`, error);

      // Check if the page/app is still responsive
      try {
        await activePage.locator('[data-testid="database-demo-panel"]').waitFor({
          state: 'visible',
          timeout: 2000,
        });
      } catch {
        console.error('❌ App appears to have crashed during UI cleanup');
        throw new Error('Application crashed during database record cleanup');
      }

      attempts++;
      if (attempts >= maxAttempts) {
        console.warn('⚠️ Max UI cleanup attempts reached');
        break;
      }
    }
  }

  return activePage;
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

async function isDatabaseErrorState(page: Page): Promise<boolean> {
  try {
    const errorPanel = page.locator('[data-testid="db-init-error"]');
    return await errorPanel.isVisible({ timeout: 200 }).catch(() => false);
  } catch {
    return false;
  }
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
    panel: page.locator('[data-testid="database-demo-panel"]'),
    importButton: page.locator('button:has-text("Import")'),
    refreshButton: page.locator('button:has-text("Refresh")'),
    tableRows: page.locator('tbody tr'),
    deleteButtons: page.locator('tbody tr button[title="Remove record"]'),
    connectionStatus: page
      .locator('[data-testid="status-bar-db-connected"]')
      .or(page.locator('[data-testid="status-bar-db-disconnected"]'))
      .or(page.locator('[data-testid="status-bar-db-loading"]'))
      .first(),
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
