import { expect, test } from '@playwright/test';
import { mockAssistantApi } from './utils/assistant-mocks';
import { openAssistantWorkspace } from './utils/assistant-workspace';

test.describe('Assistant panel interactions (assistant-ui) @stateful @web-assistant-state', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    const response = await request.get('/api/assistant/status');
    const payload = (await response.json()) as { enabled?: boolean };
    if (!payload.enabled) {
      testInfo.skip(true, 'Assistant disabled (missing API key)');
    }
  });

  test.beforeEach(async ({ page }) => {
    await mockAssistantApi(page);
    await openAssistantWorkspace(page, {
      clipboard: true,
      rootName: 'assistant-panel-interactions',
    });
  });

  test('stop streaming, retry, and long-stream stop smoke', async ({ page }) => {
    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

    // Start a prompt and then stop mid-stream
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await page.locator('#assistant-input').fill('This is a web prompt to test stop and retry.');
    await sendBtn.click();
    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeVisible();
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

    // Retry and expect assistant to respond again (assistant-ui) - mock sends "Assistant: Mock response from tests."
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Send a long prompt and verify Stop works mid-stream (smoke)
    await page
      .locator('#assistant-input')
      .fill('Please write a very long explanation about TypeScript types and React patterns.');
    await sendBtn.click();
    // Wait briefly and then stop; only smoke-check that Stop becomes clickable and returns to Send
    await page.waitForTimeout(600);
    const stopBtn2 = page.getByRole('button', { name: 'Stop' });
    if (await stopBtn2.isEnabled()) {
      await stopBtn2.click();
      await expect(sendBtn).toBeVisible({ timeout: 15_000 });
    }
  });
});
