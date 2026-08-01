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
 * script AND runs vitest. The two native addon packages ship a `test:coverage`
 * that aliases to `node --test` — Node's own runner, no vitest config, no
 * provider to declare — and are excluded by that rule rather than by a
 * hand-maintained ignore list that could rot.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COVERAGE_PROVIDER = '@vitest/coverage-v8';

/**
 * Workspace globs come from pnpm-workspace.yaml so this sweep cannot drift from
 * the real member list — a depth-1 scan silently skipped `packages/config/*`
 * (review #2170).
 */
function workspaceGlobDirs() {
  const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [];
  for (const line of yaml.split('\n')) {
    if (/^\S/u.test(line) && globs.length > 0) {
      break;
    }
    const match = /^\s*-\s*(?<glob>[\w./*-]+)\s*$/u.exec(line);
    if (match?.groups?.glob?.endsWith('/*')) {
      globs.push(match.groups.glob.slice(0, -2));
    }
  }
  assert.ok(globs.length >= 3, `expected the workspace globs, parsed [${globs.join(', ')}]`);
  return globs;
}

/**
 * A package "runs vitest" if it has a dedicated vitest config OR inlines a
 * `test:` block in its vite config (the standard Vite-app arrangement, which a
 * config-filename-only check would misclassify as non-vitest).
 */
function runsVitest(packageDir) {
  const extensions = ['mts', 'ts', 'mjs', 'js'];
  if (extensions.some((ext) => existsSync(path.join(packageDir, `vitest.config.${ext}`)))) {
    return true;
  }
  return extensions.some((ext) => {
    const viteConfig = path.join(packageDir, `vite.config.${ext}`);
    return existsSync(viteConfig) && /\btest\s*:/u.test(readFileSync(viteConfig, 'utf8'));
  });
}

function workspacePackages() {
  const found = [];
  for (const group of workspaceGlobDirs()) {
    const base = path.join(repoRoot, group);
    if (!existsSync(base)) {
      continue;
    }
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

function findUncoveredVitestPackages(packages) {
  return packages
    .filter(
      ({ dir, manifest }) =>
        manifest.scripts?.test && runsVitest(dir) && !manifest.scripts['test:coverage']
    )
    .map(({ name }) => name);
}

test('every package collecting vitest coverage declares the coverage provider', () => {
  const undeclared = [];
  let checked = 0;
  for (const { dir, manifest, name } of workspacePackages()) {
    if (!(manifest.scripts?.['test:coverage'] && runsVitest(dir))) {
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

test('every package running vitest actually ships a coverage script', () => {
  // The converse direction: a package with tests but no `test:coverage` is
  // skipped by coverage.yml's `--if-present` and has no task for
  // nightly-coverage.yml, so its tests are measured NOWHERE. The sweep above
  // can never see it — it gates on the very script that is missing.
  const uncovered = findUncoveredVitestPackages(workspacePackages());
  assert.deepEqual(
    uncovered,
    [],
    `these packages run vitest but ship no test:coverage, so nothing measures them: ${uncovered.join(', ')}`
  );
});

test('money test: a vitest package without test:coverage is reported', () => {
  const dir = path.join(repoRoot, 'packages/assistant-service');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const { ['test:coverage']: _coverageScript, ...scriptsWithoutCoverage } = manifest.scripts;
  const uncovered = findUncoveredVitestPackages([
    {
      dir,
      manifest: { ...manifest, scripts: scriptsWithoutCoverage },
      name: 'packages/assistant-service',
    },
  ]);
  assert.deepEqual(uncovered, ['packages/assistant-service']);
});

test('the coverage provider is pinned through the workspace catalog', () => {
  // A hardcoded version here would drift from every other @vitest/* entry, and
  // a mismatched provider/vitest pair fails at runtime rather than at install.
  for (const { dir, manifest, name } of workspacePackages()) {
    const declared = manifest.devDependencies?.[COVERAGE_PROVIDER];
    if (!(declared && runsVitest(dir))) {
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
    // Asserted, not skipped: a rename would otherwise make this test silently
    // vacuous, and the discriminator's justification needs revisiting either
    // way (review #2170).
    assert.ok(existsSync(dir), `packages/${name} moved or was removed; revisit BST-1017`);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(manifest.scripts?.['test:coverage'], `${name} lost its test:coverage script`);
    assert.equal(runsVitest(dir), false, `${name} now runs vitest; revisit BST-1017`);
    assert.equal(
      manifest.devDependencies?.[COVERAGE_PROVIDER],
      undefined,
      `${name} declares ${COVERAGE_PROVIDER} but never runs vitest`
    );
  }
});
