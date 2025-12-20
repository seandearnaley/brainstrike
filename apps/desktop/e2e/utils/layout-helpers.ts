import type { BrowserContext, Locator, Page } from '@playwright/test';

/**
 * Layout test utilities for Desktop E2E panel testing
 * Adapted from web E2E helpers for Electron-specific needs
 */

/**
 * Navigate to and show the database demo panel in the right panel
 */
export async function showDatabaseDemoPanel(page: Page): Promise<Page> {
  let activePage = await resolveActivePage(page);
  console.log('🗄️ Navigating to database demo panel...');

  for (let attempt = 0; attempt < 2; attempt++) {
    activePage = await resolveActivePage(activePage);
    await activePage
      .locator('[data-panel-id="middle-panel"]')
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => {});

    // First, check if the right panel is already visible
    const rightPanel = activePage.locator('[data-panel-id="right-panel"]');
    const showRightPanelButton = activePage
      .locator('[data-testid="show-right-panel"]')
      .or(activePage.locator('button[aria-label="Show right panel"]'));
    const hideRightPanelButton = activePage
      .locator('[data-testid="hide-right-panel"]')
      .or(activePage.locator('button[aria-label="Hide right panel"]'));
    let rightPanelVisible = await rightPanel.isVisible().catch(() => false);

    // If we cannot determine visibility yet, fall back to checking the hide button
    if (!rightPanelVisible) {
      rightPanelVisible = (await hideRightPanelButton.count()) > 0;
    }

    if (!rightPanelVisible) {
      console.log('👉 Showing right panel...');
      if ((await showRightPanelButton.count()) > 0) {
        await showRightPanelButton.first().click();
        await rightPanel.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
          console.warn('⚠️ Right panel did not become visible after clicking show button.');
        });
      } else {
        console.warn('⚠️ Show right panel button not found; waiting for panel to appear.');
        await rightPanel.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {
          console.warn('⚠️ Right panel still not visible after waiting.');
        });
      }
    }

    if (!activePage.isClosed()) {
      // Wait a moment for panel to stabilize
      await activePage.waitForTimeout(500);
    }

    // Now navigate to the database tab within the right panel
    console.log('🗂️ Clicking database tab...');
    const tabScope = rightPanel.locator('[role="tablist"]').first();
    const databaseTab = tabScope
      .locator('button[value="database"]')
      .or(tabScope.locator('[data-value="database"]'))
      .or(tabScope.getByRole('tab', { name: /db|database/i }))
      .or(rightPanel.locator('button[value="database"]'));

    await databaseTab
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {
        console.warn('⚠️ Database tab not visible yet; proceeding with click attempt.');
      });
    await databaseTab
      .first()
      .click()
      .catch((clickError) => {
        console.warn('⚠️ Failed to click database tab:', clickError);
      });

    // Wait for either the database demo panel OR the database error to be visible
    console.log('⏳ Waiting for database panel or error to be visible...');

    // Wait for either the success state or error state
    // Increased timeout for fresh Electron restarts where database may take longer to initialize
    try {
      await Promise.race([
        activePage.locator('[data-testid="database-demo-panel"]').waitFor({
          state: 'visible',
          timeout: 45_000,
        }),
        activePage.locator('[data-testid="db-init-error"]').waitFor({
          state: 'visible',
          timeout: 45_000,
        }),
      ]);

      // Check which state we're in
      const hasSuccessPanel = await activePage
        .locator('[data-testid="database-demo-panel"]')
        .isVisible();
      const hasErrorPanel = await activePage.locator('[data-testid="db-init-error"]').isVisible();

      if (hasSuccessPanel) {
        console.log('✅ Database demo panel is visible and ready');
      } else if (hasErrorPanel) {
        const errorText = await activePage.locator('[data-testid="db-init-error"]').textContent();
        console.log('⚠️ Database initialization failed:', errorText);
        console.log('✅ Database error panel is visible (this is expected in E2E environment)');
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
  // Check if we're in error state or success state
  const hasErrorPanel = await activePage.locator('[data-testid="db-init-error"]').isVisible();
  const hasSuccessPanel = await activePage
    .locator('[data-testid="database-demo-panel"]')
    .isVisible();

  if (hasErrorPanel) {
    console.log('⚠️ Database is in error state - skipping database readiness checks');
    return activePage; // Don't wait for database operations if we're in error state
  }

  if (!hasSuccessPanel) {
    // Wait for the database demo panel to be visible if it's not already
    // We race against the error panel to avoid waiting for timeout if error occurs
    await Promise.race([
      activePage.locator('[data-testid="database-demo-panel"]').waitFor({
        state: 'visible',
        timeout: 15_000,
      }),
      activePage.locator('[data-testid="db-init-error"]').waitFor({
        state: 'visible',
        timeout: 15_000,
      }),
    ]).catch(() => {
      // Ignore timeout errors here, we'll check visibility next
    });
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

  // Wait for connection status to be ready (either success or failure indicator)
  // Try multiple approaches to detect database readiness
  try {
    await activePage.locator('text=✓').or(activePage.locator('text=✗')).first().waitFor({
      state: 'visible',
      timeout: 20_000, // Increased timeout for database initialization
    });
  } catch (_error) {
    console.warn('⚠️ Database status indicator not found, trying alternative detection...');

    // Alternative: wait for any database-related text or UI elements
    const databaseReady = activePage
      .locator('text=Database')
      .or(activePage.locator('text=connected'))
      .or(activePage.locator('[data-testid="database-content"]'));
    await databaseReady.first().waitFor({
      state: 'visible',
      timeout: 10_000,
    });
  }

  // Additional wait to ensure database operations are ready
  if (!activePage.isClosed()) {
    await activePage.waitForTimeout(2000); // Increased from 1s to 2s
  }

  // Final check: ensure the panel is interactive
  try {
    await activePage
      .locator('button:has-text("Refresh")')
      .waitFor({ state: 'visible', timeout: 5000 });
    console.log('✅ Database panel is ready and interactive');
  } catch (_error) {
    console.warn('⚠️ Refresh button not found, database panel might not be fully loaded');
  }

  return activePage;
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

        // Refresh the UI to reflect the changes
        await activePage.click('button:has-text("Refresh")');
        if (!activePage.isClosed()) {
          await activePage.waitForTimeout(1000); // Give time for UI to update
        }

        const remainingCount = await activePage.locator('tbody tr').count();
        console.log(`📊 Records remaining after bulk delete: ${remainingCount}`);

        if (remainingCount === 0) {
          console.log('✅ Database cleanup completed successfully');
          return activePage;
        }
        console.log(`⚠️ ${remainingCount} records still remain, continuing with UI cleanup...`);
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

  const resolveRefreshButton = async (pageRef: Page): Promise<{ page: Page; button: Locator }> => {
    const button = pageRef.locator('button:has-text("Refresh")').first();
    try {
      await button.waitFor({ state: 'visible', timeout: 5000 });
      return { page: pageRef, button };
    } catch (_error) {
      console.warn('⚠️ Refresh button not visible, reopening database panel...');
      const reopened = await showDatabaseDemoPanel(pageRef);
      const ready = await waitForDatabaseReady(reopened);
      const refreshed = ready.locator('button:has-text("Refresh")').first();
      await refreshed.waitFor({ state: 'visible', timeout: 5000 });
      return { page: ready, button: refreshed };
    }
  };

  let refresh = await resolveRefreshButton(activePage);
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
    importButton: page.locator('button:has-text("Import Selected Files")'),
    refreshButton: page.locator('button:has-text("Refresh")'),
    tableRows: page.locator('tbody tr'),
    deleteButtons: page.locator('tbody tr button[title="Remove record"]'),
    connectionStatus: page.locator('text=✓').or(page.locator('text=✗')).first(),
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
