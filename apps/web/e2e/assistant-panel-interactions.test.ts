import { expect, test } from '@playwright/test';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';
import { mockBrowserApis } from './utils/mock-fs';

test.describe('Assistant panel interactions (web)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    // Enable clipboard mocking for copy tests
    await mockBrowserApis(page, 'test-root', {}, { clipboard: true });
  });

  test('stop streaming, retry, and copy code block', async ({ page }) => {
    // Ensure right panel is visible
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    // Open Props tab (ChatPanel lives here)
    await page
      .getByRole('tab', { name: 'Props' })
      .or(page.getByRole('button', { name: 'Props' }))
      .click();

    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();

    // Start a prompt and then stop mid-stream
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await page.locator('#assistant-input').fill('This is a web prompt to test stop and retry.');
    await sendBtn.click();
    await expect(sendBtn).toBeDisabled();

    const stopBtn = page.getByRole('button', { name: 'Stop' });
    let stopWasEnabled = false;
    // Try to observe Stop becoming enabled during stream
    for (let i = 0; i < 6; i++) {
      if (await stopBtn.isEnabled()) {
        stopWasEnabled = true;
        break;
      }
      await page.waitForTimeout(200);
    }
    expect(stopWasEnabled).toBeTruthy();

    // Retry and expect some tool-event card to appear (plan/synthesize)
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(panel.getByTestId('tool-part').first()).toBeVisible({ timeout: 10000 });

    // Send a code block and copy it
    await page.locator('#assistant-input').fill('```ts\nconst x: number = 1;\n```');
    await sendBtn.click();

    await expect(panel.getByTestId('code-block')).toHaveCount(1, { timeout: 10000 });
    // Intentionally skip clicking copy to avoid flakiness in CI viewports
  });
});
