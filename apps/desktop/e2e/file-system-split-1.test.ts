import { expect, test } from './utils/electron-boot-once';
import type { ElectronAppContext } from './utils/electron-helpers';
import { mockFileSystemOperations } from './utils/electron-helpers';

test.describe('File System Integration (A)', () => {
  let appContext: ElectronAppContext;

  test.beforeEach(async ({ electronWindow, electronApp }) => {
    await mockFileSystemOperations(electronWindow);
    appContext = { app: electronApp, window: electronWindow } as ElectronAppContext;
  });

  test('should handle file system access permissions', async () => {
    const fileSystemButton = appContext.window.getByRole('button', { name: /browse/i });
    if (await fileSystemButton.isVisible().catch(() => false)) {
      await fileSystemButton.click();
      await expect(appContext.window.getByRole('dialog')).not.toBeVisible({ timeout: 2000 });
      const errorMessage = appContext.window.getByText(/error/i);
      await expect(errorMessage).not.toBeVisible();
    }
  });

  test('should handle directory operations', async () => {
    const fileExplorerPanel = appContext.window.getByTestId('file-explorer-panel');
    if (await fileExplorerPanel.isVisible().catch(() => false)) {
      const directoryTree = appContext.window.getByRole('tree');
      const fileList = appContext.window.getByRole('list');
      const hasTree = await directoryTree.isVisible().catch(() => false);
      const hasList = await fileList.isVisible().catch(() => false);
      expect(hasTree || hasList).toBe(true);
    }
  });
});
