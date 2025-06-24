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
    console.log('🧹 Setting up clean database state for entire test suite...');
    
    const setupApp = await launchElectronApp();
    try {
      await waitForAppReady(setupApp.window);
      await showDatabaseDemoPanel(setupApp.window);
      await waitForDatabaseReady(setupApp.window);
      
      // Aggressive cleanup before any tests run
      console.log('🧹 Performing initial suite cleanup...');
      await clearDatabaseRecords(setupApp.window);
      
      // Verify we're starting clean
      await setupApp.window.click('button:has-text("Refresh")');
      await setupApp.window.waitForTimeout(1000);
      
      const initialCount = await setupApp.window.locator('tbody tr').count();
      console.log(`📊 Initial database state for test suite: ${initialCount} records`);
      
      if (initialCount > 0) {
        console.log(`⚠️ Found ${initialCount} existing records. Performing additional cleanup...`);
        await clearDatabaseRecords(setupApp.window);
        await setupApp.window.waitForTimeout(1000);
        
        const finalCount = await setupApp.window.locator('tbody tr').count();
        if (finalCount > 0) {
          console.log(`🚨 WARNING: Could not achieve clean start. ${finalCount} records remain.`);
        } else {
          console.log('✅ Successfully achieved clean database start');
        }
      }
      
    } finally {
      await closeElectronApp(setupApp);
    }
    
    console.log('✅ Database setup completed for test suite');
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
        console.log(`🧹 Cleaning up database after test: ${testInfo.title}`);
        try {
          await showDatabaseDemoPanel(appContext.window);
          await waitForDatabaseReady(appContext.window);
          
          // Perform aggressive cleanup for non-persistence tests
          await clearDatabaseRecords(appContext.window);
          
          // Verify cleanup was successful
          await appContext.window.click('button:has-text("Refresh")');
          await appContext.window.waitForTimeout(1000);
          
          const remainingRecords = await appContext.window.locator('tbody tr').count();
          if (remainingRecords > 0) {
            console.log(`⚠️ AfterEach cleanup left ${remainingRecords} records. Attempting additional cleanup...`);
            await clearDatabaseRecords(appContext.window);
            await appContext.window.waitForTimeout(1000);
            
            const finalCount = await appContext.window.locator('tbody tr').count();
            if (finalCount > 0) {
              console.log(`🚨 WARNING: AfterEach could not fully clean database. ${finalCount} records remain.`);
            } else {
              console.log('✅ Additional afterEach cleanup successful');
            }
          } else {
            console.log('✅ AfterEach cleanup successful - database is clean');
          }
          
        } catch (error) {
          console.log('⚠️ Warning: Could not clear database in afterEach:', error);
        }
      } else {
        console.log('ℹ️ Skipping database cleanup for persistence test');
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
    // Since we use NodeFS persistence, data persists between test runs
    console.log('🧹 Clearing existing records before CRUD test...');
    await clearDatabaseRecords(page);
    
    // Verify we start clean
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    
    // Confirm we start with 0 records
    const initialCount = await page.locator('tbody tr').count();
    console.log(`📊 Initial record count for CRUD test: ${initialCount}`);
    expect(initialCount).toBe(0);
    
    // Add 3 test records
    console.log('📝 Adding 3 test records...');
    for (let i = 0; i < 3; i++) {
      console.log(`🔄 Adding record ${i + 1}/3...`);
      
      // Click the add button
      await page.click('button:has-text("Add Test Record")');
      
      // Wait for the record to be added
      await page.waitForTimeout(1000);
      await page.click('button:has-text("Refresh")');
      await page.waitForTimeout(500);
      
      // Verify the record was added
      const currentCount = await page.locator('tbody tr').count();
      expect(currentCount).toBe(i + 1);
      console.log(`📊 Record count after adding record ${i + 1}: ${currentCount}`);
    }
    
    console.log('✅ Successfully added 3 records');
    
    // Delete one record
    console.log('🗑️ Deleting one record...');
    await page.locator('tbody tr:first-child button[title="Remove record"]').click();
    await page.waitForTimeout(500);
    
    // Verify count decreased by 1
    await expect(page.locator('tbody tr')).toHaveCount(2);
    console.log('✅ Successfully deleted 1 record (total: 2)');
    
    // Refresh and verify count persists
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(500);
    await expect(page.locator('tbody tr')).toHaveCount(2);
    console.log('✅ Record count persisted after refresh: 2');
  });

  test('should persist data between app restarts using NodeFS', async () => {
    // Increase timeout for this test since it involves app restart
    test.setTimeout(180000); // 3 minutes
    
    const page = appContext.window;
    
    // Navigate to and show the database demo panel
    await showDatabaseDemoPanel(page);
    await waitForDatabaseReady(page);
    
    // Ensure we start with a completely clean database
    console.log('🧹 Cleaning database before persistence test...');
    await clearDatabaseRecords(page);
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    
    // Verify NodeFS storage is being used
    await expect(page.locator('text=NodeFS:')).toBeVisible();
    await expect(page.locator('text=/BrainStrike')).toBeVisible();
    
    // Verify we start with 0 records after cleanup
    await expect(page.locator('tbody tr')).toHaveCount(0, { timeout: 5000 });
    console.log('✅ Confirmed database is clean before test');
    
    // Add a test record
    console.log('🔄 Adding test record...');
    await page.click('button:has-text("Add Test Record")');
    
    // Wait for the record to be added
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    
    // Verify exactly 1 record was created
    await expect(page.locator('tbody tr')).toHaveCount(1);
    console.log('✅ Successfully confirmed 1 record exists');
    
    // Get the record name for verification after restart
    const firstRecordName = await page.locator('tbody tr:first-child td:nth-child(2)').textContent();
    expect(firstRecordName).toBeTruthy();
    console.log(`📝 First record name: ${firstRecordName}`);
    
    // Close and restart the app to test persistence
    await closeElectronApp(appContext);
    
    // Wait for complete app shutdown and file system sync
    console.log('⏱️ Waiting for complete app shutdown and file system sync...');
    await new Promise(resolve => setTimeout(resolve, 8000)); // 8 second delay
    
    // Launch a new instance
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    const newPage = appContext.window;
    
    // Navigate to and show the database demo panel again
    await showDatabaseDemoPanel(newPage);
    await waitForDatabaseReady(newPage);
    
    // Wait for records to load
    console.log('⏱️ Waiting for database records to load after restart...');
    await newPage.waitForTimeout(3000);
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(2000);
    
    // Verify data persisted after restart - should still have exactly 1 record
    await expect(newPage.locator('tbody tr')).toHaveCount(1, { timeout: 15000 });
    console.log('✅ Confirmed 1 record persisted after restart');
    
    // Verify the specific record persisted
    if (firstRecordName) {
      await expect(newPage.locator('tbody tr td:nth-child(2)', { hasText: firstRecordName })).toBeVisible({ timeout: 10000 });
      console.log(`✅ Confirmed specific record "${firstRecordName}" persisted`);
    }
    
    // Test database operations still work - add another record
    console.log('🔄 Adding second record after restart...');
    await newPage.click('button:has-text("Add Test Record")');
    await newPage.waitForTimeout(1000);
    
    // Refresh to see the new record
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(1000);
    
    // Should now have 2 records total
    await expect(newPage.locator('tbody tr')).toHaveCount(2, { timeout: 10000 });
    console.log('✅ Successfully added second record after restart');
    
    // Final cleanup for this test
    console.log('🧹 Final cleanup for persistence test...');
    await clearDatabaseRecords(newPage);
    await newPage.waitForTimeout(1000);
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(1000);
    
    const finalRecordCount = await newPage.locator('tbody tr').count();
    console.log(`📊 Final record count after persistence test cleanup: ${finalRecordCount}`);
    expect(finalRecordCount).toBe(0);
    console.log('✅ Persistence test cleanup completed');
  });
});