import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * BST-1017 (R01): a package that collects vitest coverage must DECLARE
 * `@vitest/coverage-v8`, not resolve it through root hoisting.
 *
 * `turbo boundaries` cannot see this class of dependency at all: the provider
 * is selected by a CLI FLAG (`--coverage`), so there is no import site to
 * analyze. The analyzer reports these packages as clean while they remain
 * unable to run their own `test:coverage` standalone — and pnpm's strict
 * node_modules (no hoist override in .npmrc) means the day hoisting stops
 * providing it, `coverage.yml` and `nightly-coverage.yml` break.
 *
 * Discriminator: a package needs the provider iff it ships a `test:coverage`
 * script AND has a vitest config. The two native addon packages ship a
 * `test:coverage` that aliases to `node --test` — Node's own runner, no vitest
 * config, no provider to declare — and are correctly excluded by that rule
 * rather than by a hand-maintained ignore list that could rot.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COVERAGE_PROVIDER = '@vitest/coverage-v8';

function hasVitestConfig(packageDir) {
  return ['mts', 'ts', 'mjs', 'js'].some((extension) =>
    existsSync(path.join(packageDir, `vitest.config.${extension}`))
  );
}

function workspacePackages() {
  const found = [];
  for (const group of ['packages', 'apps']) {
    const base = path.join(repoRoot, group);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDir = path.join(base, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      found.push({ dir: packageDir, manifest, name: `${group}/${entry.name}` });
    }
  }
  return found;
}

test('every package collecting vitest coverage declares the coverage provider', () => {
  const undeclared = [];
  let checked = 0;
  for (const { dir, manifest, name } of workspacePackages()) {
    if (!(manifest.scripts?.['test:coverage'] && hasVitestConfig(dir))) {
      continue;
    }
    checked += 1;
    const declared =
      manifest.devDependencies?.[COVERAGE_PROVIDER] ?? manifest.dependencies?.[COVERAGE_PROVIDER];
    if (!declared) {
      undeclared.push(name);
    }
  }
  assert.deepEqual(
    undeclared,
    [],
    `these packages run vitest coverage without declaring ${COVERAGE_PROVIDER}: ${undeclared.join(', ')}`
  );
  // Anti-vacuity: if the discriminator ever stops matching anything, this test
  // would pass while checking nothing at all (the BST-836 class).
  assert.ok(checked > 30, `expected the sweep to cover the workspace, only checked ${checked}`);
});

test('the coverage provider is pinned through the workspace catalog', () => {
  // A hardcoded version here would drift from every other @vitest/* entry, and
  // a mismatched provider/vitest pair fails at runtime rather than at install.
  for (const { dir, manifest, name } of workspacePackages()) {
    const declared = manifest.devDependencies?.[COVERAGE_PROVIDER];
    if (!(declared && hasVitestConfig(dir))) {
      continue;
    }
    assert.equal(
      declared,
      'catalog:',
      `${name} pins ${COVERAGE_PROVIDER} as ${declared}; use the workspace catalog`
    );
  }
});

test('a package aliasing test:coverage to node --test needs no vitest provider', () => {
  // Pins the discriminator itself: these two exist precisely to prove the rule
  // excludes non-vitest coverage scripts for a REASON, not by omission.
  for (const name of ['secure-fs-native', 'windows-job-native']) {
    const dir = path.join(repoRoot, 'packages', name);
    if (!existsSync(dir)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(manifest.scripts?.['test:coverage'], `${name} lost its test:coverage script`);
    assert.equal(hasVitestConfig(dir), false, `${name} gained a vitest config; revisit BST-1017`);
    assert.equal(
      manifest.devDependencies?.[COVERAGE_PROVIDER],
      undefined,
      `${name} declares ${COVERAGE_PROVIDER} but never runs vitest`
    );
  }
});
