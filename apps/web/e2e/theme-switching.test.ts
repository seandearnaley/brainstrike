import { expect, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

test.describe('Theme Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test('should switch themes via settings page and persist across navigation', async ({ page }) => {
    // Navigate to Settings page
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // Verify theme controls are visible - use settings-specific selectors to avoid nav button conflicts
    const appearanceSection = page.getByTestId('settings-category-appearance');
    await expect(page.getByText('Theme', { exact: true })).toBeVisible();
    await expect(
      appearanceSection.getByRole('button', { name: 'Light', exact: true })
    ).toBeVisible();
    await expect(
      appearanceSection.getByRole('button', { name: 'Dark', exact: true })
    ).toBeVisible();
    await expect(
      appearanceSection.getByRole('button', { name: 'System', exact: true })
    ).toBeVisible();

    // Test switching to Dark theme
    await appearanceSection.getByRole('button', { name: 'Dark', exact: true }).click();

    // Wait a moment for theme to apply
    await page.waitForTimeout(100);

    // Verify dark theme is applied by checking for dark mode class or styles
    // The theme should be applied to the html or body element
    const htmlElement = page.locator('html');
    await expect(htmlElement).toHaveClass(/dark/);

    // Navigate back to Context Explorer to test persistence
    await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();

    // Verify dark theme persists
    await expect(htmlElement).toHaveClass(/dark/);

    // Navigate back to Settings
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // Test switching to Light theme (use settings-specific selector)
    await page
      .getByTestId('settings-category-appearance')
      .getByRole('button', { name: 'Light', exact: true })
      .click();

    // Verify light theme is applied (dark class should be removed)
    await expect(htmlElement).not.toHaveClass(/dark/);

    // Test persistence again
    await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();
    await expect(htmlElement).not.toHaveClass(/dark/);
  });

  test('should toggle theme via navigation button', async ({ page }) => {
    // First, set a known theme state via settings to avoid system theme ambiguity
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // Set to light theme explicitly (use settings-specific selector)
    await page
      .getByTestId('settings-category-appearance')
      .getByRole('button', { name: 'Light', exact: true })
      .click();
    await page.waitForTimeout(100);

    // Navigate back to Context Explorer
    await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();

    // Get the theme toggle button in navigation (aria-label changes based on current theme)
    // In light mode, button says "Switch to dark mode"
    const themeToggleDark = page.getByRole('button', { name: 'Switch to dark mode' });
    await expect(themeToggleDark).toBeVisible();

    const htmlElement = page.locator('html');

    // Verify we're starting with light theme
    await expect(htmlElement).not.toHaveClass(/dark/);

    // Click toggle to switch to dark
    await themeToggleDark.click();
    await page.waitForTimeout(100);
    await expect(htmlElement).toHaveClass(/dark/);

    // Now the button says "Switch to light mode"
    const themeToggleLight = page.getByRole('button', { name: 'Switch to light mode' });

    // Click toggle again to switch back to light
    await themeToggleLight.click();
    await page.waitForTimeout(100);
    await expect(htmlElement).not.toHaveClass(/dark/);

    // Verify the toggle works from Settings page too
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // Toggle from settings page (button should say "Switch to dark mode" since we're in light)
    await page.getByRole('button', { name: 'Switch to dark mode' }).click();
    await page.waitForTimeout(100);
    await expect(htmlElement).toHaveClass(/dark/);

    // Verify the settings page theme buttons reflect the current state
    // Note: This might require checking button states/styling depending on implementation
  });

  test('should handle system theme preference', async ({ page }) => {
    // Navigate to Settings
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // Click System theme button (use settings-specific selector)
    const appearanceSection = page.getByTestId('settings-category-appearance');
    await appearanceSection.getByRole('button', { name: 'System', exact: true }).click();

    // The actual theme applied will depend on the system preference
    // We can't control the system preference in the test, but we can verify
    // that the system option is selectable and doesn't cause errors

    // Navigate to verify no errors occurred
    await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();

    // Navigate back to settings to verify system is still selected
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // The system button should still be available and clickable
    await expect(
      page
        .getByTestId('settings-category-appearance')
        .getByRole('button', { name: 'System', exact: true })
    ).toBeVisible();
  });

  test('should maintain theme consistency across page reloads', async ({ page }) => {
    // Set to dark theme (use settings-specific selector)
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const appearanceSection = page.getByTestId('settings-category-appearance');
    await appearanceSection.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.waitForTimeout(100);

    const htmlElement = page.locator('html');
    await expect(htmlElement).toHaveClass(/dark/);

    // Reload the page
    await page.reload();

    // Wait for page to load - after reload, we'll be on Context Explorer, not Settings
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();

    // Verify dark theme persists after reload
    await expect(htmlElement).toHaveClass(/dark/);

    // Navigate back to settings to test light theme
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();

    // Switch back to light and test reload persistence (use settings-specific selector)
    await page
      .getByTestId('settings-category-appearance')
      .getByRole('button', { name: 'Light', exact: true })
      .click();
    await page.waitForTimeout(100);
    await expect(htmlElement).not.toHaveClass(/dark/);

    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Context Explorer', exact: true })
    ).toBeVisible();
    await expect(htmlElement).not.toHaveClass(/dark/);
  });
});
