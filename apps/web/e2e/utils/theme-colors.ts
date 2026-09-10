import type { Page } from '@playwright/test';

export interface HslParts {
  hue: number;
  lightness: number;
  saturation: number;
}

type NormalizeRequest = { kind: 'literal'; value: string } | { kind: 'token'; value: string };

/**
 * The one in-page canvas body both public helpers go through.
 *
 * Pixel readback is the only normalization that covers every syntax the theme
 * layer can emit — `hsl()`, hex, `rgb()`, `oklch()`, `color-mix()` and relative
 * colour syntax all collapse to the same sRGB triple. Canvas `fillStyle`
 * serialization on its own does NOT: Chrome echoes the ORIGINAL text back for
 * `oklch()`/`oklab()` and returns an absolute `oklch()` for relative colours,
 * so comparing `fillStyle` strings would compare authored text, not colour.
 */
async function normalizeInPage(page: Page, request: NormalizeRequest): Promise<string> {
  return page.evaluate((input) => {
    const raw =
      input.kind === 'token'
        ? getComputedStyle(document.documentElement).getPropertyValue(input.value).trim()
        : input.value.trim();
    if (!raw) {
      throw new Error(
        input.kind === 'token'
          ? `${input.value} is not defined on :root`
          : 'cannot normalize an empty colour literal'
      );
    }
    const label = input.kind === 'token' ? input.value : 'colour literal';

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
  }, request);
}

/**
 * Resolve a root colour token to normalized sRGB `#rrggbb`. The production build
 * rewrites colour literals inside custom properties (`hsl(30 25% 99%)` becomes
 * `#fdfcfc`), so callers must never compare authored token text.
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
