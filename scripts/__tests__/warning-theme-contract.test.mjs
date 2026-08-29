import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..');
const SHARED_THEME = readFileSync(join(REPOSITORY_ROOT, 'packages/ui/src/globals.css'), 'utf8');
const WEB_THEME = readFileSync(join(REPOSITORY_ROOT, 'apps/web/src/app/globals.css'), 'utf8');
const DESKTOP_THEME = readFileSync(
  join(REPOSITORY_ROOT, 'apps/desktop/src/renderer/styles.css'),
  'utf8'
);
const STATUS_GLYPH = readFileSync(
  join(REPOSITORY_ROOT, 'packages/app-shell/src/thread-row-status-glyph.tsx'),
  'utf8'
);

function blockFor(selector) {
  const escapedSelector = selector.replace('.', '\\.');
  const match = SHARED_THEME.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match?.[1]) {
    throw new Error(`Missing ${selector} block in packages/ui/src/globals.css`);
  }
  return match[1];
}

function hslToken(block, name) {
  const match = block.match(
    new RegExp(`--bs-${name}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%`)
  );
  if (!match) {
    throw new Error(`Missing --bs-${name} HSL token`);
  }
  return match.slice(1, 4).map(Number);
}

function hslToRgb([hue, saturationPercent, lightnessPercent]) {
  const saturation = saturationPercent / 100;
  const lightness = lightnessPercent / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = (((hue % 360) + 360) % 360) / 60;
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const [red, green, blue] =
    huePrime < 1
      ? [chroma, secondary, 0]
      : huePrime < 2
        ? [secondary, chroma, 0]
        : huePrime < 3
          ? [0, chroma, secondary]
          : huePrime < 4
            ? [0, secondary, chroma]
            : huePrime < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
  const offset = lightness - chroma / 2;
  return [red + offset, green + offset, blue + offset];
}

function relativeLuminance(rgb) {
  return rgb
    .map((channel) => (channel <= 0.040_45 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce(
      (luminance, channel, index) => luminance + channel * [0.2126, 0.7152, 0.0722][index],
      0
    );
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('semantic warning theme contract', () => {
  it('exposes one warning utility through the shared semantic token in both apps', () => {
    assert.match(SHARED_THEME, /--warning:\s*var\(--bs-warning\);/);
    assert.match(SHARED_THEME, /--warning-foreground:\s*var\(--bs-warning-foreground\);/);
    for (const appTheme of [WEB_THEME, DESKTOP_THEME]) {
      assert.match(appTheme, /--color-warning:\s*hsl\(var\(--warning\)\);/);
      assert.match(appTheme, /--color-warning-foreground:\s*hsl\(var\(--warning-foreground\)\);/);
    }
    assert.match(STATUS_GLYPH, /className: 'bg-warning'/);
    assert.doesNotMatch(STATUS_GLYPH, /bg-amber-/);
  });

  it('keeps the resolved warning mark above 4.5:1 against light and dark row surfaces', () => {
    for (const selector of [':root', '.dark']) {
      const theme = blockFor(selector);
      const warning = hslToRgb(hslToken(theme, 'warning'));
      const warningForeground = hslToRgb(hslToken(theme, 'warning-foreground'));
      const rowSurface = hslToRgb(hslToken(theme, 'muted'));
      assert.ok(
        contrastRatio(warning, rowSurface) >= 4.5,
        `${selector} warning contrast must be at least 4.5:1`
      );
      assert.ok(
        contrastRatio(warning, warningForeground) >= 4.5,
        `${selector} warning foreground contrast must be at least 4.5:1`
      );
    }
  });
});
