import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
const APPLIED_FIXTURE = path.join(here, 'fixtures', 'shadcn-apply-buKEvLs.css');
const DECODED_FIXTURE = path.join(here, 'fixtures', 'shadcn-decode-buKEvLs.json');
const applied = readFileSync(APPLIED_FIXTURE, 'utf8');

/** The captured `shadcn preset decode buKEvLs` output; ember.css's header records the same. */
const DECODED_EMBER = JSON.parse(readFileSync(DECODED_FIXTURE, 'utf8'));

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

/**
 * Runs the REAL CLI entry in a subprocess whose PATH holds only an `npx` stub
 * that records the call and fails. The exported helpers above never touch the
 * network, which is how `--from-css` shipped advertising an offline path while
 * `main` still decoded the preset through `npx` — only the entry point can say.
 * The theme file goes to a temp `--out-dir`, never into packages/ui.
 */
function runCli(args) {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'import-shadcn-theme-'));
  const binDir = path.join(sandbox, 'bin');
  const outDir = path.join(sandbox, 'themes');
  const npxCalls = path.join(sandbox, 'npx-calls.log');
  mkdirSync(binDir);
  mkdirSync(outDir);
  const stub = path.join(binDir, 'npx');
  writeFileSync(
    stub,
    `#!/bin/sh\necho "$@" >> "${npxCalls}"\necho "npx must not run in this test" >&2\nexit 97\n`
  );
  chmodSync(stub, 0o755);
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'import-shadcn-theme.mjs'), ...args, '--out-dir', outDir],
    { encoding: 'utf8', env: { ...process.env, PATH: binDir } }
  );
  return {
    cleanup: () => rmSync(sandbox, { force: true, recursive: true }),
    npxCalls: existsSync(npxCalls) ? readFileSync(npxCalls, 'utf8') : '',
    outDir,
    result,
  };
}

test('--from-css with --decoded renders offline: no npx call, output is the committed ember.css', () => {
  const run = runCli([
    'buKEvLs',
    'ember',
    '--from-css',
    APPLIED_FIXTURE,
    '--decoded',
    DECODED_FIXTURE,
  ]);
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(run.npxCalls, '', 'the offline path must not shell out to npx');
    assert.equal(
      readFileSync(path.join(run.outDir, 'ember.css'), 'utf8'),
      readFileSync(path.join(repoRoot, 'packages/ui/src/themes/ember.css'), 'utf8')
    );
  } finally {
    run.cleanup();
  }
});

test('--from-css without --decoded fails loudly instead of decoding the preset remotely', () => {
  const run = runCli(['buKEvLs', 'ember', '--from-css', APPLIED_FIXTURE]);
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /--from-css[\s\S]*--decoded/u);
    assert.equal(run.npxCalls, '', 'a missing --decoded must not fall back to npx');
    assert.equal(existsSync(path.join(run.outDir, 'ember.css')), false);
  } finally {
    run.cleanup();
  }
});

test('--decoded refuses a capture that is not a JSON object of strings with a style', () => {
  const bad = mkdtempSync(path.join(tmpdir(), 'import-shadcn-decoded-'));
  try {
    for (const [name, body] of [
      ['not-json.json', 'style: lyra'],
      ['no-style.json', '{"font":"inter"}'],
      ['non-string.json', '{"style":"lyra","radius":4}'],
    ]) {
      const file = path.join(bad, name);
      writeFileSync(file, body);
      const run = runCli(['buKEvLs', 'ember', '--from-css', APPLIED_FIXTURE, '--decoded', file]);
      try {
        assert.notEqual(run.result.status, 0, `${name} should be refused`);
        assert.match(run.result.stderr, /--decoded/u, name);
        assert.equal(run.npxCalls, '', name);
        assert.equal(existsSync(path.join(run.outDir, 'ember.css')), false, name);
      } finally {
        run.cleanup();
      }
    }
  } finally {
    rmSync(bad, { force: true, recursive: true });
  }
});
