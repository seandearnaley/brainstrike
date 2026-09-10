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

    // Tailwind resolves utilities against the @theme it has already seen. If a
    // local @layer block is parsed before the shared mapping is imported, the
    // build fails with `Cannot apply unknown utility class`, so the import must
    // come first.
    const importIndex = source.indexOf('@import "@brainstrike/ui/theme.css"');
    const layerIndex = source.indexOf('@layer');
    assert.notEqual(importIndex, -1, `${file} must import @brainstrike/ui/theme.css`);
    if (layerIndex !== -1) {
      assert.ok(
        importIndex < layerIndex,
        `${file} must import @brainstrike/ui/theme.css before its first @layer block, ` +
          'otherwise Tailwind fails with `Cannot apply unknown utility class`'
      );
    }
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
// Extended-regex form so `hsla(var(` and `hsl( var(` are caught alongside the
// canonical `hsl(var(`. `grepScan` runs grep with `-E`.
const LEGACY_IDIOM_PATTERN = String.raw`hsla?\(\s*var\(`;
const IDIOM_BUILD_DIRS = ['node_modules', 'dist', 'dist-electron', 'out', 'coverage', 'build'];

function grepScan(pattern) {
  try {
    const output = execFileSync(
      'grep',
      [
        '-rnE',
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
    writeFileSync(planted, '.probe { color: hsla( var(--probe) / 50%); }\n');
    const hits = grepScan(LEGACY_IDIOM_PATTERN);
    assert.ok(
      hits.some((line) => line.includes('__idiom-guard-probe.css')),
      `the scan did not reach packages/ui/src; it is not proving anything:\n${hits.join('\n')}`
    );
  } finally {
    rmSync(planted, { force: true });
  }
});

test('no source uses the legacy hsl(var(--x)) idiom (including hsla and inner spacing)', () => {
  const hits = grepScan(LEGACY_IDIOM_PATTERN);
  assert.deepEqual(hits, [], `legacy idiom found:\n${hits.join('\n')}`);
});

/** Slice an at-rule's body out by brace balance (its `{` ... matching `}`). */
function mediaBlockBody(css, atRule) {
  const start = css.indexOf(atRule);
  assert.notEqual(start, -1, `${atRule} block present`);
  const open = css.indexOf('{', start);
  assert.notEqual(open, -1, `${atRule} must open a block`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') {
      depth += 1;
    } else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, i);
      }
    }
  }
  throw new Error(`${atRule} block is unbalanced`);
}

/** Every selector group inside a block body, whitespace-normalized, in order. */
function selectorGroups(body) {
  const groups = [];
  let cursor = 0;
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '{') {
      if (depth === 0) {
        groups.push(body.slice(cursor, i).replace(/\s+/gu, ' ').trim());
      }
      depth += 1;
    } else if (body[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        cursor = i + 1;
      }
    }
  }
  return groups;
}

test('globals.css imports the theme files first and the high-contrast override outranks every theme', () => {
  const globals = read('packages/ui/src/globals.css');
  assert.match(
    globals,
    /^@import "\.\/themes\/index\.css";/u,
    'themes/index.css must be the first statement'
  );
  const highContrast = mediaBlockBody(globals, '@media (prefers-contrast: more)');
  // Exactly two rule groups, and exactly these selectors. The themed halves are
  // 0,2,0 / 0,3,0 so they tie generated `:root[data-theme="<id>"]` themes and win
  // on order; the `:not([data-theme])` halves carry the same specificity and keep
  // high contrast working with or without the attribute — before the provider
  // mounts, and on any host that never writes it.
  assert.deepEqual(selectorGroups(highContrast), [
    ':root[data-theme], :root:not([data-theme])',
    ':root[data-theme].dark, :root:not([data-theme]).dark',
  ]);
  assert.doesNotMatch(
    highContrast,
    /^\s*:root \{|^\s*\.dark \{/mu,
    'bare :root/.dark would lose to themed selectors'
  );
});
