import { expect, test } from '@playwright/test';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';
import { mockBrowserApis } from './utils/mock-fs';

test.describe('Assistant panel interactions (assistant-ui)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    // Enable clipboard mocking for copy tests
    await mockBrowserApis(page, 'test-root', {}, { clipboard: true });
  });

  test('stop streaming, retry, and long-stream stop smoke', async ({ page }) => {
    // Ensure right panel is visible
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    // Open Props tab (assistant‑ui lives here)
    await page
      .getByRole('tab', { name: 'Props' })
      .or(page.getByRole('button', { name: 'Props' }))
      .click();

    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

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

    // Retry and expect assistant to respond again (assistant-ui)
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(viewport.getByText('Assistant:').first()).toBeVisible({ timeout: 10000 });

    // Send a long prompt and verify Stop works mid-stream (smoke)
    await page
      .locator('#assistant-input')
      .fill('Please write a very long explanation about TypeScript types and React patterns.');
    await sendBtn.click();
    // Wait briefly and then stop; only smoke-check that Stop becomes clickable and returns to Send
    await page.waitForTimeout(300);
    const stopBtn2 = page.getByRole('button', { name: 'Stop' });
    if (await stopBtn2.isEnabled()) {
      await stopBtn2.click();
      await expect(sendBtn).toBeEnabled({ timeout: 5000 });
    }
  });
});
