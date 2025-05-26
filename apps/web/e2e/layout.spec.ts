import { test, expect } from '@playwright/test';

test.describe('Application Layout', () => {
  test('should render the main layout correctly', async ({ page }) => {
    await page.goto('/');
    
    // Ensure the main content area is visible
    await expect(page.locator('main')).toBeVisible();
    
    // Verify the page title is for Context Explorer by default and visible
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    // Ensure the Settings H1 is in the DOM but not visible
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).not.toBeVisible();
  });

  test('should have working sidebar navigation', async ({ page }) => {
    await page.goto('/');
    
    // More specific locators for each button
    const contextExplorerButton = page.locator('aside button[title="Context Explorer"]');
    const settingsButton = page.locator('aside button[title="Settings"]');

    // Ensure both buttons are present initially
    await expect(contextExplorerButton).toBeVisible();
    await expect(settingsButton).toBeVisible();

    // Initial state: Context Explorer is active, Settings is not
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).not.toBeVisible();

    // Ensure Settings button is enabled, then click
    await expect(settingsButton).toBeEnabled({ timeout: 10000 }); // Added timeout for stability check
    await settingsButton.click();

    // Verify the Settings page content is visible and Context Explorer is not
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).not.toBeVisible();

    // Ensure Context Explorer button is enabled, then click to navigate back
    await expect(contextExplorerButton).toBeEnabled({ timeout: 10000 }); // Added timeout for stability check
    await contextExplorerButton.click();

    // Verify Context Explorer is active again
    await expect(page.getByRole('heading', { name: 'Context Explorer', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).not.toBeVisible();
  });
});
