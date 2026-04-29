import { expect, type Locator, type Page, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import {
  activateSidebarNavigation,
  contextExplorerActiveNavLocator,
  waitForAppLoad,
  waitForContextExplorerPage,
  waitForSettingsPage,
} from './utils/layout-helpers';

async function activateNavigationThemeToggle(
  page: Page,
  label: 'Switch to dark mode' | 'Switch to light mode'
): Promise<void> {
  const themeToggle = page.getByRole('button', { name: label });
  await expect(themeToggle).toBeVisible();
  await expect(themeToggle).toBeEnabled();
  // This keeps keyboard semantics while avoiding the nav-toggle rerender detach race.
  await themeToggle.focus();
  await page.keyboard.press('Enter');
}

async function waitForAppearanceSection(page: Page): Promise<Locator> {
  const appearanceSection = page.getByTestId('settings-category-appearance');
  await expect(appearanceSection).toBeVisible();
  return appearanceSection;
}

async function activateAppearanceThemeButton(
  page: Page,
  label: 'Dark' | 'Light' | 'System'
): Promise<void> {
  const appearanceSection = await waitForAppearanceSection(page);
  const themeButton = appearanceSection.getByRole('button', { name: label, exact: true });
  await expect(themeButton).toBeVisible();
  await themeButton.dispatchEvent('click');
}

test.describe('Theme Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page, 10_000, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, 10_000, { waitForDatabase: false });
  });

  test('should switch themes via settings page and persist across navigation', {
    tag: '@smoke',
  }, async ({ page }) => {
    // Navigate to Settings page
    await activateSidebarNavigation(page, 'Settings');
    await waitForSettingsPage(page);

    // Verify theme controls are visible - use settings-specific selectors to avoid nav button conflicts
    const appearanceSection = await waitForAppearanceSection(page);
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
    await activateAppearanceThemeButton(page, 'Dark');

    // Wait a moment for theme to apply
    await page.waitForTimeout(100);

    // Verify dark theme is applied by checking for dark mode class or styles
    // The theme should be applied to the html or body element
    const htmlElement = page.locator('html');
    await expect(htmlElement).toHaveClass(/dark/);

    // Navigate back to Context Explorer to test persistence
    await activateSidebarNavigation(page, 'Context Explorer');
    await waitForContextExplorerPage(page);

    // Verify dark theme persists
    await expect(htmlElement).toHaveClass(/dark/);

    // Navigate back to Settings
    await activateSidebarNavigation(page, 'Settings');
    await waitForSettingsPage(page);

    // Test switching to Light theme (use settings-specific selector)
    await activateAppearanceThemeButton(page, 'Light');

    // Verify light theme is applied (dark class should be removed)
    await expect(htmlElement).not.toHaveClass(/dark/);

    // Test persistence again
    await activateSidebarNavigation(page, 'Context Explorer');
    await waitForContextExplorerPage(page);
    await expect(contextExplorerActiveNavLocator(page)).toBeVisible();
    await expect(htmlElement).not.toHaveClass(/dark/);
  });

  test('should toggle theme via navigation button', { tag: '@smoke' }, async ({ page }) => {
    // First, set a known theme state via settings to avoid system theme ambiguity
    await activateSidebarNavigation(page, 'Settings');
    await waitForSettingsPage(page);

    // Set to light theme explicitly (use settings-specific selector)
    await activateAppearanceThemeButton(page, 'Light');
    await page.waitForTimeout(100);

    // Navigate back to Context Explorer
    await activateSidebarNavigation(page, 'Context Explorer');
    await waitForContextExplorerPage(page);

    // Get the theme toggle button in navigation (aria-label changes based on current theme)
    // In light mode, button says "Switch to dark mode"
    const themeToggleDark = page.getByRole('button', { name: 'Switch to dark mode' });
    await expect(themeToggleDark).toBeVisible();

    const htmlElement = page.locator('html');

    // Verify we're starting with light theme
    await expect(htmlElement).not.toHaveClass(/dark/);

    // Click toggle to switch to dark
    await activateNavigationThemeToggle(page, 'Switch to dark mode');
    await page.waitForTimeout(100);
    await expect(htmlElement).toHaveClass(/dark/);

    // Click toggle again to switch back to light
    await activateNavigationThemeToggle(page, 'Switch to light mode');
    await page.waitForTimeout(100);
    await expect(htmlElement).not.toHaveClass(/dark/);
  });

  test('should handle system theme preference', async ({ page }) => {
    // Navigate to Settings
    await activateSidebarNavigation(page, 'Settings');
    await waitForSettingsPage(page);

    // Click System theme button (use settings-specific selector)
    await activateAppearanceThemeButton(page, 'System');

    // The actual theme applied will depend on the system preference
    // We can't control the system preference in the test, but we can verify
    // that the system option is selectable and doesn't cause errors

    // Navigate to verify no errors occurred
    await activateSidebarNavigation(page, 'Context Explorer');
    await waitForContextExplorerPage(page);

    // Navigate back to settings to verify system is still selected
    await activateSidebarNavigation(page, 'Settings');
    await waitForSettingsPage(page);

    // The system button should still be available and clickable
    await expect(
      (await waitForAppearanceSection(page)).getByRole('button', { name: 'System', exact: true })
    ).toBeVisible();
  });

  test('should maintain theme consistency across page reloads', async ({ page }) => {
    // Set to dark theme (use settings-specific selector)
    await activateSidebarNavigation(page, 'Settings');
    await activateAppearanceThemeButton(page, 'Dark');
    await page.waitForTimeout(100);

    const htmlElement = page.locator('html');
    await expect(htmlElement).toHaveClass(/dark/);

    // Reload the page
    await page.reload();

    // Wait for page to load - after reload, we'll be on Context Explorer, not Settings
    await waitForContextExplorerPage(page);

    // Verify dark theme persists after reload
    await expect(htmlElement).toHaveClass(/dark/);

    // Navigate back to settings to test light theme
    await activateSidebarNavigation(page, 'Settings');
    await waitForSettingsPage(page);

    // Switch back to light and test reload persistence (use settings-specific selector)
    await activateAppearanceThemeButton(page, 'Light');
    await page.waitForTimeout(100);
    await expect(htmlElement).not.toHaveClass(/dark/);

    // Preview mode does not serve /settings directly on hard reload, so return
    // to the app root before verifying reload persistence.
    await activateSidebarNavigation(page, 'Context Explorer');
    await waitForContextExplorerPage(page);

    await page.reload();
    await expect(contextExplorerActiveNavLocator(page)).toBeVisible();
    await expect(htmlElement).not.toHaveClass(/dark/);
  });
});
