/**
 * E2E Tests for Theme CSS Consistency
 *
 * These tests verify that the theme CSS is correctly applied in the actual browser
 * and that external libraries don't override our theme variables.
 */

import { expect, type Page, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import { ensureRightPanelVisible, waitForAppLoad } from './utils/layout-helpers';

/**
 * Helper to click a theme button in the settings page appearance section.
 * Uses scoped selector to avoid conflicts with nav sidebar theme toggle.
 */
async function clickSettingsThemeButton(page: Page, themeName: 'Light' | 'Dark' | 'System') {
  await page
    .getByTestId('settings-category-appearance')
    .getByRole('button', { name: themeName, exact: true })
    .click();
}

async function waitForThemeApplied(page: Page, mode: 'light' | 'dark'): Promise<void> {
  const shouldBeDark = mode === 'dark';
  await page.waitForFunction((expectDark) => {
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const bsBackground = styles.getPropertyValue('--bs-background').trim();

    if (!bsBackground) {
      return false;
    }

    const isDark = root.classList.contains('dark');
    return expectDark ? isDark : !isDark;
  }, shouldBeDark);
}

test.describe('Theme CSS Consistency (E2E)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
  });

  test('should load CSS variables in light mode', async ({ page }) => {
    // Switch to light mode (use settings-specific selector to avoid nav button conflict)
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Light');
    await waitForThemeApplied(page, 'light');

    // Check CSS variables are defined
    const variables = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      return {
        bsBackground: styles.getPropertyValue('--bs-background').trim(),
        background: styles.getPropertyValue('--background').trim(),
        colorBackground: styles.getPropertyValue('--color-background').trim(),
      };
    });

    expect(variables.bsBackground).toBeTruthy();
    expect(variables.background).toBeTruthy();
    expect(variables.colorBackground).toBeTruthy();

    // Light mode should have high lightness
    const lightness = Number.parseInt(variables.bsBackground.split(' ')[2] ?? '0', 10);
    expect(lightness).toBeGreaterThan(90);
  });

  test('should load CSS variables in dark mode', async ({ page }) => {
    // Switch to dark mode
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    // Check CSS variables are defined
    const variables = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      return {
        bsBackground: styles.getPropertyValue('--bs-background').trim(),
        background: styles.getPropertyValue('--background').trim(),
        colorBackground: styles.getPropertyValue('--color-background').trim(),
        isDarkMode: root.classList.contains('dark'),
      };
    });

    expect(variables.isDarkMode).toBe(true);
    expect(variables.bsBackground).toBeTruthy();
    expect(variables.background).toBeTruthy();
    expect(variables.colorBackground).toBeTruthy();

    // Dark mode should have low lightness
    const lightness = Number.parseInt(variables.bsBackground.split(' ')[2] ?? '0', 10);
    expect(lightness).toBeLessThan(20);
  });

  test('should maintain warm neutral theme in dark mode (not pure black)', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const themeValues = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      const background = styles.getPropertyValue('--bs-background').trim();

      const [hue, saturation, lightness] = background.split(' ');
      return {
        hue: Number.parseInt(hue ?? '0', 10),
        saturation: Number.parseInt(saturation ?? '0', 10),
        lightness: Number.parseInt(lightness ?? '0', 10),
      };
    });

    // Warm neutral theme should have warm hue (around 25-35, warm brown/orange)
    expect(themeValues.hue).toBeGreaterThanOrEqual(20);
    expect(themeValues.hue).toBeLessThanOrEqual(40);

    // Should have some saturation (warm tint, not grayscale)
    expect(themeValues.saturation).toBeGreaterThanOrEqual(5);
    expect(themeValues.saturation).toBeLessThanOrEqual(15);

    // Should be dark but not pure black
    expect(themeValues.lightness).toBeLessThan(15);
    expect(themeValues.lightness).toBeGreaterThan(0);
  });

  test('should ensure --background equals --bs-background', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const isConsistent = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      const bsBackground = styles.getPropertyValue('--bs-background').trim();
      const background = styles.getPropertyValue('--background').trim();

      return {
        bsBackground,
        background,
        areEqual: bsBackground === background,
      };
    });

    expect(
      isConsistent.areEqual,
      `Expected --background (${isConsistent.background}) to equal --bs-background (${isConsistent.bsBackground})`
    ).toBe(true);
  });

  test('should verify all theme variables are consistent', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const inconsistentVars = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      const colorVars = [
        'background',
        'foreground',
        'card',
        'primary',
        'secondary',
        'muted',
        'accent',
        'destructive',
      ];

      const inconsistent: string[] = [];

      for (const varName of colorVars) {
        const bsValue = styles.getPropertyValue(`--bs-${varName}`).trim();
        const value = styles.getPropertyValue(`--${varName}`).trim();

        if (bsValue !== value) {
          inconsistent.push(`${varName}: --bs-${varName}="${bsValue}" but --${varName}="${value}"`);
        }
      }

      return inconsistent;
    });

    expect(
      inconsistentVars,
      `Found inconsistent variables: ${inconsistentVars.join(', ')}`
    ).toHaveLength(0);
  });

  test('should not have assistant-ui hardcoded values overriding theme', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const hasOldValues = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);
      const background = styles.getPropertyValue('--background').trim();

      // Old wrong assistant-ui values: "240 10% 3.9%"
      // Our correct value: "30 8% 9%" (warm neutral dark)

      const [hue, saturation] = background.split(' ');
      const hueValue = Number.parseInt(hue ?? '0', 10);
      const satValue = Number.parseInt(saturation ?? '0', 10);

      // Check if it has the old wrong values
      return hueValue === 240 && satValue === 10;
    });

    expect(hasOldValues, 'Found old assistant-ui hardcoded theme values! Check overrides.css').toBe(
      false
    );
  });

  test('should have visible gradients with sufficient color separation', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const colorSeparation = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      const background = styles.getPropertyValue('--bs-background').trim();
      const muted = styles.getPropertyValue('--bs-muted').trim();

      const bgLightness = Number.parseInt(background.split(' ')[2] ?? '0', 10);
      const mutedLightness = Number.parseInt(muted.split(' ')[2] ?? '0', 10);

      return Math.abs(bgLightness - mutedLightness);
    });

    // Need at least 5% difference for visible gradients
    expect(
      colorSeparation,
      'Insufficient color separation for visible gradients'
    ).toBeGreaterThanOrEqual(5);
  });

  test('should maintain theme when opening assistant panel', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    // Navigate back to main page
    await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();

    // Open tools panel (assistant panel)
    await ensureRightPanelVisible(page);
    await page.waitForTimeout(200);

    // Check that theme is still consistent after loading assistant-ui
    const isStillConsistent = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      const bsBackground = styles.getPropertyValue('--bs-background').trim();
      const background = styles.getPropertyValue('--background').trim();

      return bsBackground === background;
    });

    expect(isStillConsistent, 'Theme became inconsistent after loading assistant panel').toBe(true);
  });

  test('should apply theme to assistant panel elements', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    await page.getByRole('button', { name: 'Context Explorer', exact: true }).click();
    await ensureRightPanelVisible(page);
    await page.waitForTimeout(200);

    // Check for elements with .bs-thread or .aui-* classes
    const hasAssistantElements = await page.evaluate(
      () => document.querySelector('.bs-thread, [class*="aui-"]') !== null
    );

    // If assistant elements exist, verify they use the theme
    if (hasAssistantElements) {
      const threadTheme = await page.evaluate(() => {
        const threadEl = document.querySelector('.bs-thread') as HTMLElement;
        if (!threadEl) {
          return null;
        }

        const styles = getComputedStyle(threadEl);
        return {
          background: styles.getPropertyValue('--background').trim(),
          foreground: styles.getPropertyValue('--foreground').trim(),
        };
      });

      if (threadTheme) {
        expect(threadTheme.background).toBeTruthy();
        expect(threadTheme.foreground).toBeTruthy();
      }
    }
  });
});
