/**
 * Agent test membership (BST-1782 / BST-2115).
 * No legacy exclusions remain. Check actual compiler membership against files
 * on disk as well as the numeric ceiling: include drift can hide a new test
 * without adding an exclusion. JavaScript lint policy is a separate contract.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyTestTsconfigProgram } from '../verify-test-tsconfig-program.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentRoot = path.join(repoRoot, 'packages/agent');
const testConfigPath = path.join(agentRoot, 'tsconfig.test.json');

/** No legacy test exclusions may return. */
const MAX_EXCLUDED_LEGACY_FILES = 0;

/** Not legacy debt — the ordinary build-output exclusions every project carries. */
const NON_LEGACY_EXCLUDES = new Set(['dist', 'node_modules']);
const TYPESCRIPT_TEST_PATTERN = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[cm]?tsx?)$/u;

function discoverTypeScriptTests(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(relative, entry.name);
    if (entry.name === 'node_modules' || file === 'dist') {
      return [];
    }
    if (entry.isDirectory()) {
      return discoverTypeScriptTests(root, file);
    }
    return entry.isFile() && /\.[cm]?tsx?$/u.test(file) && TYPESCRIPT_TEST_PATTERN.test(file)
      ? [file]
      : [];
  });
}

function missingTestFiles(root) {
  const result = verifyTestTsconfigProgram({
    checkTypes: false,
    cwd: root,
    minTestFiles: 1,
    project: 'tsconfig.test.json',
  });
  assert.equal(result.ok, true, result.message);
  const selected = new Set(
    result.testFiles.map((file) => path.relative(root, file).replaceAll('\\', '/'))
  );
  return discoverTypeScriptTests(root)
    .filter((file) => !selected.has(file))
    .sort();
}

function readTestConfig() {
  return JSON.parse(readFileSync(testConfigPath, 'utf8'));
}

test('every agent TypeScript test belongs to the actual compiler program', () => {
  assert.deepEqual(
    missingTestFiles(agentRoot),
    [],
    'real tests must remain checked when include patterns change'
  );
});

test('complete membership detects new nested tests even with no legacy exclusions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-test-membership-'));
  const writeConfig = (include) =>
    writeFileSync(
      path.join(root, 'tsconfig.test.json'),
      JSON.stringify({
        compilerOptions: { noEmit: true },
        exclude: [...NON_LEGACY_EXCLUDES],
        include,
      })
    );
  try {
    mkdirSync(path.join(root, 'src/nested'), { recursive: true });
    writeFileSync(path.join(root, 'src/seed.spec.ts'), 'export {};\n');
    writeConfig(['src/seed.spec.ts']);
    assert.deepEqual(missingTestFiles(root), []);
    const added = ['future.spec.ts', 'future.test.tsx', 'future.spec.mts', 'future.test.cts']
      .map((name) => `src/nested/${name}`)
      .sort();
    for (const file of added) {
      writeFileSync(path.join(root, file), 'export {};\n');
    }
    // The old required file still belongs, and the exclusion count is still zero.
    assert.deepEqual(missingTestFiles(root), added);
    writeConfig(['src/**/*']);
    assert.deepEqual(missingTestFiles(root), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
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
