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
import { verifyTestTsconfigProgram } from '../verify-test-tsconfig-program.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentRoot = path.join(repoRoot, 'packages/agent');
const testConfigPath = path.join(agentRoot, 'tsconfig.test.json');

/**
 * Ratchet ceiling: the number of LEGACY SOURCE FILES still excluded from the
 * test project. Lower it as files are drained; never raise it.
 *
 * 68 -> 53 (ADR-0022): the Mastra agent loop's retirement deleted 15 of the
 * excluded specs outright. They were drained by DELETION rather than by fixing
 * their type errors, which is still a drain — the debt is gone either way — but
 * it is worth naming so the drop does not read as 15 files repaired.
 * BST-2095 returns four cancellation regressions to checking after BST-2068's
 * deletion of more legacy specs. The remaining cohort is counted below.
 */
const MAX_EXCLUDED_LEGACY_FILES = 4;

/** Not legacy debt — the ordinary build-output exclusions every project carries. */
const NON_LEGACY_EXCLUDES = new Set(['dist', 'node_modules']);
const REQUIRED_REGRESSIONS = [
  'src/__tests__/mcp-task-presentation.spec.ts',
  'src/__tests__/mcp-tasks-interaction.spec.ts',
  'src/__tests__/mcp-tasks-lifecycle-exits.integration.spec.ts',
  'src/__tests__/mcp-tasks-lifecycle-handle.integration.spec.ts',
  'src/__tests__/mcp-tasks-lifecycle.integration.spec.ts',

  'src/__tests__/mcp-client-capabilities.spec.ts',
  'src/__tests__/mcp-client-extension-registry.spec.ts',
  'src/__tests__/mcp-explicit-http-client-validation.spec.ts',
  'src/__tests__/mcp-oauth-config.spec.ts',
  'src/__tests__/mcp-registered-extension-dispatch.spec.ts',

  'src/__tests__/assistant-messages.spec.ts',
  'src/__tests__/data-stream-text-continuity.spec.ts',
  'src/__tests__/token-measurement.spec.ts',
  'src/__tests__/tool-projection-rewrite-processor.spec.ts',
  'src/__tests__/usage-metering.spec.ts',
  'src/__tests__/workspace-root-manifest.spec.ts',

  'src/__tests__/bedrock-prompt-caching.spec.ts',
  'src/__tests__/native-web-search.spec.ts',
  'src/__tests__/openai-tool-search-history-compat.spec.ts',
  'src/__tests__/openrouter-strict-content.spec.ts',
  'src/__tests__/provider-factory.anthropic-caching.spec.ts',
  'src/__tests__/provider-factory.auth-input.spec.ts',
  'src/__tests__/provider-factory.bedrock.spec.ts',
  'src/__tests__/runtime-configuration.spec.ts',

  'src/__tests__/mcp-tool-loader.spec.ts',
  'src/__tests__/tool-search-runtime.spec.ts',
  'src/__tests__/tool-sanitizer.spec.ts',

  'src/__tests__/data-stream-session.spec.ts',
  'src/__tests__/data-stream-stall.spec.ts',
  'src/__tests__/with-tool-call-input-timeout.spec.ts',

  'src/__tests__/code-execution.spec.ts',
  'src/__tests__/fence-spawn.spec.ts',

  'src/__tests__/mcp-host-adapter-core.spec.ts',
  'src/__tests__/mcp-result-type-compatibility.spec.ts',
  'src/__tests__/mcp-tasks-extension.spec.ts',

  'src/__tests__/native-tool-input-schema-catalog.spec.ts',
  'src/__tests__/tool-output-artifact-reader.spec.ts',
  'src/__tests__/tool-output-artifact-settlement.spec.ts',

  'src/__tests__/mcp-runtime-client.spec.ts',
  'src/__tests__/run-python-tool.spec.ts',
  'src/__tests__/tool-execution-durations.spec.ts',
  'src/__tests__/mcp-tool-guard-cancellation.integration.spec.ts',
];

function readTestConfig() {
  return JSON.parse(readFileSync(testConfigPath, 'utf8'));
}

test('admitted regression files belong to the actual compiler program', () => {
  const result = verifyTestTsconfigProgram({
    checkTypes: false,
    cwd: agentRoot,
    minTestFiles: 1,
    project: 'tsconfig.test.json',
  });
  assert.equal(result.ok, true, result.message);
  const selected = new Set(
    result.testFiles.map((file) => path.relative(agentRoot, file).replaceAll('\\', '/'))
  );
  assert.deepEqual(
    REQUIRED_REGRESSIONS.filter((file) => !selected.has(file)),
    [],
    'admitted regressions must be checked even when the numeric exclusion ceiling permits them'
  );
});

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
