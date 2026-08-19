// Paired test for scripts/verify-lost-file-reporter.mjs (BST-1221).
//
// Owns the guard's DETECTION logic and its verdict on the real repo; the shared
// entrypoint contract in verify-script-entrypoints.test.mjs owns only the
// direct-execution wiring.
//
// The centre of gravity here is PROVING THE GUARD CAN FAIL. Its first version
// asserted only that a config's TEXT contained the reporter's module name,
// which an unused import — or a comment merely mentioning it — satisfied while
// `test.reporters` omitted the reporter entirely. That guard reported success
// for a workspace with no protection at all. The fixtures below are the
// specific shapes that fooled it, kept as permanent controls.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findConfigsMissingReporter,
  findScriptsOverridingReporters,
  findVitestConfigs,
  loadExemptPackageNames,
  main,
  registersReporter,
} from '../verify-lost-file-reporter.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORTER_PATH = path.join(REPO_ROOT, 'packages/test-utils/vitest-lost-file-reporter.mjs');

/** A miniature workspace: `<root>/packages/<name>/{package.json,vitest.config.mts}`. */
function makeWorkspace(configsByPackage) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bst1221-reporter-guard-'));
  for (const [packageName, contents] of Object.entries(configsByPackage)) {
    const dir = path.join(root, 'packages', packageName);
    mkdirSync(dir, { recursive: true });
    const isEntry = typeof contents === 'string';
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: `@brainstrike/${packageName}`,
        scripts: isEntry ? {} : (contents.scripts ?? {}),
      })
    );
    writeFileSync(path.join(dir, 'vitest.config.mts'), isEntry ? contents : contents.config);
  }
  return root;
}

/** Registers the reporter for real. */
const REGISTERED = `
import LostTestFileReporter from '${REPORTER_PATH}';
export default { test: { reporters: ['default', new LostTestFileReporter()] } };
`;

/** THE FALSE GREEN: imports the reporter, never registers it. */
const IMPORTED_BUT_UNREGISTERED = `
import LostTestFileReporter from '${REPORTER_PATH}';
export default { test: { reporters: ['default'] } };
`;

/** THE FALSE GREEN: registration commented out, module name still present. */
const COMMENTED_OUT = `
// import LostTestFileReporter from '${REPORTER_PATH}';
// reporters: ['default', new LostTestFileReporter()],
export default { test: { reporters: ['default'] } };
`;

/** THE FALSE GREEN: only a prose mention of vitest-lost-file-reporter. */
const MENTIONED_IN_A_COMMENT = `
// See packages/test-utils/vitest-lost-file-reporter.mjs for why lost files fail.
export default { test: { reporters: ['default'] } };
`;

/** No reporters key at all. */
const NO_REPORTERS = `
export default { test: { pool: 'forks' } };
`;

test('MONEY TEST: a config that imports the reporter but never registers it is REJECTED', async () => {
  // The exact shape the substring guard passed. If this ever goes green, the
  // guard has stopped being evidence.
  const root = makeWorkspace({ sneaky: IMPORTED_BUT_UNREGISTERED });

  assert.deepEqual(await findConfigsMissingReporter(root, findVitestConfigs(root)), [
    'packages/sneaky/vitest.config.mts',
  ]);
});

test('a commented-out registration is REJECTED', async () => {
  const root = makeWorkspace({ commented: COMMENTED_OUT });

  assert.deepEqual(await findConfigsMissingReporter(root, findVitestConfigs(root)), [
    'packages/commented/vitest.config.mts',
  ]);
});

test('a mere prose mention of the module name is REJECTED', async () => {
  const root = makeWorkspace({ prose: MENTIONED_IN_A_COMMENT });

  assert.deepEqual(await findConfigsMissingReporter(root, findVitestConfigs(root)), [
    'packages/prose/vitest.config.mts',
  ]);
});

test('a config with no reporters key at all is REJECTED', async () => {
  const root = makeWorkspace({ bare: NO_REPORTERS });

  assert.deepEqual(await findConfigsMissingReporter(root, findVitestConfigs(root)), [
    'packages/bare/vitest.config.mts',
  ]);
});

test('CONTROL: a genuinely registered config passes', async () => {
  const root = makeWorkspace({ good: REGISTERED });

  assert.deepEqual(await findConfigsMissingReporter(root, findVitestConfigs(root)), []);
});

