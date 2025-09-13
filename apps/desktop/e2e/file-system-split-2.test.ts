import { expect, test } from './utils/electron-boot-once';
import type { ElectronAppContext } from './utils/electron-helpers';
import { mockFileSystemOperations } from './utils/electron-helpers';
import { resetToAppHome } from './utils/test-reset';

test.describe('File System Integration (B)', () => {
  let appContext: ElectronAppContext;

  test.beforeEach(async ({ electronWindow, electronApp }) => {
    await resetToAppHome(electronWindow);
    await mockFileSystemOperations(electronWindow);
    appContext = { app: electronApp, window: electronWindow } as ElectronAppContext;
  });

  test('should handle file operations', async () => {
    const fileButtons = appContext.window.getByRole('button').filter({ hasText: /file/i });
    const fileCount = await fileButtons.count();
    if (fileCount > 0) {
      await fileButtons.first().click();
      await expect(appContext.window.getByRole('dialog')).not.toBeVisible({ timeout: 2000 });
      const criticalError = appContext.window.getByText(/critical error|fatal/i);
      await expect(criticalError).not.toBeVisible();
    }
  });
});
