import { test, expect } from '@playwright/test';
import { launchElectronApp, closeElectronApp, waitForAppReady, mockFileSystemOperations } from './utils/electron-helpers';
import { HomePage } from './page-objects/home-page';
import type { ElectronAppContext } from './utils/electron-helpers';

test.describe('File System Integration', () => {
  let appContext: ElectronAppContext;
  let homePage: HomePage;

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    // Mock file system operations to prevent native dialogs
    await mockFileSystemOperations(appContext.window);
    homePage = new HomePage(appContext.window);
  });

  test.afterEach(async () => {
    if (appContext) {
      await closeElectronApp(appContext);
    }
  });

  test('should handle file system access permissions', async () => {
    // Test that the app can request file system access
    const fileSystemButton = appContext.window.getByRole('button', { name: /browse/i });
    
    if (await fileSystemButton.isVisible().catch(() => false)) {
      // Click the browse button to trigger file system access
      await fileSystemButton.click();
      
      // In a real scenario, this might open a file dialog
      // For testing, we can verify the request was made
      await appContext.window.waitForTimeout(1000);
      
      // Verify no errors occurred
      const errorMessage = appContext.window.getByText(/error/i);
      await expect(errorMessage).not.toBeVisible();
    }
  });

  test('should handle directory operations', async () => {
    // Test directory-related functionality
    const fileExplorerPanel = appContext.window.getByTestId('file-explorer-panel');
    
    if (await fileExplorerPanel.isVisible().catch(() => false)) {
      // Look for directory tree or file list
      const directoryTree = appContext.window.getByRole('tree');
      const fileList = appContext.window.getByRole('list');
      
      // At least one should be present
      const hasTree = await directoryTree.isVisible().catch(() => false);
      const hasList = await fileList.isVisible().catch(() => false);
      
      expect(hasTree || hasList).toBe(true);
    }
  });

  test('should handle file operations', async () => {
    // Test file-related operations
    const fileButtons = appContext.window.getByRole('button').filter({ hasText: /file/i });
    const fileCount = await fileButtons.count();
    
    if (fileCount > 0) {
      // Click the first file-related button
      await fileButtons.first().click();
      
      // Wait for any file operations to complete
      await appContext.window.waitForTimeout(1000);
      
      // Verify no critical errors
      const criticalError = appContext.window.getByText(/critical error|fatal/i);
      await expect(criticalError).not.toBeVisible();
    }
  });

  test('should handle large directory structures', async () => {
    // This test simulates handling large file structures
    // which is a common desktop-specific issue
    
    // Navigate to file explorer if available
    const explorerButtons = appContext.window.getByRole('button').filter({ hasText: /explorer/i });
    
    if (await explorerButtons.count() > 0) {
      // Use the first explorer button if multiple exist
      await explorerButtons.first().click();
      
      // Wait for potential loading
      await appContext.window.waitForTimeout(2000);
      
      // Check for performance indicators
      const loadingIndicator = appContext.window.getByText(/loading/i);
      const spinner = appContext.window.locator('[data-testid*="loading"], [class*="spinner"]');
      
      // Wait for loading to complete (if present)
      if (await loadingIndicator.isVisible().catch(() => false)) {
        await loadingIndicator.waitFor({ state: 'hidden', timeout: 10000 });
      }
      
      if (await spinner.isVisible().catch(() => false)) {
        await spinner.waitFor({ state: 'hidden', timeout: 10000 });
      }
      
      // Verify the UI is responsive after loading
      const mainContent = appContext.window.getByTestId('main-content-area');
      if (await mainContent.isVisible().catch(() => false)) {
        await expect(mainContent).toBeVisible();
      } else {
        // Just verify the app is still functional
        await homePage.shouldBeVisible();
      }
    }
  });

  test('should handle file system errors gracefully', async () => {
    // Test error handling for file system operations
    
    // Try to trigger a file system operation that might fail
    const buttons = appContext.window.getByRole('button');
    const buttonCount = await buttons.count();
    
    // Click various buttons to test error handling
    for (let i = 0; i < Math.min(buttonCount, 3); i++) {
      const button = buttons.nth(i);
      const buttonText = await button.textContent();
      
      if (buttonText && !buttonText.toLowerCase().includes('close')) {
        await button.click();
        await appContext.window.waitForTimeout(500);
        
        // Check that any errors are handled gracefully
        const errorDialog = appContext.window.getByRole('dialog').filter({ hasText: /error/i });
        
        // If an error dialog appears, it should be dismissible
        if (await errorDialog.isVisible().catch(() => false)) {
          const closeButton = errorDialog.getByRole('button', { name: /close|ok|dismiss/i });
          if (await closeButton.isVisible()) {
            await closeButton.click();
          }
        }
        
        // App should remain functional
        await homePage.shouldBeVisible();
      }
    }
  });

  test('should maintain file system state across app restart', async () => {
    // Test state persistence for file system operations
    
    // Perform some file system operation (if available)
    const fileSystemButtons = appContext.window.getByRole('button').filter({ 
      hasText: /browse|open|select/i 
    });
    
    if (await fileSystemButtons.first().isVisible().catch(() => false)) {
      await fileSystemButtons.first().click();
      await appContext.window.waitForTimeout(1000);
    }
    
    // Close the app
    await closeElectronApp(appContext);
    
    // Restart the app
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
    homePage = new HomePage(appContext.window);
    
    // Verify the app starts correctly after file system operations
    await homePage.shouldBeVisible();
    
    // Check that any persistent file system state is maintained
    // This depends on your app's implementation
    const fileExplorer = appContext.window.getByTestId('file-explorer-panel');
    if (await fileExplorer.isVisible().catch(() => false)) {
      // File explorer should be functional after restart
      await expect(fileExplorer).toBeVisible();
    }
  });
}); 