test('separates a registered config from an unregistered one in the same workspace', async () => {
  const root = makeWorkspace({ bad: IMPORTED_BUT_UNREGISTERED, good: REGISTERED });

  assert.deepEqual(await findConfigsMissingReporter(root, findVitestConfigs(root)), [
    'packages/bad/vitest.config.mts',
  ]);
});

test('registersReporter rejects lookalikes and non-arrays', () => {
  assert.equal(registersReporter(undefined), false);
  assert.equal(registersReporter('default'), false);
  assert.equal(registersReporter(['default']), false);
  // Right name, no hook — not a functioning reporter.
  class LostTestFileReporter {}
  assert.equal(registersReporter([new LostTestFileReporter()]), false);
});

test('an exempt package may omit the reporter; a non-exempt one may not', async () => {
  const root = makeWorkspace({ bad: NO_REPORTERS, exempt: NO_REPORTERS });
  const exempt = new Set(['@brainstrike/exempt']);

  assert.deepEqual(await findConfigsMissingReporter(root, findVitestConfigs(root), exempt), [
    'packages/bad/vitest.config.mts',
  ]);
});

test('the exemption set is the tooling domain, read from the real contract', () => {
  const exempt = loadExemptPackageNames(REPO_ROOT);

  assert.ok(exempt.size > 0, 'tooling domain must classify at least one package');
  assert.ok(exempt.has('@brainstrike/config'));
  assert.ok(
    !exempt.has('@brainstrike/embeddings'),
    'WASM-heavy lanes must never be exempt — they are the ones this reporter exists for.'
  );
});

test('refuses an empty root rather than reporting a vacuous pass', async () => {
  const emptyRoot = mkdtempSync(path.join(os.tmpdir(), 'bst1221-empty-'));

  await assert.rejects(
    () => main({ repoRoot: emptyRoot }),
    /below the floor/,
    'A root with no vitest configs must throw, not silently verify zero files.'
  );
});

test('MONEY TEST: every non-exempt vitest config in the real repo REGISTERS the reporter', async () => {
  const configs = findVitestConfigs(REPO_ROOT);
  const missing = await findConfigsMissingReporter(
    REPO_ROOT,
    configs,
    loadExemptPackageNames(REPO_ROOT)
  );

  assert.deepEqual(
    missing,
    [],
    'These vitest configs do not register LostTestFileReporter, so a worker killed mid-run ' +
      'in those lanes can silently drop a whole test file (BST-1221):\n' +
      missing.map((configPath) => `  - ${configPath}`).join('\n')
  );
});

test('MONEY TEST: a script whose CLI --reporter drops the lost-file reporter is REJECTED', async () => {
  // A CLI `--reporter` OVERRIDES config `reporters`, so config registration
  // alone is not proof the lane is protected.
  const root = makeWorkspace({
    shard: {
      config: REGISTERED,
      scripts: { 'test:shard': 'vitest run --reporter=default --reporter=blob' },
    },
  });

  assert.deepEqual(findScriptsOverridingReporters(root), [
    { packageName: '@brainstrike/shard', script: 'test:shard' },
  ]);
  // ...and the config itself is still fine, so only the script is at fault.
  assert.deepEqual(await findConfigsMissingReporter(root, findVitestConfigs(root)), []);
});

test('CONTROL: a --reporter script naming the lost-file reporter passes', () => {
  const root = makeWorkspace({
    shard: {
      config: REGISTERED,
      scripts: {
        'test:shard':
          'vitest run --reporter=default --reporter=blob ' +
          '--reporter=@brainstrike/test-utils/vitest-lost-file-reporter',
      },
    },
  });

  assert.deepEqual(findScriptsOverridingReporters(root), []);
});

test('a non-vitest script using --reporter is not the concern of this guard', () => {
  const root = makeWorkspace({
    linty: { config: REGISTERED, scripts: { lint: 'eslint . --reporter=json' } },
  });

  assert.deepEqual(findScriptsOverridingReporters(root), []);
});

test('MONEY TEST: no real package script overrides reporters without naming ours', () => {
  const offenders = findScriptsOverridingReporters(REPO_ROOT, loadExemptPackageNames(REPO_ROOT));

  assert.deepEqual(
    offenders,
    [],
    'These scripts pass a CLI --reporter, which overrides config reporters and silently ' +
      'drops the lost-file guarantee for that lane (BST-1221):\n' +
      offenders.map((o) => `  - ${o.packageName} -> ${o.script}`).join('\n')
  );
});
