import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * BST-1006 (R09): the `*.integration.test.*` cache-soundness partition.
 *
 * turbo.jsonc states the contract: the `test` task caches with `outputs: []`,
 * so a cache HIT replays a previously-logged green WITHOUT executing anything.
 * That is only sound when a lane's pass/fail is a pure function of the inputs
 * turbo hashes. Env-sensitive lanes — real PGlite/WASM, native addons,
 * wall-clock timing — can pass or fail on UN-hashed inputs, so they must never
 * be replayed.
 *
 * A package holding env-sensitive files is compliant in exactly one of two
 * ways, and this test accepts both because both genuinely hold the invariant:
 *
 *   A. its `test` script EXCLUDES the suffix, so the cacheable task never runs
 *      those files (app-shell, embeddings, agent);
 *   B. it declares `cache: false` for `test` in its own turbo.json, so nothing
 *      replays at all (db, whose unit project deliberately includes them).
 *
 * Without this guard the violation is invisible: the tests still RUN and still
 * pass locally and on a cold CI cache. The failure only appears later, as a
 * green that executed nothing.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Both suffix spellings in the repo (`agent` uses `.spec`). */
const ENV_SENSITIVE_SUFFIX = /\.integration\.(test|spec)\./u;

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

function walk(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found);
    } else if (ENV_SENSITIVE_SUFFIX.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
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
      const dir = path.join(base, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      found.push({ dir, manifest, name: `${group}/${entry.name}` });
    }
  }
  return found;
}

/** Does the package carve its `test` task out of the turbo cache? */
function declaresUncachedTest(packageDir) {
  const turboConfig = path.join(packageDir, 'turbo.json');
  if (!existsSync(turboConfig)) {
    return false;
  }
  const parsed = JSON.parse(readFileSync(turboConfig, 'utf8').replace(/^\s*\/\/.*$/gmu, ''));
  return parsed.tasks?.test?.cache === false;
}

/** Does the `test` script exclude the env-sensitive suffix? */
function testScriptExcludesSuffix(manifest) {
  const script = manifest.scripts?.test ?? '';
  return /--exclude\s+["']?\*\*\/\*\.integration\.(test|spec)\.\*/u.test(script);
}

function packagesHoldingEnvSensitiveFiles() {
  return workspacePackages()
    .map((pkg) => ({ ...pkg, files: walk(pkg.dir) }))
    .filter((pkg) => pkg.files.length > 0);
}

test('every package with env-sensitive tests keeps them out of the cacheable lane', () => {
  const violations = [];
  const holders = packagesHoldingEnvSensitiveFiles();
  for (const pkg of holders) {
    if (!pkg.manifest.scripts?.test) {
      continue; // no cacheable `test` task to be unsound about
    }
    if (testScriptExcludesSuffix(pkg.manifest) || declaresUncachedTest(pkg.dir)) {
      continue;
    }
    violations.push(
      `${pkg.name} (${pkg.files.length} file(s), e.g. ${path.relative(pkg.dir, pkg.files[0])})`
    );
  }
  assert.deepEqual(
    violations,
    [],
    'these packages run env-sensitive tests inside the CACHEABLE test task, so a cache hit ' +
      `replays a green that executed nothing:\n  ${violations.join('\n  ')}`
  );
  // Anti-vacuity: a walker that stopped finding files would pass forever.
  assert.ok(
    holders.length >= 5,
    `expected several packages to hold env-sensitive tests, found ${holders.length}`
  );
});

test('a package excluding the suffix also ships the uncached sibling lane', () => {
  // Excluding without a `test:integration` script does not make the tests
  // sound — it makes them UNRUN. The root `test:integration` turbo task
  // (cache: false) is where they belong.
  const orphaned = [];
  for (const pkg of packagesHoldingEnvSensitiveFiles()) {
    if (!testScriptExcludesSuffix(pkg.manifest)) {
      continue;
    }
    if (!pkg.manifest.scripts?.['test:integration']) {
      orphaned.push(pkg.name);
    }
  }
  assert.deepEqual(
    orphaned,
    [],
    'these packages exclude env-sensitive tests from `test` but ship no `test:integration`, ' +
      `so those files run NOWHERE: ${orphaned.join(', ')}`
  );
});

test('the cache-soundness contract is still documented where this test points', () => {
  // If turbo.jsonc's `test:integration` rationale is ever removed, this guard
  // is enforcing a rule nobody has written down any more.
  const turboConfig = readFileSync(path.join(repoRoot, 'turbo.jsonc'), 'utf8');
  assert.match(
    turboConfig,
    /THE UNCACHED SIBLING OF `test`/u,
    'turbo.jsonc no longer documents the uncached integration lane'
  );
});
