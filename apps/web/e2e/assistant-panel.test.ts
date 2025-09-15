import { expect, test } from '@playwright/test';
import { getPanelElements, waitForAppLoad } from './utils/layout-helpers';

test.describe('Assistant panel', () => {
  test.beforeEach(async ({ page }) => {
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

    // Chat panel should now be visible within Props tab
    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();

    // Send a prompt
    await page.locator('#assistant-input').fill('hello world');
    await page.getByRole('button', { name: 'Send' }).click();

    // Expect user message to appear (allow more time in CI)
    await expect(panel.getByText('You:')).toBeVisible({ timeout: 10000 });
    await expect(panel.getByText('You:')).toHaveText(/You:/);

    // Expect streamed assistant response to appear
    await expect(panel.getByText('Assistant:')).toBeVisible({ timeout: 10_000 });

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
    await expect(panel.getByText('You:')).toBeVisible({ timeout: 10000 });
    await expect(panel.getByText('Assistant:')).toBeVisible({ timeout: 10000 });
  });
});
