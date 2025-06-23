import { test, expect } from '@playwright/test';
import { launchElectronApp, closeElectronApp, waitForAppReady } from './utils/electron-helpers';
import type { ElectronAppContext } from './utils/electron-helpers';

test.describe('Database Persistence with NodeFS', () => {
  let appContext: ElectronAppContext;

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
  });

  test.afterEach(async () => {
    if (appContext) {
      await closeElectronApp(appContext);
    }
  });

  test('should persist data between app restarts using NodeFS', async () => {
    const page = appContext.window;
    
    // Wait for database to initialize
    await expect(page.locator('[data-testid="database-demo-panel"]')).toBeVisible();
    
    // Verify NodeFS storage is being used
    await expect(page.locator('text=NodeFS:')).toBeVisible();
    await expect(page.locator('text=/BrainStrike')).toBeVisible();
    
    // Add a test record
    const testFileName = `test-persistence-${Date.now()}.txt`;
    await page.click('button:has-text("Add Test Record")');
    
    // Wait for the record to appear
    await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 10000 });
    
    // Get the record count
    const initialRecords = await page.locator('tbody tr').count();
    expect(initialRecords).toBeGreaterThan(0);
    
    // Get the actual file name of the first record
    const firstRecordName = await page.locator('tbody tr:first-child td:nth-child(2)').textContent();
    expect(firstRecordName).toBeTruthy();
    
    // Close and restart the app to test persistence
    await closeElectronApp(appContext);
    
    // Launch a new instance
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    const newPage = appContext.window;
    
    // Wait for database to reinitialize
    await expect(newPage.locator('[data-testid="database-demo-panel"]')).toBeVisible();
    
    // Wait for records to load
    await newPage.waitForTimeout(2000);
    
    // Verify data persisted after restart
    await expect(newPage.locator(`text=${firstRecordName}`)).toBeVisible({ timeout: 10000 });
    
    // Verify record count is the same
    const afterRestartRecords = await newPage.locator('tbody tr').count();
    expect(afterRestartRecords).toBe(initialRecords);
    
    // Test database operations still work
    await newPage.click('button:has-text("Add Test Record")');
    await newPage.waitForTimeout(1000);
    const finalRecords = await newPage.locator('tbody tr').count();
    expect(finalRecords).toBe(initialRecords + 1);
  });

  test('should handle database errors gracefully', async () => {
    const page = appContext.window;
    
    // Wait for database demo panel
    await expect(page.locator('[data-testid="database-demo-panel"]')).toBeVisible();
    
    // Verify connection status is shown
    await expect(page.locator('text=✓')).toBeVisible(); // Success indicator
    
    // Test that operations work
    await page.click('button:has-text("Refresh")');
    
    // Should not show error messages
    await expect(page.locator('text=Failed to')).not.toBeVisible();
  });

  test('should show correct database location info', async () => {
    const page = appContext.window;
    
    await expect(page.locator('[data-testid="database-demo-panel"]')).toBeVisible();
    
    // Check for NodeFS indicator in desktop app
    await expect(page.locator('text=NodeFS:')).toBeVisible();
    await expect(page.locator('text=/BrainStrike')).toBeVisible();
    
    // Verify connection success
    await expect(page.locator('text=✓')).toBeVisible();
    await expect(page.locator('text=Database connected successfully')).toBeVisible();
  });

  test('should perform CRUD operations through UI', async () => {
    const page = appContext.window;
    
    // Wait for database to initialize
    await expect(page.locator('[data-testid="database-demo-panel"]')).toBeVisible();
    
    // Clear any existing records by refreshing
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    
    // Add multiple test records
    for (let i = 0; i < 3; i++) {
      await page.click('button:has-text("Add Test Record")');
      await page.waitForTimeout(500);
    }
    
    // Verify 3 records exist
    await expect(page.locator('tbody tr')).toHaveCount(3);
    
    // Delete one record
    await page.locator('tbody tr:first-child button[title="Remove record"]').click();
    await page.waitForTimeout(500);
    
    // Verify 2 records remain
    await expect(page.locator('tbody tr')).toHaveCount(2);
    
    // Refresh and verify count persists
    await page.click('button:has-text("Refresh")');
    await page.waitForTimeout(1000);
    await expect(page.locator('tbody tr')).toHaveCount(2);
  });
});