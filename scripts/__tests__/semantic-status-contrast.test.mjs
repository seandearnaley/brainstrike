import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { composite, contrastRatio, hslToRgb } from '../lib/color-contrast.mjs';
import {
  extractThemeColors,
  hslChannels,
  readAppThemes,
  readSharedThemeCss,
  themeModes,
} from '../lib/semantic-theme-contract.mjs';

const root = join(import.meta.dirname, '..', '..');
const sharedCss = readSharedThemeCss(root);
const surfaces = [
  'background',
  'card',
  'popover',
  'muted',
  'secondary',
  'accent',
  'sidebar',
  'sidebar-accent',
];
const modes = themeModes(sharedCss);

function color(tokens, name) {
  const value = tokens.get(`--bs-${name}`);
  assert.ok(value, `Missing --bs-${name}`);
  return hslToRgb(hslChannels(value));
}

it('resolves the high-contrast cascade without confusing it with base themes', () => {
  assert.deepEqual(Object.keys(modes), [
    'light',
    'dark',
    'high-contrast-light',
    'high-contrast-dark',
  ]);
  assert.equal(modes.light.get('--bs-background'), 'hsl(30 25% 99%)');
  assert.equal(modes.dark.get('--bs-background'), 'hsl(30 8% 9%)');
  assert.equal(modes['high-contrast-light'].get('--bs-background'), 'hsl(0 0% 100%)');
  assert.equal(modes['high-contrast-dark'].get('--bs-background'), 'hsl(0 0% 0%)');
});

it('exposes success/info and their filled-surface foregrounds in each base theme and both apps', () => {
  // The alias layer is declared once on :root and inherited by the dark theme
  // (same element), so the effective per-mode cascade is what must carry it.
  for (const mode of ['light', 'dark']) {
    for (const token of ['success', 'success-foreground', 'info', 'info-foreground']) {
      assert.equal(modes[mode].get(`--${token}`), `var(--bs-${token})`, `${mode} --${token} alias`);
    }
  }
  for (const [app, css] of Object.entries(readAppThemes(root))) {
    const colors = extractThemeColors(css);
    for (const token of ['success', 'success-foreground', 'info', 'info-foreground']) {
      assert.equal(colors.get(token), `var(--${token})`, `${app} --color-${token}`);
    }
  }
});

for (const status of ['success', 'info', 'warning', 'destructive']) {
  describe(`${status} semantic contrast`, () => {
    for (const [mode, tokens] of Object.entries(modes)) {
      it(`meets unrounded AA text contrast on all supported ${mode} surfaces and filled status backgrounds`, () => {
        const foreground = color(tokens, status);
        for (const surface of surfaces) {
          const backdrop = color(tokens, surface);
          const ratio = contrastRatio(foreground, backdrop);
          assert.ok(ratio >= 4.5, `${mode} ${status} on ${surface}: ${ratio.toFixed(3)}:1 < 4.5:1`);
          // Status callouts retain a soft same-token fill. Measure the paint,
          // not the bare token: semantic foreground over 5% and 10% status tint.
          for (const opacity of [0.05, 0.1]) {
            const tinted = composite(foreground, backdrop, opacity);
            const tintedRatio = contrastRatio(foreground, tinted);
            assert.ok(
              tintedRatio >= 4.5,
              `${mode} ${status} on ${surface} + ${status}/${opacity * 100}: ${tintedRatio.toFixed(3)}:1 < 4.5:1`
            );
          }
        }
        const filledRatio = contrastRatio(color(tokens, `${status}-foreground`), foreground);
        assert.ok(
          filledRatio >= 4.5,
          `${mode} ${status}-foreground on ${status}: ${filledRatio.toFixed(3)}:1 < 4.5:1`
        );
      });
    }
  });
}
