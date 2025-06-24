import { test, expect } from '@playwright/test';
import { launchElectronApp, closeElectronApp, waitForAppReady } from './utils/electron-helpers';
import { showDatabaseDemoPanel, waitForDatabaseReady, clearDatabaseRecords } from './utils/layout-helpers';
import type { ElectronAppContext } from './utils/electron-helpers';

// Configure this test suite to run in serial mode to avoid database interference
test.describe.configure({ mode: 'serial' });

test.describe('Database Persistence with NodeFS', () => {
  let appContext: ElectronAppContext;

  test.beforeAll(async () => {
    // Clean the database before running any tests in this suite
    // This is critical because NodeFS persistence means data survives between test runs
    const setupApp = await launchElectronApp();
    try {
      await waitForAppReady(setupApp.window);
      await showDatabaseDemoPanel(setupApp.window);
      await waitForDatabaseReady(setupApp.window);
      
      // Initial cleanup before any tests run
      await clearDatabaseRecords(setupApp.window);
      
      // Verify we're starting clean
      await setupApp.window.click('button:has-text("Refresh")');
      await setupApp.window.waitForTimeout(500);
      
      const initialCount = await setupApp.window.locator('tbody tr').count();
      
      if (initialCount > 0) {
        // One more cleanup attempt if records remain
        await clearDatabaseRecords(setupApp.window);
      }
      
    } finally {
      await closeElectronApp(setupApp);
    }
  });

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
  });

  test.afterEach(async ({ }, testInfo) => {
    if (appContext) {
      // Skip database cleanup for the persistence test since it needs to test data across restarts
      const isPersistenceTest = testInfo.title.includes('should persist data between app restarts');
      
      if (!isPersistenceTest) {
        // Clean up database after test for non-persistence tests
        try {
          await showDatabaseDemoPanel(appContext.window);
          await waitForDatabaseReady(appContext.window);
          await clearDatabaseRecords(appContext.window);
        } catch (error) {
          // Ignore cleanup errors - they don't affect test validity
        }
      }
      
      await closeElectronApp(appContext);
    }
  });

  // NOTE: The main persistence test has been moved to database-persistence-isolated.spec.ts
  // to avoid interference from parallel test execution

  test('should handle database errors gracefully', async () => {
    const page = appContext.window;
    
    // Navigate to and show the database demo panel
    await showDatabaseDemoPanel(page);
    await waitForDatabaseReady(page);
    
    // Verify connection status is shown
    await expect(page.locator('text=✓')).toBeVisible(); // Success indicator
    
    // Test that operations work
    await page.click('button:has-text("Refresh")');
    
    // Should not show error messages
    await expect(page.locator('text=Failed to')).not.toBeVisible();
  });

  test('should show correct database location info', async () => {
    const page = appContext.window;
    
    // Navigate to and show the database demo panel
    await showDatabaseDemoPanel(page);
    await waitForDatabaseReady(page);
    
    // Check for NodeFS indicator in desktop app
    await expect(page.locator('text=NodeFS:')).toBeVisible();
    await expect(page.locator('text=/BrainStrike')).toBeVisible();
    
    // Verify connection success
    await expect(page.locator('text=✓')).toBeVisible();
    await expect(page.locator('text=Database connected successfully')).toBeVisible();
  });

  test('should perform CRUD operations through UI', async () => {
    const page = appContext.window;
    
    // Navigate to and show the database demo panel
    await showDatabaseDemoPanel(page);
    await waitForDatabaseReady(page);
    
    // Clear any existing records first for this test
    await clearDatabaseRecords(page);
    
    // Verify we start clean
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(500);
    
    // Confirm we start with 0 records
    const initialCount = await page.locator('tbody tr').count();
    expect(initialCount).toBe(0);
    
    // Add 3 test records
    for (let i = 0; i < 3; i++) {
      await page.click('button:has-text("Add Test Record")');
      await page.waitForTimeout(500);
      await page.click('button:has-text("Refresh")');
      await page.waitForTimeout(300);
      
      // Verify the record was added
      const currentCount = await page.locator('tbody tr').count();
      expect(currentCount).toBe(i + 1);
    }
    
    // Delete one record
    await page.locator('tbody tr:first-child button[title="Remove record"]').click();
    await page.waitForTimeout(300);
    
    // Verify count decreased by 1
    await expect(page.locator('tbody tr')).toHaveCount(2);
    
    // Refresh and verify count persists
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(300);
    await expect(page.locator('tbody tr')).toHaveCount(2);
  });

  test('should persist data between app restarts using NodeFS', async () => {
    // Increase timeout for this test since it involves app restart
    test.setTimeout(120000); // 2 minutes instead of 3
    
    const page = appContext.window;
    
    // Navigate to and show the database demo panel
    await showDatabaseDemoPanel(page);
    await waitForDatabaseReady(page);
    
    // Ensure we start with a completely clean database
    await clearDatabaseRecords(page);
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(500);
    
    // Verify NodeFS storage is being used
    await expect(page.locator('text=NodeFS:')).toBeVisible();
    await expect(page.locator('text=/BrainStrike')).toBeVisible();
    
    // Verify we start with 0 records after cleanup
    await expect(page.locator('tbody tr')).toHaveCount(0, { timeout: 5000 });
    
    // Add a test record
    await page.click('button:has-text("Add Test Record")');
    
    // Wait for the record to be added
    await page.waitForTimeout(500);
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(500);
    
    // Verify exactly 1 record was created
    await expect(page.locator('tbody tr')).toHaveCount(1);
    
    // Get the record name for verification after restart
    const firstRecordName = await page.locator('tbody tr:first-child td:nth-child(2)').textContent();
    expect(firstRecordName).toBeTruthy();
    
    // Close and restart the app to test persistence
    await closeElectronApp(appContext);
    
    // Wait for complete app shutdown and file system sync
    await new Promise(resolve => setTimeout(resolve, 8000)); // Increased back to 8 seconds for proper sync
    
    // Launch a new instance
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    const newPage = appContext.window;
    
    // Navigate to and show the database demo panel again
    await showDatabaseDemoPanel(newPage);
    await waitForDatabaseReady(newPage);
    
    // Wait for records to load and force a refresh
    await newPage.waitForTimeout(3000); // Increased wait time
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(2000); // Increased wait time
    
    // Verify data persisted after restart - should still have exactly 1 record
    await expect(newPage.locator('tbody tr')).toHaveCount(1, { timeout: 15000 }); // Increased timeout
    
    // Verify the specific record persisted
    if (firstRecordName) {
      await expect(newPage.locator('tbody tr td:nth-child(2)', { hasText: firstRecordName })).toBeVisible({ timeout: 5000 });
    }
    
    // Test database operations still work - add another record
    await newPage.click('button:has-text("Add Test Record")');
    await newPage.waitForTimeout(500);
    
    // Refresh to see the new record
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(500);
    
    // Should now have 2 records total
    await expect(newPage.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });
    
    // Final cleanup for this test
    await clearDatabaseRecords(newPage);
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(500);
    
    const finalRecordCount = await newPage.locator('tbody tr').count();
    expect(finalRecordCount).toBe(0);
  });
});