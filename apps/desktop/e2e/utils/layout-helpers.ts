import { type Page } from '@playwright/test';

/**
 * Layout test utilities for Desktop E2E panel testing
 * Adapted from web E2E helpers for Electron-specific needs
 */

/**
 * Navigate to and show the database demo panel in the right panel
 */
export async function showDatabaseDemoPanel(page: Page): Promise<void> {
  // First, check if the right panel is already visible
  const rightPanel = page.locator('[data-panel-id="right-panel"]');
  const rightPanelVisible = await rightPanel.isVisible();
  
  if (!rightPanelVisible) {
    // Show the right panel by clicking the show button
    const showRightPanelButton = page.locator('button[aria-label="Show right panel"]');
    await showRightPanelButton.click();
    
    // Wait for the right panel to be visible
    await rightPanel.waitFor({ state: 'visible', timeout: 5000 });
  }
  
  // Now navigate to the database tab within the right panel
  // Try multiple selectors for the database tab
  const databaseTab = page.locator('button[value="database"]')
    .or(page.locator('[value="database"]'))
    .or(page.locator('text=DB'))
    .or(page.locator('[role="tab"]:has-text("DB")'));
  
  await databaseTab.first().click();
  
  // Wait for the database demo panel to be visible with its testid
  await page.locator('[data-testid="database-demo-panel"]').waitFor({ 
    state: 'visible', 
    timeout: 10000 
  });
}

/**
 * Wait for the database demo panel to be fully initialized and ready
 */
export async function waitForDatabaseReady(page: Page): Promise<void> {
  // Wait for the database demo panel to be visible
  await page.locator('[data-testid="database-demo-panel"]').waitFor({ 
    state: 'visible', 
    timeout: 10000 
  });
  
  // Wait for connection status to be ready (either success or failure indicator)
  await page.locator('text=✓').or(page.locator('text=✗')).first().waitFor({ 
    state: 'visible', 
    timeout: 15000 
  });
  
  // Additional wait to ensure database operations are ready
  await page.waitForTimeout(1000);
}

/**
 * Clear all records from the database for testing
 */
export async function clearDatabaseRecords(page: Page): Promise<void> {
  // First refresh to ensure we see all current records
  await page.click('button:has-text("Refresh")');
  await page.waitForTimeout(500);
  
  // Check initial record count
  const initialCount = await page.locator('tbody tr').count();
  
  if (initialCount === 0) {
    return;
  }
  
  // Delete records one by one
  let attempts = 0;
  const maxAttempts = initialCount + 2; // Small safety buffer
  
  while (attempts < maxAttempts) {
    const deleteButtons = page.locator('tbody tr button[title="Remove record"]');
    const count = await deleteButtons.count();
    
    if (count === 0) {
      break;
    }
    
    // Click the first delete button
    await deleteButtons.first().click();
    await page.waitForTimeout(300);
    
    attempts++;
  }
}

/**
 * Get database panel elements for testing
 */
export function getDatabasePanelElements(page: Page) {
  return {
    panel: page.locator('[data-testid="database-demo-panel"]'),
    addButton: page.locator('button:has-text("Add Test Record")'),
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