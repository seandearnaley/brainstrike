/**
 * E2E Tests for Theme CSS Consistency
 *
 * These tests verify that the theme CSS is correctly applied in the actual browser
 * and that external libraries don't override our theme variables.
 */

import { expect, type Page, test } from '@playwright/test';
import { resetAppState } from './utils/app-state';
import {
  activateAppearanceThemeButton,
  ensureRightPanelVisible,
  leaveSettingsPage,
  openSettingsPage,
  waitForAppearanceSection,
  waitForAppLoad,
  waitForSettingsPage,
} from './utils/layout-helpers';

interface HslParts {
  hue: number;
  lightness: number;
  saturation: number;
}

/**
 * Normalize any CSS colour to an sRGB `#rrggbb` string by painting it onto a
 * 1x1 canvas and reading the pixel back.
 *
 * Pixel readback is the only normalization that covers every syntax the theme
 * layer can emit — `hsl()`, hex, `rgb()`, `oklch()`, `color-mix()` and relative
 * colour syntax all collapse to the same sRGB triple. Canvas `fillStyle`
 * serialization on its own does NOT: Chrome echoes the ORIGINAL text back for
 * `oklch()`/`oklab()` and returns an absolute `oklch()` for relative colours,
 * so comparing `fillStyle` strings would compare authored text, not colour.
 *
 * The production build also rewrites colour literals inside custom properties
 * (`hsl(30 25% 99%)` becomes `#fdfcfc`), so the suite must never compare
 * authored token text.
 */
