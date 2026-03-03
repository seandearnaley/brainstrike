import { expect, test } from '@playwright/test';
import { mockAssistantApi } from './utils/assistant-mocks';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

test.describe('Assistant panel (assistant-ui default)', { tag: '@smoke' }, () => {
  test.beforeEach(async ({ request }, testInfo) => {
    const response = await request.get('/api/assistant/status');
    const payload = (await response.json()) as { enabled?: boolean };
    if (!payload.enabled) {
      testInfo.skip(true, 'Assistant disabled (missing API key)');
    }
  });

  test.beforeEach(async ({ page }) => {
    await mockAssistantApi(page);
    await page.goto('/');
    await waitForAppLoad(page);
  });

  test('send message and stream response; persists across tab switches', async ({ page }) => {
    // Ensure right panel is visible (it's hidden by default in our layout)
    const elements = getPanelElements(page);
    if (await elements.showRightPanelShim.isVisible()) {
      await elements.showRightPanelShim.click();
      await expect(elements.rightPanel).toBeVisible();
    }

    // Assistant UI viewport should now be visible within Props tab
    const viewport = page.getByTestId('assistant-ui-viewport');
    await expect(viewport).toBeVisible();

    // Send a prompt
    await page.locator('#assistant-input').fill('hello world');
    await page.getByRole('button', { name: 'Send' }).click();

    // Expect streamed assistant response to appear (mock sends "Assistant: Mock response from tests.")
    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });

    // Switch away to Search tab and back to Props
    await page
      .getByRole('tab', { name: 'Search' })
      .or(page.getByRole('button', { name: 'Search' }))
      .click();
    await page
      .getByRole('tab', { name: 'Props' })
      .or(page.getByRole('button', { name: 'Props' }))
      .click();

    // State should persist across tab switches (allow time after navigation)
    await expect(viewport.getByText(/Mock response from tests/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
