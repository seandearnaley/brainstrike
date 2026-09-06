/**
 * The `packages/agent` test-typecheck RATCHET (BST-1609).
 *
 * `packages/agent` excluded its own tests from typecheck and had no
 * `tsconfig.test.json`, so nothing ever typechecked its ~195 spec files. A test
 * whose value was type-level could not fail. The gate is now on, default-safe:
 * the test project includes everything and names the legacy files that still
 * fail as explicit exclusions.
 *
 * That design rests on one claim — THE EXCLUSION LIST ONLY SHRINKS. Without
 * this file that claim is a social convention, and `tsconfig.test.json` is an
 * ordinary file whose path of least resistance, for anyone whose new spec fails
 * the gate, is to add one more line. Same reasoning and shape as
 * `db-test-discovery-contract.test.mjs`.
 *
 * WHEN YOU DRAIN A FILE: remove it from `exclude` and lower the ceiling here.
 * The ceiling may never go up.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentRoot = path.join(repoRoot, 'packages/agent');
const testConfigPath = path.join(agentRoot, 'tsconfig.test.json');

/**
 * Ratchet ceiling: the number of LEGACY SOURCE FILES still excluded from the
 * test project. Lower it as files are drained; never raise it.
 */
const MAX_EXCLUDED_LEGACY_FILES = 68;

/** Not legacy debt — the ordinary build-output exclusions every project carries. */
const NON_LEGACY_EXCLUDES = new Set(['dist', 'node_modules']);

function readTestConfig() {
  return JSON.parse(readFileSync(testConfigPath, 'utf8'));
}

test('packages/agent has a test project at all', () => {
  assert.ok(
    existsSync(testConfigPath),
    'packages/agent/tsconfig.test.json is missing — its tests would stop being typechecked entirely'
  );

  const pkg = JSON.parse(readFileSync(path.join(agentRoot, 'package.json'), 'utf8'));
  assert.match(
    pkg.scripts['type-check'],
    /--project tsconfig\.test\.json/u,
    'the type-check script must run the test project, or tsconfig.test.json is dead weight'
  );
});

test('the legacy exclusion list only shrinks', () => {
  const legacy = readTestConfig().exclude.filter((entry) => !NON_LEGACY_EXCLUDES.has(entry));

  assert.ok(
    legacy.length <= MAX_EXCLUDED_LEGACY_FILES,
    `packages/agent/tsconfig.test.json excludes ${legacy.length} legacy files, above the ratchet ceiling of ${MAX_EXCLUDED_LEGACY_FILES}. ` +
      'Fix the type errors in your file instead of adding it to the list. If you drained files, LOWER the ceiling in this test.'
  );
});

test('every excluded path still exists', () => {
  // A stale entry is worse than noise: it silently stops excluding anything,
  // so the ceiling above stops measuring real debt and a rename can quietly
  // drop a file out of the accounting.
  const legacy = readTestConfig().exclude.filter((entry) => !NON_LEGACY_EXCLUDES.has(entry));
  const missing = legacy.filter((entry) => !existsSync(path.join(agentRoot, entry)));

  assert.deepEqual(
    missing,
    [],
    'these excluded paths no longer exist; delete them from tsconfig.test.json and lower the ceiling'
  );
});

test('the exclusion list holds only spec files', () => {
  // Shared fixtures must NOT be excluded. `exclude` only filters root-file
  // discovery, so a fixture imported by a covered spec is typechecked anyway —
  // listing it is a no-op that reads as real debt, and it becomes a genuine
  // coverage hole the moment the last covered importer goes away. This is why
  // `fixtures/mastra-stream-harness.ts` was fixed rather than excluded.
  const legacy = readTestConfig().exclude.filter((entry) => !NON_LEGACY_EXCLUDES.has(entry));
  const nonSpec = legacy.filter((entry) => !/\.(spec|test)\.(ts|tsx)$/u.test(entry));

  assert.deepEqual(
    nonSpec,
    [],
    'only spec files belong in the exclusion list; fix shared fixtures rather than excluding them'
  );
});
