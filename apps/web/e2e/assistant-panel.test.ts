import { expect, test } from '@playwright/test';

test.describe('Assistant panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('send message and stream response; persists across tab switches', async ({ page }) => {
    // Ensure chat panel is visible in Props tab by default
    const panel = page.getByTestId('chat-panel');
    await expect(panel).toBeVisible();

    // Send a prompt
    await page.locator('#assistant-input').fill('hello world');
    await page.getByRole('button', { name: 'Send' }).click();

    // Expect user message to appear
    await expect(panel.getByText('You:')).toBeVisible();
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

    // State should persist across tab switches
    await expect(panel.getByText('You:')).toBeVisible();
    await expect(panel.getByText('Assistant:')).toBeVisible();
  });
});
