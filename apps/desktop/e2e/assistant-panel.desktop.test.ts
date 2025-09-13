import { expect, test } from '@playwright/test';
import type { ElectronAppContext } from './utils/electron-helpers';
import { closeElectronApp, launchElectronApp, waitForAppReady } from './utils/electron-helpers';

test.describe('Assistant panel (desktop)', () => {
  let appContext: ElectronAppContext;

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
  });

  test.afterEach(async () => {
    if (appContext) await closeElectronApp(appContext);
  });

  test('send message and see streamed response in right panel', async () => {
    const page = appContext.window;

    // Ensure right panel is visible
    const rightPanel = page.locator('[data-panel-id="right-panel"]');
    if (!(await rightPanel.isVisible())) {
      await page.getByRole('button', { name: 'Show right panel' }).click();
      await expect(rightPanel).toBeVisible();
    }

    // Switch to Props tab
    await page
      .getByRole('tab', { name: 'Props' })
      .or(page.getByRole('button', { name: 'Props' }))
      .click();

    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();

    // Send a prompt
    await page.locator('#assistant-input').fill('hello desktop');
    await page.getByRole('button', { name: 'Send' }).click();

    // Validate user and assistant rows appear
    await expect(panel.getByText('You:')).toBeVisible();
    await expect(panel.getByText('Assistant:')).toBeVisible({ timeout: 10000 });
  });
});
