import { expect, test } from '@playwright/test';
import { mockAssistantApi } from './utils/assistant-mocks';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

// Assistant-UI E2E (web): forces Assistant UI mode by injecting `window.assistant`
// Then exercises a simple tool call (web.echo) and checks for streaming + progress.

test.describe('Assistant UI panel (web, assistant-ui mode)', () => {
  test.beforeEach(async ({ request }, testInfo) => {
    const response = await request.get('/api/assistant/status');
    const payload = (await response.json()) as { enabled?: boolean };
    if (!payload.enabled) {
      testInfo.skip(true, 'Assistant disabled (missing API key)');
    }
  });

  test.beforeEach(async ({ page }) => {
    await mockAssistantApi(page);
    // Force Assistant UI path without changing build flags
    await page.addInitScript(() => {
      // @ts-expect-error expose minimal object to gate AssistantUiPanel render path
      window.assistant = {};
    });

    await page.goto('/');
    await waitForAppLoad(page);
  });

  test('send message and see assistant stream with tool progress', async ({ page }) => {
    // Ensure right panel is visible
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    // Assistant UI viewport should be present (assistant-ui path)
    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

    // Send an echo message (triggers web.echo tool in server adapter)
    await page.locator('#assistant-input').fill('echo hello from web');
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await sendBtn.click();

    // Expect assistant to stream content (mock sends "Assistant: Mock response from tests.")
    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });

    const stopBtn = page.getByRole('button', { name: 'Stop' });
    await expect(stopBtn).toBeVisible();
    await expect(stopBtn).toBeEnabled({ timeout: 5_000 });

    await expect(viewport.getByText(/starting/i)).toBeVisible({ timeout: 10_000 });

    await expect(stopBtn).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 15_000 });
  });
});
