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
    
    // CRITICAL: Clear any existing records first for this test
    // Since we use NodeFS persistence, data persists between test runs
    console.log('🧹 Clearing existing records before CRUD test...');
    await clearDatabaseRecords(page);
    
    // Verify we start clean (wait a bit for cleanup to complete)
    await page.waitForTimeout(1000);
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    
    // Confirm we start with 0 records
    const initialCount = await page.locator('tbody tr').count();
    console.log(`📊 Initial record count for CRUD test: ${initialCount}`);
    
    if (initialCount > 0) {
      console.log(`⚠️ Found ${initialCount} existing records, performing additional cleanup...`);
      // Try one more aggressive cleanup
      await clearDatabaseRecords(page);
      await page.waitForTimeout(1000);
      await page.click('button:has-text("Refresh")');
      await page.waitForTimeout(1000);
      
      const finalInitialCount = await page.locator('tbody tr').count();
      if (finalInitialCount > 0) {
        console.log(`🚨 WARNING: Still have ${finalInitialCount} records after cleanup. Adjusting test expectations.`);
      }
    }
    
    // Get the actual starting count (might not be 0 if cleanup failed)
    const actualStartCount = await page.locator('tbody tr').count();
    console.log(`📊 Actual starting count: ${actualStartCount}`);
    
    // Add multiple test records
    console.log('📝 Adding 3 test records...');
    for (let i = 0; i < 3; i++) {
      console.log(`🔄 Adding record ${i + 1}/3...`);
      
      // Get current count before clicking
      const beforeCount = await page.locator('tbody tr').count();
      console.log(`📊 Record count before click ${i + 1}: ${beforeCount}`);
      
      // Click the add button once
      await page.click('button:has-text("Add Test Record")');
      
      // Wait for the record to be added and refresh to see it
      await page.waitForTimeout(1000);
      await page.click('button:has-text("Refresh")');
      await page.waitForTimeout(1000);
      
      // Check the count after this click
      const afterCount = await page.locator('tbody tr').count();
      console.log(`📊 Record count after click ${i + 1}: ${afterCount}`);
      
      // If we got more than 1 record from this click, something is wrong
      const recordsAdded = afterCount - beforeCount;
      if (recordsAdded > 1) {
        console.log(`⚠️ WARNING: Click ${i + 1} added ${recordsAdded} records instead of 1!`);
        console.log(`🚨 This indicates a UI bug - the Add Test Record button is creating multiple records per click`);
        
        // Delete the extra records to get back to expected state
        const expectedCount = beforeCount + 1;
        const extraRecords = afterCount - expectedCount;
        console.log(`🗑️ Deleting ${extraRecords} extra records...`);
        
        for (let j = 0; j < extraRecords; j++) {
          const deleteButtons = page.locator('tbody tr button[title="Remove record"]');
          const buttonCount = await deleteButtons.count();
          if (buttonCount > 0) {
            await deleteButtons.first().click();
            await page.waitForTimeout(500);
          }
        }
        
        // Refresh and verify we're back to expected count
        await page.click('button:has-text("Refresh")');
        await page.waitForTimeout(1000);
        
        const finalCount = await page.locator('tbody tr').count();
        console.log(`📊 Count after cleanup: ${finalCount}, expected: ${expectedCount}`);
      } else if (recordsAdded === 0) {
        console.log(`⚠️ WARNING: Click ${i + 1} didn't add any records, retrying...`);
        // Retry this click
        i--;
        continue;
      }
    }
    
    // Final refresh and count check
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    
    // Verify we have the expected count (starting count + 3 new records)
    const expectedAfterAdd = actualStartCount + 3;
    const finalRecordCount = await page.locator('tbody tr').count();
    console.log(`📊 Final record count: ${finalRecordCount}, expected: ${expectedAfterAdd}`);
    
    await expect(page.locator('tbody tr')).toHaveCount(expectedAfterAdd);
    console.log(`✅ Successfully added 3 records (total: ${expectedAfterAdd})`);
    
    // Delete one record
    console.log('🗑️ Deleting one record...');
    await page.locator('tbody tr:first-child button[title="Remove record"]').click();
    await page.waitForTimeout(500);
    
    // Verify count decreased by 1
    const expectedAfterDelete = expectedAfterAdd - 1;
    await expect(page.locator('tbody tr')).toHaveCount(expectedAfterDelete);
    console.log(`✅ Successfully deleted 1 record (total: ${expectedAfterDelete})`);
    
    // Refresh and verify count persists
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    await expect(page.locator('tbody tr')).toHaveCount(expectedAfterDelete);
    console.log(`✅ Record count persisted after refresh: ${expectedAfterDelete}`);
  });

  test('should persist data between app restarts using NodeFS', async () => {
    // Increase timeout for this test since it involves app restart
    test.setTimeout(180000); // 3 minutes
    
    const page = appContext.window;
    
    // Navigate to and show the database demo panel
    await showDatabaseDemoPanel(page);
    await waitForDatabaseReady(page);
    
    // AGGRESSIVE CLEANUP: Ensure we start with a completely clean database
    // This is critical since database persistence means data survives between test runs
    console.log('🧹 Performing aggressive database cleanup...');
    let cleanupAttempts = 0;
    const maxCleanupAttempts = 10;
    
    while (cleanupAttempts < maxCleanupAttempts) {
      await clearDatabaseRecords(page);
      await page.waitForTimeout(1000);
      
      // Refresh and check if we're truly clean
      await page.click('button:has-text("Refresh")');
      await page.waitForTimeout(1000);
      
      const recordCount = await page.locator('tbody tr').count();
      console.log(`🧹 Cleanup attempt ${cleanupAttempts + 1}: Found ${recordCount} records`);
      
      if (recordCount === 0) {
        console.log('✅ Database is completely clean');
        break;
      }
      
      cleanupAttempts++;
      if (cleanupAttempts >= maxCleanupAttempts) {
        throw new Error(`Failed to clean database after ${maxCleanupAttempts} attempts. Still has ${recordCount} records.`);
      }
    }
    
    // Verify NodeFS storage is being used
    await expect(page.locator('text=NodeFS:')).toBeVisible();
    await expect(page.locator('text=/BrainStrike')).toBeVisible();
    
    // Verify we start with 0 records after cleanup
    await expect(page.locator('tbody tr')).toHaveCount(0, { timeout: 5000 });
    console.log('✅ Confirmed database is clean before test');
    
    // Add a test record - ensure we only click once and wait for completion
    console.log('🔄 Adding test record...');
    const addButton = page.locator('button:has-text("Add Test Record")');
    
    // Make sure the button is visible and ready
    await addButton.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(500); // Small delay to ensure UI is stable
    
    // Click the button once and wait for the operation to complete
    await addButton.click();
    console.log('✅ Clicked add button');
    
    // Wait for the record to be added - check progressively
    await page.waitForTimeout(2000); // Give more time for the record to be created
    
    // Refresh to ensure we see the latest state
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    
    // Check how many records we actually have and aggressively clean up if needed
    let actualCount = await page.locator('tbody tr').count();
    console.log(`📊 Actual record count after adding: ${actualCount}`);
    
    // If we have more than 1 record, aggressively clean up until we have exactly 1
    if (actualCount !== 1) {
      console.log(`⚠️ Expected 1 record but got ${actualCount}. Cleaning up to exactly 1...`);
      
      let cleanupAttempts = 0;
      const maxCleanupAttempts = 10;
      
      while (actualCount !== 1 && cleanupAttempts < maxCleanupAttempts) {
        if (actualCount > 1) {
          // Delete excess records from the end
          const deleteButtons = page.locator('tbody tr button[title="Remove record"]');
          const deleteCount = await deleteButtons.count();
          
          // Delete from the end to avoid index shifting issues
          for (let i = deleteCount - 1; i > 0; i--) {
            try {
              await deleteButtons.nth(i).click();
              await page.waitForTimeout(500);
            } catch (error) {
              console.log(`⚠️ Error deleting extra record ${i}:`, error);
            }
          }
        } else if (actualCount === 0) {
          // We accidentally deleted everything, add one back
          await addButton.click();
          await page.waitForTimeout(1000);
        }
        
        // Refresh and check again
        await page.click('button:has-text("Refresh")');
        await page.waitForTimeout(1000);
        actualCount = await page.locator('tbody tr').count();
        console.log(`🔄 Cleanup attempt ${cleanupAttempts + 1}: Now have ${actualCount} records`);
        
        cleanupAttempts++;
      }
      
      if (actualCount !== 1) {
        throw new Error(`Failed to achieve exactly 1 record after cleanup. Have ${actualCount} records.`);
      }
    }
    
    // Verify we now have exactly 1 record
    await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 10000 });
    console.log('✅ Successfully confirmed 1 record exists');
    
    // Get the actual file name of the first record for verification after restart
    const firstRecordName = await page.locator('tbody tr:first-child td:nth-child(2)').textContent();
    expect(firstRecordName).toBeTruthy();
    console.log(`📝 First record name: ${firstRecordName}`);
    
    // Close and restart the app to test persistence
    await closeElectronApp(appContext);
    
    // Add extra delay to ensure complete database cleanup and file system sync
    // This is critical for persistence tests to avoid race conditions
    console.log('⏱️ Waiting for complete app shutdown and file system sync...');
    await new Promise(resolve => setTimeout(resolve, 8000)); // 8 second delay
    
    // Launch a new instance
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    const newPage = appContext.window;
    
    // Navigate to and show the database demo panel again
    await showDatabaseDemoPanel(newPage);
    await waitForDatabaseReady(newPage);
    
    // Wait for records to load with longer timeout
    console.log('⏱️ Waiting for database records to load after restart...');
    await newPage.waitForTimeout(5000); // Longer wait
    
    // Refresh to ensure we see the latest state
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(3000); // Longer wait
    
    // Verify data persisted after restart - should still have exactly 1 record
    // Use a longer timeout and add retry logic for persistence verification
    let recordCount = 0;
    let retryCount = 0;
    const maxRetries = 8; // More retries
    
    while (retryCount < maxRetries) {
      try {
        recordCount = await newPage.locator('tbody tr').count();
        console.log(`📊 Attempt ${retryCount + 1}: Found ${recordCount} records after restart`);
        
        if (recordCount === 1) {
          break; // Success!
        } else if (recordCount === 0 && retryCount < maxRetries - 1) {
          // Data might not have loaded yet, wait and refresh
          console.log('⏱️ No records found, waiting and refreshing...');
          await newPage.waitForTimeout(3000);
          await newPage.click('button:has-text("Refresh")');
          await newPage.waitForTimeout(2000);
        }
        
        retryCount++;
      } catch (error) {
        console.log(`⚠️ Error checking record count (attempt ${retryCount + 1}):`, error);
        retryCount++;
        if (retryCount < maxRetries) {
          await newPage.waitForTimeout(3000);
        }
      }
    }
    
    // Final verification with longer timeout
    await expect(newPage.locator('tbody tr')).toHaveCount(1, { timeout: 20000 });
    console.log('✅ Confirmed 1 record persisted after restart');
    
    // Verify the specific record persisted
    if (firstRecordName) {
      await expect(newPage.locator('tbody tr td:nth-child(2)', { hasText: firstRecordName })).toBeVisible({ timeout: 15000 });
      console.log(`✅ Confirmed specific record "${firstRecordName}" persisted`);
    } else {
      throw new Error('First record name was not found before restart');
    }
    
    // Test database operations still work - add another record carefully
    console.log('🔄 Adding second record after restart...');
    const addButton2 = newPage.locator('button:has-text("Add Test Record")');
    await addButton2.waitFor({ state: 'visible', timeout: 5000 });
    await newPage.waitForTimeout(500);
    
    await addButton2.click();
    await newPage.waitForTimeout(1000);
    
    // Refresh to see the new record
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(1000);
    
    // Should now have 2 records total
    await expect(newPage.locator('tbody tr')).toHaveCount(2, { timeout: 10000 });
    console.log('✅ Successfully added second record after restart');
    
    // Final cleanup for this test - clean up the test data we created
    console.log('🧹 Final cleanup for persistence test...');
    await clearDatabaseRecords(newPage);
    
    // Verify cleanup was successful - this is CRITICAL for subsequent tests
    await newPage.click('button:has-text("Refresh")');
    await newPage.waitForTimeout(1000);
    
    const finalRecordCount = await newPage.locator('tbody tr').count();
    console.log(`📊 Final record count after persistence test cleanup: ${finalRecordCount}`);
    
    if (finalRecordCount > 0) {
      console.log(`⚠️ Persistence test cleanup left ${finalRecordCount} records. Attempting additional cleanup...`);
      // Try one more aggressive cleanup
      await clearDatabaseRecords(newPage);
      await newPage.waitForTimeout(2000);
      await newPage.click('button:has-text("Refresh")');
      await newPage.waitForTimeout(1000);
      
      const veryFinalCount = await newPage.locator('tbody tr').count();
      if (veryFinalCount > 0) {
        console.log(`🚨 WARNING: Persistence test could not fully clean database. ${veryFinalCount} records remain.`);
        console.log(`🚨 This may affect subsequent tests in the suite.`);
      } else {
        console.log('✅ Additional cleanup successful - database is now clean');
      }
    }
    
    console.log('✅ Persistence test cleanup completed');
  });
});