import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertThemeId, extractBlock, renderThemeCss } from '../import-shadcn-theme.mjs';

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
  assert.match(css, /--bs-panel-divider: oklch\(from var\(--bs-border\) calc\(l - 0\.06\) c h\);/u);
  assert.match(
    css,
    /--bs-panel-divider: oklch\(from var\(--bs-border\) calc\(l \+ 0\.06\) c h\);/u
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
