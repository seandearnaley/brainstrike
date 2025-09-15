import { expect, test } from '@playwright/test';
import type { ElectronAppContext } from './utils/electron-helpers';
import { closeElectronApp, launchElectronApp, waitForAppReady } from './utils/electron-helpers';

test.describe('Assistant panel interactions (desktop)', () => {
  let appContext: ElectronAppContext;

  test.beforeEach(async () => {
    appContext = await launchElectronApp();
    await waitForAppReady(appContext.window);
  });

  test.afterEach(async () => {
    if (appContext) await closeElectronApp(appContext);
  });

  test('stop streaming, then retry, and copy code block', async () => {
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

    // Start a prompt and stop mid-stream
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await page.locator('#assistant-input').fill('This is a long prompt to test stop action.');
    await sendBtn.click();

    // Send button should be disabled during streaming
    await expect(sendBtn).toBeDisabled();

    // Stop streaming
    await page.getByRole('button', { name: 'Stop' }).click();

    // Send should re-enable after stop
    await expect(sendBtn).toBeEnabled({ timeout: 5000 });

    // Retry the last prompt; should stream again
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.getByText('Assistant:').first()).toBeVisible({ timeout: 10000 });

    // Now send a message that contains a code block to test copy
    await page.locator('#assistant-input').fill('```js\nconsole.log("hello");\n```');
    await sendBtn.click();

    // Reset clipboard, find the copy button and click
    await appContext.app.evaluate(async ({ clipboard }) => clipboard.writeText(''));
    // Ensure the user message rendered
    await expect(panel.getByText('You:').first()).toBeVisible();
    // Click any visible Copy code button associated with the code block
    const copyBtn = panel.getByRole('button', { name: 'Copy code' }).last();
    await expect(copyBtn).toBeVisible({ timeout: 10000 });
    await copyBtn.click();

    // Small delay to allow clipboard bridge to flush in headless Electron
    await page.waitForTimeout(75);

    // Verify clipboard content (prefer renderer-exposed clipboard)
    const clip = await appContext.app.evaluate(async ({ clipboard }) => clipboard.readText());
    expect(clip).toContain('console.log("hello")');
  });
});
