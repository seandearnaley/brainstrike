import type { BrowserContext, Locator, Page } from '@playwright/test';
import { waitForAppReady } from './electron-helpers';

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

export async function ensureToolsPanelVisible(page: Page): Promise<Locator> {
  await ensureExplorerVisible(page);
  // Use id selector for react-resizable-panels v4 compatibility
  const rightPanel = page.locator('#tools-panel');
  const showRightPanelButton = page
    .locator('[data-testid="show-tools-panel"]')
    .or(page.getByRole('button', { name: 'Show tools panel' }))
    .or(page.locator('button[aria-label="Show tools panel"]'));
  const hideRightPanelButton = page
    .locator('[data-testid="hide-tools-panel"]')
    .or(page.getByRole('button', { name: 'Hide tools panel' }))
    .or(page.locator('button[aria-label="Hide tools panel"]'));

  const panelBox = await rightPanel.boundingBox().catch(() => null);
  const rightPanelVisible = Boolean(panelBox && panelBox.width > 5 && panelBox.height > 5);

  if (!rightPanelVisible) {
    if ((await showRightPanelButton.count()) > 0) {
      console.log('👉 Showing tools panel...');
      await showRightPanelButton.first().click();
    } else if ((await hideRightPanelButton.count()) > 0) {
      console.log('👉 Re-toggling tools panel to expand...');
      await hideRightPanelButton.first().click();
      await showRightPanelButton.first().click();
    } else {
      console.warn('⚠️ Tools panel controls not found; waiting for panel to appear.');
    }
  }

  await rightPanel.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
    console.warn('⚠️ Tools panel did not become visible after request.');
  });

  return rightPanel;
}

/**
 * Navigate to and show the database demo panel in the right panel
 */
