import type { Page } from '@playwright/test';

export interface HslParts {
  hue: number;
  lightness: number;
  saturation: number;
}

type NormalizeRequest = { kind: 'literal'; value: string } | { kind: 'token'; value: string };

/** The one in-page canvas body both public helpers go through. */
async function normalizeInPage(page: Page, request: NormalizeRequest): Promise<string> {
  return page.evaluate((input) => {
    const raw =
      input.kind === 'token'
        ? getComputedStyle(document.documentElement).getPropertyValue(input.value).trim()
        : input.value;
    if (!raw) {
      throw new Error(`${input.value} is not defined on :root`);
    }
    const context = document.createElement('canvas').getContext('2d');
    if (!context) {
      throw new Error('canvas 2d context unavailable');
    }
    context.fillStyle = raw;
    return context.fillStyle;
  }, request);
}

/**
 * Resolve a root colour token to normalized `#rrggbb`. The production build
 * rewrites colour literals inside custom properties (`hsl(30 25% 99%)` becomes
 * `#fdfcfc`), so callers must never compare authored token text. Canvas
 * `fillStyle` normalizes any parseable CSS colour (hsl, hex, oklch) to hex.
 */
export async function resolveTokenColor(page: Page, token: `--${string}`): Promise<string> {
  return normalizeInPage(page, { kind: 'token', value: token });
}

/** Normalize any CSS colour literal through the same canvas path as resolveTokenColor. */
export async function normalizeColor(page: Page, literal: string): Promise<string> {
  return normalizeInPage(page, { kind: 'literal', value: literal });
}

export function hexToHsl(hex: string): HslParts {
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
