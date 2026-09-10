import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const IDIOM_SCAN_ROOTS = ['apps', 'packages'];
const IDIOM_EXCLUDES = [
  'packages/config/tailwind/',
  'packages/config/__tests__/tailwind-config.test.ts',
];

function grepIdiom() {
  try {
    const output = execFileSync(
      'grep',
      [
        '-rn',
        '--include=*.ts',
        '--include=*.tsx',
        '--include=*.css',
        '--exclude-dir=node_modules',
        '--exclude-dir=dist',
        'hsl(var(--',
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

test('no source uses the legacy hsl(var(--x)) idiom', () => {
  const hits = grepIdiom();
  assert.deepEqual(hits, [], `legacy idiom found:\n${hits.join('\n')}`);
});