export async function showDatabaseDemoPanel(
  page: Page,
  options?: { tabTimeoutMs?: number; panelTimeoutMs?: number }
): Promise<Page> {
  let activePage = await resolveActivePage(page);
  console.log('🗄️ Navigating to database demo panel...');
  const tabTimeoutMs = options?.tabTimeoutMs ?? 10_000;
  const panelTimeoutMs = options?.panelTimeoutMs ?? 45_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    activePage = await resolveActivePage(activePage);
    await waitForAppReady(activePage);
    // Use id selector for react-resizable-panels v4 compatibility
    await activePage
      .locator('#middle-panel')
      .waitFor({ state: 'attached', timeout: tabTimeoutMs })
      .catch(() => {});

    const rightPanel = await ensureToolsPanelVisible(activePage);

    if (!activePage.isClosed()) {
      // Wait a moment for panel to stabilize
      await activePage.waitForTimeout(500);
    }

    // Now navigate to the database tab within the tools panel
    console.log('🗂️ Clicking database tab...');
    const tabScope = rightPanel.locator('[role="tablist"]').first();
    const databaseTab = tabScope
      .locator('button[value="database"]')
      .or(tabScope.locator('[data-value="database"]'))
      .or(tabScope.getByRole('tab', { name: /db|database/i }))
      .or(rightPanel.locator('button[value="database"]'));

    await databaseTab
      .first()
      .waitFor({ state: 'visible', timeout: tabTimeoutMs })
      .catch(() => {
        console.warn('⚠️ Database tab not visible yet; proceeding with click attempt.');
      });
    await databaseTab
      .first()
      .click()
      .catch((clickError) => {
        console.warn('⚠️ Failed to click database tab:', clickError);
      });
    const activeDatabaseTab = rightPanel
      .locator('[role="tablist"] [role="tab"][data-state="active"]')
      .filter({ hasText: /db|database/i })
      .or(rightPanel.locator('button[value="database"][data-state="active"]'))
      .or(rightPanel.locator('[data-value="database"][data-state="active"]'));
    await activeDatabaseTab
      .first()
      .waitFor({ state: 'visible', timeout: tabTimeoutMs })
      .catch(() => {
        console.warn('⚠️ Database tab did not become active after click.');
      });

    // Wait for either the database demo panel OR the database error to be visible
    console.log('⏳ Waiting for database panel or error to be visible...');
    const loadingDatabaseCard = activePage.getByText(/Loading PGlite database/i);
    const loadingTabFallback = activePage.getByText(/Loading DB UI/i);

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
        console.log('✅ Database demo panel is visible and ready');
      } else if (hasErrorPanel) {
        const errorText = await activePage.locator('[data-testid="db-init-error"]').textContent();
        console.log('⚠️ Database initialization failed:', errorText);
        console.log('✅ Database error panel is visible (this is expected in E2E environment)');
      } else if (hasLoadingCard) {
        console.log('⏳ Database still initializing (loading card visible)');
      } else if (hasLoadingFallback) {
        console.log('⏳ Database tab chunk still loading (fallback visible)');
      }

      return activePage;
    } catch (waitError) {
      console.warn('⚠️ Database panel did not appear within timeout, checking current state...');
      const bodyText = await activePage
        .locator('body')
        .textContent()
        .catch(() => 'Could not get body text');
      console.log('Current page content snippet:', bodyText?.slice(0, 500));

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
  await waitForAppReady(activePage);
  const errorPanel = activePage.locator('[data-testid="db-init-error"]');
  const successPanel = activePage.locator('[data-testid="database-demo-panel"]');
  const loadingTabFallback = activePage.getByText(/Loading DB UI/i);
  // Check if we're in error state or success state
  const hasErrorPanel = await errorPanel.isVisible().catch(() => false);
  const hasSuccessPanel = await successPanel.isVisible().catch(() => false);

  if (hasErrorPanel) {
    console.log('⚠️ Database is in error state - skipping database readiness checks');
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
  const loadingIndicator = activePage.locator('text=Loading PGlite database...');
  try {
    // If loading indicator is visible, wait for it to disappear
    if (await loadingIndicator.isVisible({ timeout: 1000 })) {
      console.log('⏳ Waiting for database to finish loading...');
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 30_000 });
    }
  } catch (_error) {
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
  } catch (_error) {
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
  } catch (_error) {
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
    } catch (_error) {
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
    console.log('⚠️ Database is in error state after loading - skipping readiness checks');
    return activePage;
  }

  // Additional wait to ensure database operations are ready
  if (!activePage.isClosed()) {
    await activePage.waitForTimeout(2000); // Increased from 1s to 2s
  }

  // Final check: ensure the panel is interactive
  try {
    await refreshButton.waitFor({ state: 'visible', timeout: 5000 });
    console.log('✅ Database panel is ready and interactive');
  } catch (_error) {
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
  const loadingIndicator = activePage.getByText(/Loading PGlite database/i);
  const loadingTabFallback = activePage.getByText(/Loading DB UI/i);

  const waitForButton = async (): Promise<Locator> => {
    const refreshButton = resolveButton();
    await refreshButton.waitFor({ state: 'visible', timeout: timeoutMs });
    return refreshButton;
  };

  try {
    return { page: activePage, button: await waitForButton() };
  } catch (_error) {
    if (await errorPanel.isVisible().catch(() => false)) {
      return { page: activePage, button: resolveButton() };
    }

    try {
      if (await loadingTabFallback.isVisible({ timeout: 1000 })) {
        await loadingTabFallback.waitFor({ state: 'hidden', timeout: timeoutMs });
      }
    } catch (_fallbackError) {
      // ignore and proceed to the loading indicator
    }

    try {
      if (await loadingIndicator.isVisible({ timeout: 1000 })) {
        await loadingIndicator.waitFor({ state: 'hidden', timeout: timeoutMs });
      }
    } catch (_loadingError) {
      // ignore and proceed
    }

    try {
      return { page: activePage, button: await waitForButton() };
    } catch (_retryError) {
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
    console.log('🧹 Starting efficient database record cleanup...');

    if (await isDatabaseErrorState(activePage)) {
      console.log('ℹ️ Database in error state; skipping record cleanup.');
      return activePage;
    }

    // Try using the bulk delete API (available in Electron environment)
    console.log('🚀 Attempting bulk delete via Electron API...');
    try {
      const result = await activePage.evaluate(async () => {
        // Check if we're in Electron and have the API available
        if (typeof window !== 'undefined' && (window as any).electronAPI?.db?.clearAll) {
          return await (window as any).electronAPI.db.clearAll('CONFIRM_CLEAR_DATABASE');
        }
        return { success: false, message: 'Bulk delete API not available' };
      });

      if (result.success) {
        console.log(`✅ Bulk delete successful: ${result.message}`);
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
          console.log(`📊 Records remaining after bulk delete (API): ${remainingCount}`);
          if (remainingCount === 0) {
            console.log('✅ Database cleanup completed successfully');
            return activePage;
          }
        } else {
          console.warn('⚠️ Could not verify record count via API after bulk delete');
        }

        console.log('⚠️ Records still remain, continuing with UI cleanup...');
      } else {
        console.warn(`⚠️ Bulk delete failed: ${result.message}, falling back to UI deletion`);
      }
    } catch (bulkError) {
      console.warn('⚠️ Bulk delete API failed, falling back to UI deletion:', bulkError);
    }

    // Fallback to UI-based deletion (much slower but works in all environments)
    console.log('🔄 Using UI-based deletion fallback...');
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
  } catch (_clickError) {
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
      } catch (_pageError) {
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
    } catch (_error) {
      // Ignore load state errors; the page may already be ready.
    }
    return page;
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
        } catch (_error) {
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
