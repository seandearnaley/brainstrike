import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectForegroundViolations,
  parsePalette,
  readUtilityColors,
} from '../lib/foreground-contrast.mjs';

const paletteCss =
  '--color-amber-500: oklch(76.9% 0.188 70.08); --color-green-600: oklch(62.7% 0.194 149.214); --color-slate-900: oklch(20.8% 0.042 265.755);';
const surfaces = { background: [1, 1, 1], muted: [0.94, 0.93, 0.92] };

describe('foreground contrast evaluator', () => {
  it('resolves powerless none hues instead of silently dropping neutral palette entries', () => {
    const palette = parsePalette('--color-neutral-50: oklch(98.5% 0 none);');
    assert.equal(palette.size, 1);
    assert.ok(palette.get('neutral-50').every((channel) => channel > 0.9));
  });
  it('reads variants and opacity without mistaking tints or prose for foregrounds', () => {
    assert.deepEqual(
      readUtilityColors('hover:text-green-600/70 bg-amber-500/15 dark:text-amber-500'),
      [
        {
          color: 'green-600',
          dark: false,
          opacity: 0.7,
          utility: 'hover:text-green-600/70',
          warning: false,
        },
        {
          color: 'amber-500',
          dark: true,
          opacity: 1,
          utility: 'dark:text-amber-500',
          warning: true,
        },
      ]
    );
    assert.deepEqual(readUtilityColors('my-text-green-600 text-green-600ish text-[12px]'), []);
  });

  it('measures actual palette colors against every surface, not shade heuristics', () => {
    const palette = parsePalette(paletteCss);
    const violations = collectForegroundViolations({
      palette,
      surfaces,
      text: 'text-green-600 text-slate-900',
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].utility, 'text-green-600');
    assert.ok(violations[0].ratio < 4.5);
    assert.equal(violations[0].surface, 'muted');
  });

  it('cannot pass by ignoring foreground opacity', () => {
    const palette = parsePalette(paletteCss);
    assert.equal(
      collectForegroundViolations({ palette, surfaces, text: 'text-slate-900' }).length,
      0
    );
    assert.equal(
      collectForegroundViolations({ palette, surfaces, text: 'text-slate-900/30' }).length,
      1
    );
  });

  it('allows pale background tints but requires warning foreground tokens', () => {
    const palette = parsePalette(paletteCss);
    assert.equal(
      collectForegroundViolations({ palette, surfaces, text: 'bg-amber-500/15 text-warning' })
        .length,
      0
    );
    const violations = collectForegroundViolations({ palette, surfaces, text: 'text-amber-500' });
    assert.equal(violations[0].preferSemantic, true);
  });

  it('does not judge a dark-only utility against a light background', () => {
    assert.equal(
      collectForegroundViolations({
        palette: parsePalette(paletteCss),
        surfaces,
        text: 'dark:text-green-600',
      }).length,
      0
    );
  });

  it('still requires semantic warning foregrounds in dark variants', () => {
    const violations = collectForegroundViolations({
      palette: parsePalette(paletteCss),
      surfaces,
      text: 'dark:hover:text-amber-500',
    });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].preferSemantic, true);
    assert.equal(violations[0].ratio, null);
  });

  it('does not hide raw warning colours behind unresolved alpha modifiers', () => {
    assert.throws(
      () =>
        collectForegroundViolations({
          palette: parsePalette(paletteCss),
          surfaces,
          text: 'text-amber-500/[var(--fade)]',
        }),
      /Unsupported foreground opacity/
    );
    assert.equal(
      collectForegroundViolations({
        palette: parsePalette(paletteCss),
        surfaces,
        text: 'dark:text-amber-500/[var(--fade)]',
      })[0].preferSemantic,
      true
    );
  });

  it('cannot evade the guard with Tailwind important or arbitrary-opacity syntax', () => {
    const violations = collectForegroundViolations({
      palette: parsePalette(paletteCss),
      surfaces,
      text: '!text-green-600 hover:text-green-600! text-slate-900/[0.3]',
    });
    assert.equal(violations.length, 3);
    assert.equal(violations[2].opacity, 0.3);
  });

  it('fails closed for missing palette entries, empty surfaces and invalid opacity', () => {
    const palette = parsePalette(paletteCss);
    assert.throws(
      () => collectForegroundViolations({ palette, surfaces, text: 'text-green-700' }),
      /Missing palette/
    );
    assert.throws(
      () => collectForegroundViolations({ palette, surfaces: {}, text: 'text-green-600' }),
      /surface/
    );
    assert.throws(
      () => collectForegroundViolations({ palette, surfaces, text: 'text-green-600/150' }),
      /opacity/
    );
    assert.throws(() => parsePalette('not a theme'), /palette/);
  });
});
