import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// BST-1734: the Tailwind v3 preset is deleted and must not drift back in.
// Lives here (not in packages/config's lane) so Turborepo input scoping can't
// satisfy it from cache when an app or stylesheet re-adds the surface:
// `node --test scripts/__tests__/*.test.mjs` always walks the live tree.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKIP_DIRS = new Set(['.git', '.pnpm-store', '.turbo', 'dist', 'node_modules']);

function collectFiles(extension) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(directory, entry.name));
        }
        continue;
      }
      if (entry.name.endsWith(extension)) {
        found.push(path.join(directory, entry.name));
      }
    }
  };
  walk(repoRoot);
  return found.sort();
}

test('no tailwind v3 preset or app configs exist', () => {
  for (const relative of [
    'packages/config/tailwind/tailwind.config.js',
    'apps/web/tailwind.config.js',
    'apps/desktop/tailwind.config.js',
  ]) {
    assert.ok(!fileExists(relative), `expected deleted: ${relative}`);
  }
  const fourth = collectFiles('tailwind.config.js').concat(collectFiles('tailwind.config.ts'));
  assert.deepEqual(
    fourth.map((file) => path.relative(repoRoot, file)),
    []
  );
});

test('no package surface references the deleted preset', () => {
  const configPackage = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages/config/package.json'), 'utf8')
  );
  assert.ok(!('./tailwind' in (configPackage.exports ?? {})), 'expected no ./tailwind export');
  assert.ok(
    !(configPackage.files ?? []).includes('tailwind'),
    'expected no tailwind entry in files'
  );
});

test('no stylesheet loads a tailwind.config via @config', () => {
  const offenders = collectFiles('.css').filter((file) => {
    const source = readFileSync(file, 'utf8');
    return /@config\s+["'][^"']*tailwind\.config/u.test(source);
  });
  assert.deepEqual(
    offenders.map((file) => path.relative(repoRoot, file)),
    []
  );
});

test('nothing imports the deleted preset subpath', () => {
  const self = path.relative(repoRoot, fileURLToPath(import.meta.url));
  const offenders = [];
  for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.css']) {
    for (const file of collectFiles(extension)) {
      if (path.relative(repoRoot, file) === self) {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      if (
        source.includes('@brainstrike/config/tailwind') ||
        /(?:from|require\()\s*["'][^"']*config\/tailwind["']/u.test(source)
      ) {
        offenders.push(path.relative(repoRoot, file));
      }
    }
  }
  assert.deepEqual(offenders, []);
});

function fileExists(relative) {
  return existsSync(path.join(repoRoot, relative));
}
