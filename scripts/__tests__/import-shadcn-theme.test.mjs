import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertPresetCode,
  assertThemeId,
  extractBlock,
  renderThemeCss,
} from '../import-shadcn-theme.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const applied = readFileSync(path.join(here, 'fixtures', 'shadcn-apply-buKEvLs.css'), 'utf8');

const DECODED_EMBER = {
  baseColor: 'neutral',
  chartColor: 'neutral',
  font: 'inter',
  fontHeading: 'inherit',
  iconLibrary: 'lucide',
  menuAccent: 'subtle',
  menuColor: 'default',
  radius: 'large',
  style: 'lyra',
  theme: 'red',
};

test('extractBlock reads the :root and .dark token maps', () => {
  const light = extractBlock(applied, ':root');
  const dark = extractBlock(applied, '.dark');
  assert.equal(light.get('primary'), 'oklch(0.505 0.213 27.518)');
  assert.equal(light.get('radius'), '0.875rem');
  assert.equal(dark.get('primary'), 'oklch(0.444 0.177 26.899)');
  assert.equal(dark.has('radius'), false);
});

test('renderThemeCss emits scoped selectors, renamed tokens and derived tokens', () => {
  const css = renderThemeCss({
    code: 'buKEvLs',
    dark: extractBlock(applied, '.dark'),
    decoded: DECODED_EMBER,
    id: 'ember',
    light: extractBlock(applied, ':root'),
  });
  assert.match(css, /^\/\*[\s\S]*preset buKEvLs[\s\S]*style\s+lyra/u);
  assert.match(css, /\n:root\[data-theme="ember"\] \{\n/u);
  assert.match(css, /\n:root\[data-theme="ember"\]\.dark \{\n/u);
  assert.match(css, /--bs-primary: oklch\(0\.505 0\.213 27\.518\);/u);
  assert.match(css, /--bs-radius: 0\.875rem;/u);
  assert.match(css, /--bs-destructive-foreground: oklch\(0\.985 0 0\);/u);
  assert.match(
    css,
    /--bs-panel-divider: oklch\(from var\(--bs-background\) calc\(l - 0\.12\) c h\);/u
  );
  assert.match(
    css,
    /--bs-panel-divider: oklch\(from var\(--bs-background\) calc\(l \+ 0\.14\) c h\);/u
  );
  assert.match(
    css,
    /--bs-panel-surface: linear-gradient\(to bottom, var\(--bs-background\), var\(--bs-muted\)\);/u
  );
  assert.doesNotMatch(css, /--bs-success|--bs-warning|--bs-info|--bs-font-/u);
});

test('the checked-in ember.css is exactly what the generator produces (regenerate is a no-op)', () => {
  const expected = renderThemeCss({
    code: 'buKEvLs',
    dark: extractBlock(applied, '.dark'),
    decoded: DECODED_EMBER,
    id: 'ember',
    light: extractBlock(applied, ':root'),
  });
  const actual = readFileSync(path.join(repoRoot, 'packages/ui/src/themes/ember.css'), 'utf8');
  assert.equal(actual, expected);
});

test('assertThemeId rejects anything but a lowercase slug', () => {
  assertThemeId('ember');
  assert.throws(() => assertThemeId('Ember'), /theme id/u);
  assert.throws(() => assertThemeId('brainstrike'), /reserved/u);
});

const DECODED_BOLD = { ...DECODED_EMBER, menuAccent: 'bold' };

/** The smallest block renderThemeCss accepts, so each test varies one thing. */
function block(overrides) {
  return new Map([
    ['background', 'oklch(1 0 0)'],
    ['foreground', 'oklch(0.1 0 0)'],
    ['primary', 'oklch(0.5 0.2 30)'],
    ['muted', 'oklch(0.96 0 0)'],
    ['accent', 'oklch(0.96 0 0)'],
    ['accent-foreground', 'oklch(0.1 0 0)'],
    ...Object.entries(overrides ?? {}),
  ]);
}

test('a block whose accent equals its primary is normalized to the subtle tint', () => {
  const bold = block({ accent: 'oklch(0.5 0.2 30)', 'accent-foreground': 'oklch(0.99 0 0)' });
  const css = renderThemeCss({
    code: 'abc123',
    dark: bold,
    decoded: DECODED_BOLD,
    id: 'bold',
    light: bold,
  });
  assert.match(css, /accentNormalized: true/u);
  assert.equal([...css.matchAll(/--bs-accent: var\(--bs-muted\);/gu)].length, 2);
  assert.equal([...css.matchAll(/--bs-accent-foreground: var\(--bs-foreground\);/gu)].length, 2);
  assert.doesNotMatch(css, /--bs-accent: oklch\(0\.5 0\.2 30\);/u);
});

test('a block whose accent differs from its primary is left untouched', () => {
  const subtle = block();
  const css = renderThemeCss({
    code: 'abc123',
    dark: subtle,
    decoded: DECODED_EMBER,
    id: 'subtle',
    light: subtle,
  });
  assert.doesNotMatch(css, /accentNormalized/u);
  assert.match(css, /--bs-accent: oklch\(0\.96 0 0\);/u);
  assert.match(css, /--bs-accent-foreground: oklch\(0\.1 0 0\);/u);
  assert.doesNotMatch(css, /--bs-accent: var\(--bs-muted\);/u);
});

test('the checked-in ember.css keeps its preset accent (menuAccent is subtle)', () => {
  const ember = readFileSync(path.join(repoRoot, 'packages/ui/src/themes/ember.css'), 'utf8');
  assert.doesNotMatch(ember, /--bs-accent: var\(--bs-muted\);/u);
});

test('the checked-in tide.css carries the normalized accent (menuAccent is bold)', () => {
  const tide = readFileSync(path.join(repoRoot, 'packages/ui/src/themes/tide.css'), 'utf8');
  assert.match(tide, /accentNormalized: true/u);
  assert.equal([...tide.matchAll(/--bs-accent: var\(--bs-muted\);/gu)].length, 2);
  assert.equal([...tide.matchAll(/--bs-accent-foreground: var\(--bs-foreground\);/gu)].length, 2);
});

test('renderThemeCss refuses preset tokens Brainstrike does not adopt', () => {
  const withExtras = block({ 'font-sans': 'Inter', 'shadow-md': '0 1px 2px #000', spacing: '4px' });
  assert.throws(
    () =>
      renderThemeCss({
        code: 'abc123',
        dark: block(),
        decoded: DECODED_EMBER,
        id: 'extras',
        light: withExtras,
      }),
    (error) => {
      assert.match(error.message, /does not adopt/u);
      assert.match(error.message, /font-sans/u);
      assert.match(error.message, /shadow-md/u);
      assert.match(error.message, /spacing/u);
      return true;
    }
  );
});

test('renderThemeCss checks the dark block against the allowlist too', () => {
  assert.throws(
    () =>
      renderThemeCss({
        code: 'abc123',
        dark: block({ 'font-mono': 'Menlo' }),
        decoded: DECODED_EMBER,
        id: 'extras',
        light: block(),
      }),
    /"\.dark"[\s\S]*font-mono/u
  );
});

test('assertPresetCode rejects anything but an alphanumeric code', () => {
  assertPresetCode('bNRM0gzE1');
  assert.throws(() => assertPresetCode('a; rm -rf /'), /alphanumeric/u);
  assert.throws(() => assertPresetCode('a-b'), /alphanumeric/u);
  assert.throws(() => assertPresetCode('$(whoami)'), /alphanumeric/u);
  assert.throws(() => assertPresetCode(''), /alphanumeric/u);
});

test('renderThemeCss pins the shadcn version in the regenerate hint', () => {
  const css = renderThemeCss({
    code: 'abc123',
    dark: block(),
    decoded: DECODED_EMBER,
    id: 'pinned',
    light: block(),
  });
  assert.match(css, /pins npx -y shadcn@4\.21\.0/u);
  assert.doesNotMatch(css, /shadcn@latest/u);
});
