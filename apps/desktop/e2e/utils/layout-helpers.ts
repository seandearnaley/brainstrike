import type { Page } from '@playwright/test';

/**
 * Layout test utilities for Desktop E2E panel testing
 * Adapted from web E2E helpers for Electron-specific needs
 */

/**
 * Navigate to and show the database demo panel in the right panel
 */
export async function showDatabaseDemoPanel(page: Page): Promise<void> {
  console.log('🗄️ Navigating to database demo panel...');
  
  // First, check if the right panel is already visible
  const rightPanel = page.locator('[data-panel-id="right-panel"]');
  const rightPanelVisible = await rightPanel.isVisible();

  if (!rightPanelVisible) {
    console.log('👉 Showing right panel...');
    // Show the right panel by clicking the show button
    const showRightPanelButton = page.locator('button[aria-label="Show right panel"]');
    await showRightPanelButton.click();

    // Wait for the right panel to be visible
    await rightPanel.waitFor({ state: 'visible', timeout: 8000 }); // Increased timeout
  }

  // Wait a moment for panel to stabilize
  await page.waitForTimeout(500);

  // Now navigate to the database tab within the right panel
  // Try multiple selectors for the database tab
  console.log('🗂️ Clicking database tab...');
  const databaseTab = page
    .locator('button[value="database"]')
    .or(page.locator('[value="database"]'))
    .or(page.locator('text=DB'))
    .or(page.locator('[role="tab"]:has-text("DB")'));

  await databaseTab.first().click();

  // Wait for the database demo panel to be visible with its testid
  console.log('⏳ Waiting for database panel to be visible...');
  await page.locator('[data-testid="database-demo-panel"]').waitFor({
    state: 'visible',
    timeout: 15000, // Increased timeout
  });
  
  console.log('✅ Database demo panel is visible');
}

/**
 * Wait for the database demo panel to be fully initialized and ready
 */
export async function waitForDatabaseReady(page: Page): Promise<void> {
  // Wait for the database demo panel to be visible
  await page.locator('[data-testid="database-demo-panel"]').waitFor({
    state: 'visible',
    timeout: 15000, // Increased timeout for slower startup
  });

  // Wait for any loading states to complete
  const loadingIndicator = page.locator('text=Loading PGlite database...');
  try {
    // If loading indicator is visible, wait for it to disappear
    if (await loadingIndicator.isVisible({ timeout: 1000 })) {
      console.log('⏳ Waiting for database to finish loading...');
      await loadingIndicator.waitFor({ state: 'hidden', timeout: 30000 });
    }
  } catch (error) {
    // Loading indicator might not appear if database loads quickly
    console.log('⚡ Database loaded quickly or loading indicator not found');
  }

  // Wait for connection status to be ready (either success or failure indicator)
  // Try multiple approaches to detect database readiness
  try {
    await page.locator('text=✓').or(page.locator('text=✗')).first().waitFor({
      state: 'visible',
      timeout: 20000, // Increased timeout for database initialization
    });
  } catch (error) {
    console.warn('⚠️ Database status indicator not found, trying alternative detection...');
    
    // Alternative: wait for any database-related text or UI elements
    const databaseReady = page.locator('text=Database').or(page.locator('text=connected')).or(page.locator('[data-testid="database-content"]'));
    await databaseReady.first().waitFor({
      state: 'visible',
      timeout: 10000,
    });
  }

  // Additional wait to ensure database operations are ready
  await page.waitForTimeout(2000); // Increased from 1s to 2s
  
  // Final check: ensure the panel is interactive
  try {
    await page.locator('button:has-text("Refresh")').waitFor({ state: 'visible', timeout: 5000 });
    console.log('✅ Database panel is ready and interactive');
  } catch (error) {
    console.warn('⚠️ Refresh button not found, database panel might not be fully loaded');
  }
}

/**
 * Clear all records from the database for testing using bulk delete
 */
export async function clearDatabaseRecords(page: Page): Promise<void> {
  try {
    console.log('🧹 Starting efficient database record cleanup...');
    
    // Try using the bulk delete API (available in Electron environment)
    console.log('🚀 Attempting bulk delete via Electron API...');
    try {
      const result = await page.evaluate(async () => {
        // Check if we're in Electron and have the API available
        // biome-ignore lint/suspicious/noExplicitAny: Window object type varies by environment
        if (typeof window !== 'undefined' && (window as any).electronAPI?.db?.clearAll) {
          // biome-ignore lint/suspicious/noExplicitAny: Window object type varies by environment
          return await (window as any).electronAPI.db.clearAll('CONFIRM_CLEAR_DATABASE');
        }
        return { success: false, message: 'Bulk delete API not available' };
      });
      
      if (result.success) {
        console.log(`✅ Bulk delete successful: ${result.message}`);
        
        // Refresh the UI to reflect the changes
        await page.click('button:has-text("Refresh")');
        await page.waitForTimeout(1000); // Give time for UI to update
        
        const remainingCount = await page.locator('tbody tr').count();
        console.log(`📊 Records remaining after bulk delete: ${remainingCount}`);
        
        if (remainingCount === 0) {
          console.log('✅ Database cleanup completed successfully');
          return;
        } else {
          console.log(`⚠️ ${remainingCount} records still remain, continuing with UI cleanup...`);
        }
      } else {
        console.warn(`⚠️ Bulk delete failed: ${result.message}, falling back to UI deletion`);
      }
    } catch (bulkError) {
      console.warn('⚠️ Bulk delete API failed, falling back to UI deletion:', bulkError);
    }
    
    // Fallback to UI-based deletion (much slower but works in all environments)
    console.log('🔄 Using UI-based deletion fallback...');
    await clearDatabaseRecordsViaUI(page);
    
  } catch (error) {
    console.error('❌ Database cleanup failed:', error);
    throw error;
  }
}

/**
 * Clear records via UI interaction (fallback method)
 */
async function clearDatabaseRecordsViaUI(page: Page): Promise<void> {
  // First refresh to ensure we see all current records
  console.log('🔄 Refreshing records...');
  await page.click('button:has-text("Refresh")');
  await page.waitForTimeout(800);

  // Check initial record count
  const initialCount = await page.locator('tbody tr').count();
  console.log(`📊 Found ${initialCount} records to clear via UI`);

  if (initialCount === 0) {
    console.log('✅ No records to clear');
    return;
  }

  // Limit UI deletion to prevent crashes from too many records
  const maxUIDeletes = 50;
  if (initialCount > maxUIDeletes) {
    console.warn(`⚠️ Too many records (${initialCount}) for safe UI deletion. Consider using bulk delete API.`);
    throw new Error(`Cannot safely delete ${initialCount} records via UI. Use bulk delete instead.`);
  }

  // Delete records one by one with better error handling
  let attempts = 0;
  const maxAttempts = Math.min(initialCount + 3, maxUIDeletes);

  while (attempts < maxAttempts) {
    try {
      const deleteButtons = page.locator('tbody tr button[title="Remove record"]');
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
        await page.locator('[data-testid="database-demo-panel"]').waitFor({ 
          state: 'visible', 
          timeout: 2000 
        });
      } catch (pageError) {
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
export async function resetDatabaseForTest(page: Page): Promise<void> {
  console.log('🔄 Resetting database state for test...');

  try {
    // Navigate to database panel
    await showDatabaseDemoPanel(page);
    await waitForDatabaseReady(page);

    // Clear all existing records
    await clearDatabaseRecords(page);

    console.log('✅ Database reset completed');
  } catch (error) {
    console.log('❌ Error during database reset:', error);
    throw error;
  }
}