async function normalizeCssColor(
  page: Page,
  source: { literal: string | null; token: string | null }
): Promise<string> {
  return page.evaluate((input) => {
    let raw: string;
    let label: string;
    if (input.token === null) {
      raw = (input.literal ?? '').trim();
      label = 'colour literal';
      if (!raw) {
        throw new Error('cannot normalize an empty colour literal');
      }
    } else {
      raw = getComputedStyle(document.documentElement).getPropertyValue(input.token).trim();
      label = input.token;
      if (!raw) {
        throw new Error(`${input.token} is not defined on :root`);
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('canvas 2d context unavailable');
    }
    // An unparseable colour leaves fillStyle untouched, so prove the assignment took.
    const sentinel = '#010203';
    context.fillStyle = sentinel;
    context.fillStyle = raw;
    if (context.fillStyle === sentinel && raw.replace(/\s/gu, '').toLowerCase() !== sentinel) {
      throw new Error(`${label} is not a parseable CSS colour: "${raw}"`);
    }
    context.clearRect(0, 0, 1, 1);
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    const r = pixel[0];
    const g = pixel[1];
    const b = pixel[2];
    const a = pixel[3];
    if (r === undefined || g === undefined || b === undefined || a === undefined) {
      throw new Error(`${label}: canvas readback returned an empty pixel`);
    }
    if (a !== 255) {
      throw new Error(`${label} is not opaque (alpha ${a}): "${raw}"`);
    }
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }, source);
}

/**
 * Resolve a root colour token to normalized `#rrggbb` via {@link normalizeCssColor}.
 */
async function resolveTokenColor(page: Page, token: `--${string}`): Promise<string> {
  return normalizeCssColor(page, { literal: null, token });
}

/**
 * Normalize a literal colour string (e.g. a computed `backgroundColor`) through
 * the exact same in-page routine used for tokens, so the two are comparable.
 */
async function normalizeColor(page: Page, literal: string): Promise<string> {
  return normalizeCssColor(page, { literal, token: null });
}

function hexToHsl(hex: string): HslParts {
  const match = /^#(?<rgb>[0-9a-f]{6})$/iu.exec(hex);
  if (!match?.groups?.['rgb']) {
    throw new Error(`Expected an opaque #rrggbb colour from canvas normalization, got "${hex}"`);
  }
  const packed = Number.parseInt(match.groups['rgb'], 16);
  const r = ((packed >> 16) & 255) / 255;
  const g = ((packed >> 8) & 255) / 255;
  const b = (packed & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (delta !== 0) {
    saturation = delta / (1 - Math.abs(2 * lightness - 1));
    if (max === r) {
      hue = ((g - b) / delta) % 6;
    } else if (max === g) {
      hue = (b - r) / delta + 2;
    } else {
      hue = (r - g) / delta + 4;
    }
    hue *= 60;
    if (hue < 0) {
      hue += 360;
    }
  }
  return {
    hue: Math.round(hue),
    lightness: Math.round(lightness * 100),
    saturation: Math.round(saturation * 100),
  };
}

/**
 * Open Settings (the nav-rail route — BST-1023/1024/1025 pinned every launch
 * to the canonical layout-helpers flow, and BST-1668 made Settings a full app
 * tab again) and ASSERT the appearance section is active (these specs depend
 * on Appearance being the default category). The route STAYS active for the
 * CSS-variable assertions below: they read document-level computed styles,
 * which the active tab does not affect.
 */
async function openAppearanceSettings(page: Page): Promise<void> {
  await openSettingsPage(page);
  await waitForSettingsPage(page);
  await waitForAppearanceSection(page);
}

const clickSettingsThemeButton = activateAppearanceThemeButton;

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
    // Switch to light mode via the Settings route's appearance section
    await openAppearanceSettings(page);
    await clickSettingsThemeButton(page, 'Light');
    await waitForThemeApplied(page, 'light');

    // Check CSS variables are defined
    const variables = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      return {
        background: styles.getPropertyValue('--background').trim(),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bsBackground: styles.getPropertyValue('--bs-background').trim(),
      };
    });

    expect(variables.bsBackground).toBeTruthy();
    expect(variables.background).toBeTruthy();
    // Pin the whole utility -> token -> palette chain: the body's painted
    // background must be the very colour `--background` resolves to.
    const [bodyBackground, backgroundToken] = await Promise.all([
      normalizeColor(page, variables.bodyBackground),
      resolveTokenColor(page, '--background'),
    ]);
    expect(bodyBackground).toBe(backgroundToken);

    // Light mode should have high lightness
    const bsBackgroundColor = await resolveTokenColor(page, '--bs-background');
    expect(hexToHsl(bsBackgroundColor).lightness).toBeGreaterThan(90);
  });

  test('should load CSS variables in dark mode', async ({ page }) => {
    // Switch to dark mode
    await openAppearanceSettings(page);
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    // Check CSS variables are defined
    const variables = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      return {
        background: styles.getPropertyValue('--background').trim(),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bsBackground: styles.getPropertyValue('--bs-background').trim(),
        isDarkMode: root.classList.contains('dark'),
      };
    });

    expect(variables.isDarkMode).toBe(true);
    expect(variables.bsBackground).toBeTruthy();
    expect(variables.background).toBeTruthy();
    // Pin the whole utility -> token -> palette chain: the body's painted
    // background must be the very colour `--background` resolves to.
    const [bodyBackground, backgroundToken] = await Promise.all([
      normalizeColor(page, variables.bodyBackground),
      resolveTokenColor(page, '--background'),
    ]);
    expect(bodyBackground).toBe(backgroundToken);

    // Dark mode should have low lightness
    const bsBackgroundColor = await resolveTokenColor(page, '--bs-background');
    expect(hexToHsl(bsBackgroundColor).lightness).toBeLessThan(20);
  });

  test('should maintain warm neutral theme in dark mode (not pure black)', async ({ page }) => {
    await openAppearanceSettings(page);
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const background = await resolveTokenColor(page, '--bs-background');
    const themeValues = hexToHsl(background);

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

  test('uses neutral focus tokens instead of brand-blue borders', async ({ page }) => {
    await openAppearanceSettings(page);

    for (const mode of ['Light', 'Dark'] as const) {
      await clickSettingsThemeButton(page, mode);
      await waitForThemeApplied(page, mode.toLowerCase() as 'light' | 'dark');

      const tokens = await Promise.all([
        resolveTokenColor(page, '--bs-ring'),
        resolveTokenColor(page, '--bs-sidebar-ring'),
      ]);

      for (const token of tokens) {
        const { hue } = hexToHsl(token);
        expect(hue === 0 || (hue >= 20 && hue <= 40)).toBe(true);
      }
    }
  });

  test('should ensure --background equals --bs-background', async ({ page }) => {
    await openAppearanceSettings(page);
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const isConsistent = await page.evaluate(() => {
      const root = document.documentElement;
      const styles = getComputedStyle(root);

      const bsBackground = styles.getPropertyValue('--bs-background').trim();
      const background = styles.getPropertyValue('--background').trim();

      return {
        areEqual: bsBackground === background,
        background,
        bsBackground,
      };
    });

    expect(
      isConsistent.areEqual,
      `Expected --background (${isConsistent.background}) to equal --bs-background (${isConsistent.bsBackground})`
    ).toBe(true);
  });

  test('should verify all theme variables are consistent', async ({ page }) => {
    await openAppearanceSettings(page);
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
    await openAppearanceSettings(page);
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const background = await resolveTokenColor(page, '--background');

    // Old wrong assistant-ui values: "240 10% 3.9%"
    // Our correct value: "30 8% 9%" (warm neutral dark)
    const { hue, saturation } = hexToHsl(background);
    const hasOldValues = hue === 240 && saturation === 10;

    expect(hasOldValues, 'Found old assistant-ui hardcoded theme values! Check overrides.css').toBe(
      false
    );
  });

  test('should have visible gradients with sufficient color separation', async ({ page }) => {
    await openAppearanceSettings(page);
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    const [background, muted] = await Promise.all([
      resolveTokenColor(page, '--bs-background'),
      resolveTokenColor(page, '--bs-muted'),
    ]);

    const colorSeparation = Math.abs(hexToHsl(background).lightness - hexToHsl(muted).lightness);

    // Need at least 5% difference for visible gradients
    expect(
      colorSeparation,
      'Insufficient color separation for visible gradients'
    ).toBeGreaterThanOrEqual(5);
  });

  test('should maintain theme when opening assistant panel', async ({ page }) => {
    await openAppearanceSettings(page);
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    // Navigate back to the explorer route.
    await leaveSettingsPage(page);

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
    await openAppearanceSettings(page);
    await clickSettingsThemeButton(page, 'Dark');
    await waitForThemeApplied(page, 'dark');

    await leaveSettingsPage(page);
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
