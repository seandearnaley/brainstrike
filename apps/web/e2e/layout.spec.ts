import { test, expect } from '@playwright/test';

test.describe('Application Layout', () => {
  test('should render the main layout correctly', async ({ page }) => {
    await page.goto('/');
    
    // Check if sidebar exists
    await expect(page.locator('aside')).toBeVisible();
    
    // Check if main content area exists
    await expect(page.locator('main')).toBeVisible();
    
    // Verify the page title
    await expect(page.locator('h1')).toHaveText('Context Explorer');
  });

  test('should have working sidebar navigation', async ({ page }) => {
    await page.goto('/');
    
    // Check if all navigation links are present
    const sidebarLinks = await page.locator('aside a');
    await expect(sidebarLinks).toHaveCount(3); // We have 3 apps in the sidebar
    
    // Verify the first link (Context Explorer) is active by default
    const firstLink = sidebarLinks.first();
    await expect(firstLink).toHaveAttribute('title', 'Context Explorer');
    await expect(firstLink).toHaveClass(/bg-gray-200/); // Active state class
  });
});
