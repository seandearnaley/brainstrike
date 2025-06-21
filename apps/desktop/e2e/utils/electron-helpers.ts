import { _electron as electron } from 'playwright';
import type { ElectronApplication, Page } from 'playwright';
import path from 'path';

export interface ElectronAppContext {
  app: ElectronApplication;
  window: Page;
}

/**
 * Launch the Electron app for testing
 */
export async function launchElectronApp(): Promise<ElectronAppContext> {
  const electronPath = require('electron');
  const mainPath = path.join(process.cwd(), 'dist', 'main.js');
  
  console.log('🚀 Launching Electron app...');
  console.log('Electron path:', electronPath);
  console.log('Main path:', mainPath);
  
  const launchOptions: Parameters<typeof electron.launch>[0] = {
    args: [mainPath, '--no-sandbox', '--disable-web-security', '--test-mode', '--disable-dialogs'],
    executablePath: electronPath,
    // Set timeout for app launch
    timeout: 30000,
    // Additional options to prevent dialogs and windows
    env: {
      ...process.env,
      ELECTRON_IS_E2E_TEST: 'true',
      DISABLE_NATIVE_DIALOGS: 'true'
    }
  };
  
  // Only record video when not in CI to prevent window popups
  if (!process.env['CI']) {
    launchOptions.recordVideo = {
      dir: 'test-results/videos',
      size: { width: 1280, height: 720 }
    };
  }
  
  const app = await electron.launch(launchOptions);
  
  // Wait for the first window to be created
  const window = await app.firstWindow();
  
  // Wait for the app to be ready
  await window.waitForLoadState('domcontentloaded');
  
  // Set up dialog mocking to prevent native dialogs from blocking tests
  await setupDialogMocking(app);
  
  console.log('✅ Electron app launched successfully');
  
  return { app, window };
}

/**
 * Close the Electron app
 */
export async function closeElectronApp(appContext: ElectronAppContext): Promise<void> {
  console.log('🔒 Closing Electron app...');
  await appContext.app.close();
  console.log('✅ Electron app closed');
}

/**
 * Wait for the app to be fully loaded and ready
 */
export async function waitForAppReady(window: Page): Promise<void> {
  // Wait for React to be ready
  await window.waitForFunction(() => {
    return document.readyState === 'complete';
  });
  
  // Wait for any initial loading states to complete
  await window.waitForTimeout(1000);
}

/**
 * Reset app state by clearing localStorage and sessionStorage
 */
export async function resetAppState(window: Page): Promise<void> {
  await window.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

/**
 * Get app version from the main process
 */
export async function getAppVersion(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ app }) => {
    return app.getVersion();
  });
}

/**
 * Get app path from the main process
 */
export async function getAppPath(app: ElectronApplication): Promise<string> {
  return await app.evaluate(async ({ app }) => {
    return app.getAppPath();
  });
}

/**
 * Simulate app menu action
 */
export async function triggerMenuAction(app: ElectronApplication, menuId: string): Promise<void> {
  await app.evaluate(async ({ Menu }, menuId) => {
    const menu = Menu.getApplicationMenu();
    if (menu) {
      const menuItem = menu.getMenuItemById(menuId);
      if (menuItem) {
        menuItem.click();
      }
    }
  }, menuId);
}

/**
 * Wait for a new window to be created (useful for modal dialogs)
 */
export async function waitForNewWindow(app: ElectronApplication): Promise<Page> {
  const windowPromise = app.waitForEvent('window');
  return await windowPromise;
}

/**
 * Check if the app is running in development mode
 */
export async function isDevMode(app: ElectronApplication): Promise<boolean> {
  return await app.evaluate(async ({ app }) => {
    return !app.isPackaged;
  });
}

/**
 * Setup dialog mocking to prevent native dialogs from blocking tests
 */
export async function setupDialogMocking(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ dialog }) => {
    // Store original methods in case they're needed
    const originalShowOpenDialog = dialog.showOpenDialog;
    const originalShowSaveDialog = dialog.showSaveDialog;
    const originalShowMessageBox = dialog.showMessageBox;
    const originalShowErrorBox = dialog.showErrorBox;
    
    // Mock showOpenDialog to return a predefined result
    dialog.showOpenDialog = async (options) => {
      console.log('🔸 Mocked showOpenDialog called with options:', options);
      
      // Return a mock directory path for testing
      return {
        canceled: false,
        filePaths: ['/mock/test/directory']
      };
    };
    
    // Mock showSaveDialog
    dialog.showSaveDialog = async (options) => {
      console.log('🔸 Mocked showSaveDialog called with options:', options);
      
      return {
        canceled: false,
        filePath: '/mock/test/file.txt'
      };
    };
    
    // Mock showMessageBox
    dialog.showMessageBox = async (options) => {
      console.log('🔸 Mocked showMessageBox called with options:', options);
      
      return {
        response: 0, // First button (usually OK/Yes)
        checkboxChecked: false
      };
    };
    
    // Mock showErrorBox (this is synchronous)
    dialog.showErrorBox = (title, content) => {
      console.log('🔸 Mocked showErrorBox called:', { title, content });
      // Just log the error, don't show a dialog
    };
    
    // Mock showCertificateTrustDialog if it exists
    if (dialog.showCertificateTrustDialog) {
      dialog.showCertificateTrustDialog = async (...args: any[]) => {
        console.log('🔸 Mocked showCertificateTrustDialog called with args:', args);
        // This method doesn't return anything according to Electron docs
      };
    }
  });
}

/**
 * Mock file system operations for testing
 */
export async function mockFileSystemOperations(window: Page): Promise<void> {
  await window.evaluate(() => {
    // Mock the electronAPI file system methods if they exist
    const electronAPI = (window as any).electronAPI;
    if (electronAPI?.fileSystem) {
      console.log('🔸 Setting up file system API mocks...');
      
      electronAPI.fileSystem.requestDirectoryAccess = async () => {
        console.log('🔸 Mocked requestDirectoryAccess called');
        return '/mock/test/directory';
      };
      
      electronAPI.fileSystem.exists = async (path: string) => {
        console.log('🔸 Mocked exists called with path:', path);
        // Return true for mock paths, false for others
        return path.includes('/mock/');
      };
      
      electronAPI.fileSystem.readDirectory = async (path: string) => {
        console.log('🔸 Mocked readDirectory called with path:', path);
        return ['mock-file1.txt', 'mock-file2.txt', 'mock-folder/'];
      };
      
      electronAPI.fileSystem.readFile = async (path: string) => {
        console.log('🔸 Mocked readFile called with path:', path);
        return 'Mock file content for testing';
      };
      
      electronAPI.fileSystem.writeFile = async (path: string, content: string) => {
        console.log('🔸 Mocked writeFile called with path:', path, 'content length:', content.length);
        return true;
      };
      
      electronAPI.fileSystem.watchDirectory = async (path: string) => {
        console.log('🔸 Mocked watchDirectory called with path:', path);
        return { unwatch: () => console.log('🔸 Mocked unwatch called') };
      };
    } else {
      console.log('🔸 No electronAPI.fileSystem found to mock');
    }
    
    // Also mock any global file picker functions if they exist
    if ((window as any).showDirectoryPicker) {
      (window as any).showDirectoryPicker = async () => {
        console.log('🔸 Mocked showDirectoryPicker called');
        return {
          name: 'mock-directory',
          kind: 'directory'
        };
      };
    }
  });
} 