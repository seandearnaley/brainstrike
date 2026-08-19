// Paired test for scripts/verify-lost-file-reporter.mjs (BST-1221).
//
// Owns the guard's DETECTION logic and its verdict on the real repo; the shared
// entrypoint contract in verify-script-entrypoints.test.mjs owns only the
// direct-execution wiring.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findConfigsMissingReporter,
  findVitestConfigs,
  main,
} from '../verify-lost-file-reporter.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A miniature workspace: `<root>/packages/<name>/vitest.config.mts`. */
function makeWorkspace(configsByPackage) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bst1221-reporter-guard-'));
  for (const [packageName, contents] of Object.entries(configsByPackage)) {
    const dir = path.join(root, 'packages', packageName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'vitest.config.mts'), contents);
  }
  return root;
}

const WITH_REPORTER = `
import LostTestFileReporter from '@brainstrike/test-utils/vitest-lost-file-reporter';
export default { test: { reporters: ['default', new LostTestFileReporter()] } };
`;

const WITHOUT_REPORTER = `
export default { test: { pool: 'forks' } };
`;

test('flags a config that does not register the reporter', () => {
  const root = makeWorkspace({ bad: WITHOUT_REPORTER, good: WITH_REPORTER });
  const configs = findVitestConfigs(root);

  assert.equal(configs.length, 2);
  assert.deepEqual(findConfigsMissingReporter(root, configs), ['packages/bad/vitest.config.mts']);
});

test('accepts a workspace where every config registers the reporter', () => {
  const root = makeWorkspace({ a: WITH_REPORTER, b: WITH_REPORTER });
  const configs = findVitestConfigs(root);

  assert.deepEqual(findConfigsMissingReporter(root, configs), []);
});

test('refuses an empty root rather than reporting a vacuous pass', async () => {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'bst1221-empty-'));

  await assert.rejects(
    () => main({ repoRoot: emptyRoot }),
    /below the floor/,
    'A root with no vitest configs must throw, not silently verify zero files.'
  );
});

test('MONEY TEST: the real repo registers the reporter in every vitest config', async () => {
  const configs = findVitestConfigs(REPO_ROOT);
  const missing = findConfigsMissingReporter(REPO_ROOT, configs);

  assert.deepEqual(
    missing,
    [],
    'These vitest configs do not register LostTestFileReporter, so a worker killed mid-run ' +
      'in those lanes can silently drop a whole test file (BST-1221):\n' +
      missing.map((configPath) => `  - ${configPath}`).join('\n')
  );
});
