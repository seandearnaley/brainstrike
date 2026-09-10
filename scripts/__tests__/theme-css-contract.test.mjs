import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { globSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');

const APP_STYLESHEETS = ['apps/web/src/app/globals.css', 'apps/desktop/src/renderer/styles.css'];

test('apps import the shared theme mapping exactly once and own no mapping of their own', () => {
  for (const file of APP_STYLESHEETS) {
    const source = read(file);
    const imports = source.match(/@import "@brainstrike\/ui\/theme\.css";/gu) ?? [];
    assert.equal(imports.length, 1, `${file} must import @brainstrike/ui/theme.css exactly once`);
    assert.doesNotMatch(source, /@theme\b/u, `${file} must not declare @theme; theme.css owns it`);
    assert.doesNotMatch(
      source,
      /@custom-variant dark/u,
      `${file} must not redeclare the dark variant`
    );
  }
});

test('theme.css is the only owner of the dark variant and the colour mapping', () => {
  const themeCss = read('packages/ui/src/theme.css');
  assert.equal((themeCss.match(/@custom-variant dark/gu) ?? []).length, 1);
  assert.match(themeCss, /@theme inline \{[\s\S]*--color-background: var\(--background\);/u);
});

test('no other package stylesheet declares @theme or the dark variant', () => {
  // The apps are covered above; this closes the same hole across every package,
  // where a second @theme block would silently shadow half the mapping.
  const offenders = globSync('packages/**/*.css', {
    cwd: repoRoot,
    exclude: (name) => name === 'node_modules' || name === 'dist',
  })
    .filter((relative) => relative.split(path.sep).join('/') !== 'packages/ui/src/theme.css')
    .filter((relative) => /@theme\b|@custom-variant dark/u.test(read(relative)));
  assert.deepEqual(offenders, [], `theme.css must be the only owner:\n${offenders.join('\n')}`);
});

const IDIOM_SCAN_ROOTS = ['apps', 'packages'];
const IDIOM_EXCLUDES = ['packages/config/__tests__/tailwind-config.test.ts'];
const IDIOM_BUILD_DIRS = ['node_modules', 'dist', 'dist-electron', 'out', 'coverage', 'build'];

function grepScan(pattern) {
  try {
    const output = execFileSync(
      'grep',
      [
        '-rn',
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.css',
        ...IDIOM_BUILD_DIRS.map((dir) => `--exclude-dir=${dir}`),
        pattern,
        ...IDIOM_SCAN_ROOTS,
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    );
    return output
      .split('\n')
      .filter((line) => line && !IDIOM_EXCLUDES.some((prefix) => line.startsWith(prefix)));
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return [];
    }
    throw error;
  }
}

test('the idiom scan actually reaches source files (positive control)', () => {
  // A scan that reaches nothing reports zero hits and passes forever. Plant a real
  // violation under a scanned root and require the same grep to find it.
  const planted = path.join(repoRoot, 'packages/ui/src/__idiom-guard-probe.css');
  try {
    writeFileSync(planted, '.probe { color: hsl(var(--probe)); }\n');
    const hits = grepScan('hsl(var(--');
    assert.ok(
      hits.some((line) => line.includes('__idiom-guard-probe.css')),
      `the scan did not reach packages/ui/src; it is not proving anything:\n${hits.join('\n')}`
    );
  } finally {
    rmSync(planted, { force: true });
  }
});

test('no source uses the legacy hsl(var(--x)) idiom', () => {
  const hits = grepScan('hsl(var(--');
  assert.deepEqual(hits, [], `legacy idiom found:\n${hits.join('\n')}`);
});

test('globals.css imports the theme files first and the high-contrast override outranks every theme', () => {
  const globals = read('packages/ui/src/globals.css');
  assert.match(
    globals,
    /^@import "\.\/themes\/index\.css";/u,
    'themes/index.css must be the first statement'
  );
  const highContrast = globals.split('@media (prefers-contrast: more)')[1];
  assert.ok(highContrast, 'high-contrast block present');
  assert.match(
    highContrast,
    /:root\[data-theme\] \{/u,
    'light high-contrast selector must be :root[data-theme]'
  );
  assert.match(
    highContrast,
    /:root\[data-theme\]\.dark \{/u,
    'dark high-contrast selector must be :root[data-theme].dark'
  );
  assert.doesNotMatch(
    highContrast,
    /^\s*:root \{|^\s*\.dark \{/mu,
    'bare :root/.dark would lose to themed selectors'
  );
});
