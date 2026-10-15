// Structural contract for the PER-RULE eslint warning ratchet (#2372).
//
// The behavioural control tests (over-baseline / under-baseline / missing-entry
// / error-severity all exit 1) each need a full ~40s eslint run, so they are not
// run here. This file guards the cheap structural invariants that would silently
// defeat the ratchet:
//
//   - `lint:eslint` must actually invoke the verifier. Reverting it to a bare
//     `eslint --max-warnings=N` restores the single-scalar design whose failure
//     mode (cross-family headroom trading) is the reason this exists.
//   - The verifier's TARGETS must match eslint.config.js's `files` globs. If the
//     config lints a package the verifier does not pass to lintFiles, that
//     package's warnings vanish from the baseline and regressions there are
//     invisible — a false green, not a loud failure.
//   - The baseline file must be well-formed, so a hand-edit cannot smuggle in a
//     negative or non-integer budget.
//   - The verifier's ESLint result cache must start over when dependencies or
//     eslint.config.js change, or a plugin upgrade is judged on stale results.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { eslintCacheFile, parseCliArgs } from '../verify-eslint-warning-baselines.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative) => readFileSync(path.join(repoRoot, relative), 'utf8');
const FULL_TREE_ESLINT_INVOCATION = /\bpnpm run lint:eslint(?=\s*(?:&&|$))/u;

test('lint:eslint invokes the per-rule verifier, not a bare --max-warnings', () => {
  const { scripts } = JSON.parse(read('package.json'));
  assert.match(
    scripts['lint:ci'],
    FULL_TREE_ESLINT_INVOCATION,
    'the required Static lint command must retain the full-repository ESLint verdict'
  );
  for (const narrowedInvocation of [
    'pnpm run lint:eslint:bounded',
    'pnpm run lint:eslint.bounded',
    'pnpm run lint:eslint --repo-root fixture',
  ]) {
    assert.doesNotMatch(
      narrowedInvocation,
      FULL_TREE_ESLINT_INVOCATION,
      'the owner-chain assertion must reject a renamed or argument-narrowed script'
    );
  }
  assert.equal(
    scripts['lint:eslint'],
    'node scripts/verify-eslint-warning-baselines.mjs',
    'lint:eslint must run the per-rule verifier; a bare `eslint --max-warnings=N` ' +
      'lets independent rule families trade headroom invisibly'
  );
  assert.doesNotMatch(
    scripts['lint:eslint'],
    /--max-warnings/,
    'the scalar ceiling is superseded by eslint-warning-baseline.json'
  );
});

test('verifier CLI rejects ambiguous or unsupported control arguments', () => {
  assert.deepEqual(parseCliArgs(['--repo-root', 'fixture', '--write-baseline']), {
    repoRoot: path.resolve('fixture'),
    writeBaseline: true,
  });
  assert.throws(() => parseCliArgs(['--unknown']), /unsupported argument --unknown/u);
  assert.throws(() => parseCliArgs(['--repo-root']), /--repo-root requires a path/u);
  assert.throws(
    () => parseCliArgs(['--repo-root', 'one', '--repo-root', 'two']),
    /duplicate --repo-root/u
  );
  assert.throws(
    () => parseCliArgs(['--write-baseline', '--write-baseline']),
    /duplicate --write-baseline/u
  );
});

// ESLint's own cache key names a plugin by meta.name@meta.version, which neither
// counted plugin keeps in step with its installed version. Without these inputs
// in the cache file name, a plugin upgrade would be judged on the old plugin's
// cached results.
test('the ESLint cache file changes with the lockfile and eslint.config.js', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'eslint-cache-key-'));
  const write = (name, content) => writeFileSync(path.join(root, name), content);
  try {
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    write('eslint.config.js', 'export default [];\n');
    const initial = eslintCacheFile(root);
    assert.equal(
      path.dirname(path.relative(root, initial)),
      path.join('node_modules', '.cache', 'eslint'),
      'the cache must stay under the ignored node_modules tree, so fresh checkouts start cold'
    );
    assert.equal(eslintCacheFile(root), initial);

    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n# a plugin upgrade\n");
    const afterUpgrade = eslintCacheFile(root);
    assert.notEqual(afterUpgrade, initial, 'a dependency change must start a new cache');

    write('eslint.config.js', 'export default [{}];\n');
    assert.notEqual(eslintCacheFile(root), afterUpgrade, 'a config change must start a new cache');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('verifier TARGETS match the eslint.config.js files globs', () => {
  const targets = [
    ...read('scripts/verify-eslint-warning-baselines.mjs').matchAll(/^ {2}'([^']+)',$/gm),
  ].map((match) => match[1]);

  const globbed = [
    ...read('eslint.config.js').matchAll(/^ {6}'([^']+)\/\*\*\/\*\.\{js,jsx,ts,tsx\}',$/gm),
  ].map((match) => match[1]);

  assert.ok(targets.length > 0, 'failed to parse TARGETS from the verifier');
  assert.ok(globbed.length > 0, 'failed to parse files globs from eslint.config.js');
  assert.deepEqual(
    [...targets].sort(),
    [...globbed].sort(),
    'eslint.config.js lints a different set of directories than the verifier ' +
      'passes to lintFiles. Warnings in an unscanned directory silently drop ' +
      'out of the baseline instead of failing.'
  );
});

test('eslint-warning-baseline.json is well-formed', () => {
  const baseline = JSON.parse(read('eslint-warning-baseline.json'));
  const entries = Object.entries(baseline);

  assert.ok(entries.length > 0, 'baseline must not be empty');
  for (const [ruleId, count] of entries) {
    assert.match(
      ruleId,
      /^[a-z0-9@/-]+$/,
      `baseline key "${ruleId}" is not a plausible eslint rule id`
    );
    assert.ok(
      Number.isInteger(count) && count >= 0,
      `baseline["${ruleId}"] must be a non-negative integer, got ${count}`
    );
  }
});
