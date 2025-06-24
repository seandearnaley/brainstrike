import { type Page, expect } from '@playwright/test';

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
  console.log('🧹 Starting database cleanup...');
  
  // First refresh to ensure we see all current records
  await page.click('button:has-text("Refresh")');
  await page.waitForTimeout(1000);
  
  // Check initial record count
  const initialCount = await page.locator('tbody tr').count();
  console.log(`📊 Initial record count: ${initialCount}`);
  
  if (initialCount === 0) {
    console.log('✅ Database already clean');
    return;
  }
  
  // Strategy 1: Try to delete records one by one
  let attempts = 0;
  const maxAttempts = Math.max(initialCount * 2, 10); // Scale with number of records
  
  while (attempts < maxAttempts) {
    // Wait for any pending UI updates
    await page.waitForTimeout(200);
    
    const deleteButtons = page.locator('tbody tr button[title="Remove record"]');
    const count = await deleteButtons.count();
    
    console.log(`🗑️ Attempt ${attempts + 1}: Found ${count} records to delete`);
    
    if (count === 0) {
      console.log('✅ No more records to delete');
      break; // No more records to delete
    }
    
    // Click the first delete button and wait for the action to complete
    try {
      await deleteButtons.first().click();
      await page.waitForTimeout(800); // Wait for deletion
      
      // Verify deletion actually happened by checking if count decreased
      const newCount = await page.locator('tbody tr').count();
      if (newCount >= count) {
        console.log(`⚠️ Record count didn't decrease (was ${count}, now ${newCount}), refreshing...`);
        await page.click('button:has-text("Refresh")');
        await page.waitForTimeout(1000);
      }
    } catch (error) {
      console.log(`⚠️ Error during deletion attempt ${attempts + 1}:`, error);
      // Try refreshing the page state
      await page.click('button:has-text("Refresh")');
      await page.waitForTimeout(1000);
    }
    
    attempts++;
  }
  
  // Strategy 2: If we still have records, try bulk deletion
  let currentCount = await page.locator('tbody tr').count();
  if (currentCount > 0) {
    console.log(`🚨 ${currentCount} records still remain, attempting bulk deletion...`);
    
    // Refresh first to ensure we see all records
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    
    // Try clicking all delete buttons rapidly
    const allButtons = page.locator('tbody tr button[title="Remove record"]');
    const buttonCount = await allButtons.count();
    
    for (let i = 0; i < buttonCount; i++) {
      try {
        const button = allButtons.nth(i);
        if (await button.isVisible()) {
          await button.click();
          await page.waitForTimeout(200); // Shorter wait for bulk operations
        }
      } catch (error) {
        console.log(`⚠️ Error clicking button ${i}:`, error);
      }
    }
    
    // Wait longer for bulk deletions to process
    await page.waitForTimeout(2000);
    
    // Refresh to see results
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1500);
    
    currentCount = await page.locator('tbody tr').count();
    console.log(`📊 After bulk deletion: ${currentCount} records remain`);
  }
  
  // Strategy 3: If records still remain, try one final aggressive approach
  if (currentCount > 0) {
    console.log(`🚨 ${currentCount} records STILL remain, final aggressive cleanup...`);
    
    // Try multiple refresh cycles with deletions
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.click('button:has-text("Refresh")');
      await page.waitForTimeout(1000);
      
      const buttons = page.locator('tbody tr button[title="Remove record"]');
      const count = await buttons.count();
      
      if (count === 0) break;
      
      console.log(`🔄 Cleanup cycle ${cycle + 1}: ${count} records to delete`);
      
      // Click all visible delete buttons
      for (let i = 0; i < count; i++) {
        try {
          const button = buttons.nth(i);
          if (await button.isVisible({ timeout: 1000 })) {
            await button.click();
            await page.waitForTimeout(300);
          }
        } catch (error) {
          // Ignore individual button errors in aggressive mode
        }
      }
      
      await page.waitForTimeout(1000);
    }
    
    // Final refresh
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1500);
    
    currentCount = await page.locator('tbody tr').count();
    console.log(`📊 Final aggressive cleanup result: ${currentCount} records remain`);
  }
  
  // Check final count and log result
  const finalCount = await page.locator('tbody tr').count();
  console.log(`📊 Final record count: ${finalCount}`);
  
  if (finalCount === 0) {
    console.log('✅ Database cleanup completed successfully');
  } else {
    console.log(`🚨 WARNING: Could not clear all records (${finalCount} remain). Tests may be affected.`);
    // For now, don't fail the cleanup - let the test handle the assertion
    // This prevents cleanup failures from blocking all tests
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