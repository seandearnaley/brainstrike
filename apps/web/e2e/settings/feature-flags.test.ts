import { expect, test } from '@playwright/test';

test.describe('Feature Flags - File Explorer V2', () => {
  test('toggle persists across reloads and affects layout testid', async ({ page }) => {
    await page.goto('/');

    // Navigate to settings via sidebar
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // Toggle ON
    await page.getByTestId('ff-explorer-v2-toggle').click();

    // Reload and assert state (navigation resets to home on reload)
    await page.reload();
    await expect(page.locator('body')).toBeVisible();

    // Confirm localStorage value
    const lsOn = await page.evaluate(() => localStorage.getItem('FEATURE_FILE_EXPLORER_V2'));
    expect(lsOn).toBe('1');

    // Go home and assert explorer testid
    await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
    await expect(page.getByTestId('explorer-v2-enabled')).toBeVisible();

    // Back to settings via sidebar, then toggle OFF
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByTestId('ff-explorer-v2-toggle').click();

    // Reload and assert OFF (back at home)
    await page.reload();
    const lsOff = await page.evaluate(() => localStorage.getItem('FEATURE_FILE_EXPLORER_V2'));
    expect(lsOff).toBe('0');

    await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
    await expect(page.getByTestId('explorer-v2-disabled')).toBeVisible();
  });
});


