// Paired test for scripts/verify-event-loop-watchdog.mjs (BST-1221).
//
// Proves the guard can FAIL: the fixtures below are the exact shapes a
// text-matching guard would wave through — the setup listed second, mentioned
// in a comment, or imported but never registered — and each must be rejected.
// The real-repo case is the enforcement: every PGlite-hosting lane leads its
// setupFiles with the watchdog.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findLanesMissingWatchdog,
  leadsWithWatchdog,
  loadEffectiveSetupFiles,
  MIN_LANES,
  main,
  PGLITE_LANES,
  WATCHDOG_SETUP_ID,
} from '../verify-event-loop-watchdog.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A miniature workspace: `<root>/packages/<name>/vitest.config.mts` per entry. */
function makeWorkspace(t, configsByPackage) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bst1221-watchdog-guard-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  for (const [packageName, contents] of Object.entries(configsByPackage)) {
    const dir = path.join(root, 'packages', packageName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'vitest.config.mts'), contents);
  }
  return root;
}

const FIRST = `export default { test: { setupFiles: ['${WATCHDOG_SETUP_ID}', './vitest.setup.ts'] } };\n`;
const SECOND = `export default { test: { setupFiles: ['./vitest.setup.ts', '${WATCHDOG_SETUP_ID}'] } };\n`;
const ABSENT = `export default { test: { setupFiles: ['./vitest.setup.ts'] } };\n`;
const COMMENTED = `// setupFiles: ['${WATCHDOG_SETUP_ID}']\nexport default { test: { setupFiles: ['./vitest.setup.ts'] } };\n`;
const NO_SETUP = 'export default { test: { include: ["**/*.test.ts"] } };\n';
const PROJECTS = `export default { test: { projects: [
  { test: { name: 'unit', setupFiles: ['${WATCHDOG_SETUP_ID}'] } },
  { test: { name: 'browser', setupFiles: ['./browser.setup.ts'] } },
] } };\n`;

async function missingIn(root, lanes) {
  return (await findLanesMissingWatchdog(root, lanes)).map((lane) => lane.config);
}

test('MONEY TEST: the watchdog listed SECOND is REJECTED', async (t) => {
  const root = makeWorkspace(t, { late: SECOND });
  assert.deepEqual(await missingIn(root, [{ config: 'packages/late/vitest.config.mts' }]), [
    'packages/late/vitest.config.mts',
  ]);
});

test('a lane that omits the watchdog is REJECTED', async (t) => {
  const root = makeWorkspace(t, { bare: ABSENT, none: NO_SETUP });
  assert.deepEqual(
    await missingIn(root, [
      { config: 'packages/bare/vitest.config.mts' },
      { config: 'packages/none/vitest.config.mts' },
    ]),
    ['packages/bare/vitest.config.mts', 'packages/none/vitest.config.mts']
  );
});

test('a comment mentioning the setup is REJECTED', async (t) => {
  const root = makeWorkspace(t, { prose: COMMENTED });
  assert.deepEqual(await missingIn(root, [{ config: 'packages/prose/vitest.config.mts' }]), [
    'packages/prose/vitest.config.mts',
  ]);
});

test('a lane whose config file is missing is REJECTED, not skipped', async (t) => {
  const root = makeWorkspace(t, { present: FIRST });
  const missing = await findLanesMissingWatchdog(root, [
    { config: 'packages/present/vitest.config.mts' },
    { config: 'packages/gone/vitest.config.mts' },
  ]);
  assert.deepEqual(
    missing.map((lane) => [lane.config, lane.reason]),
    [['packages/gone/vitest.config.mts', 'config file does not exist']]
  );
});

test('CONTROL: the watchdog listed FIRST passes', async (t) => {
  const root = makeWorkspace(t, { good: FIRST });
  assert.deepEqual(await missingIn(root, [{ config: 'packages/good/vitest.config.mts' }]), []);
});

test('an inline project is checked by name, and a missing project name throws', async (t) => {
  const root = makeWorkspace(t, { multi: PROJECTS });
  const configPath = path.join(root, 'packages/multi/vitest.config.mts');
  assert.deepEqual(await loadEffectiveSetupFiles(configPath, 'unit'), [WATCHDOG_SETUP_ID]);
  assert.deepEqual(
    await missingIn(root, [{ config: 'packages/multi/vitest.config.mts', project: 'unit' }]),
    []
  );
  assert.deepEqual(
    await missingIn(root, [{ config: 'packages/multi/vitest.config.mts', project: 'browser' }]),
    ['packages/multi/vitest.config.mts']
  );
  await assert.rejects(
    () => loadEffectiveSetupFiles(configPath, 'nope'),
    /no inline project named "nope"/
  );
});

test('top-level setup cannot mask an unguarded inline project', async (t) => {
  const root = makeWorkspace(t, {
    multi: PROJECTS.replace(
      'test: { projects:',
      `test: { setupFiles: ['${WATCHDOG_SETUP_ID}'], projects:`
    ),
  });
  const missing = await findLanesMissingWatchdog(root, [
    { config: 'packages/multi/vitest.config.mts' },
  ]);
  assert.equal(missing.length, 1);
  assert.match(missing[0].reason, /name the project/);
});

test('leadsWithWatchdog accepts valid string or array setup and rejects non-leading positions', () => {
  assert.equal(leadsWithWatchdog(undefined), false);
  assert.equal(leadsWithWatchdog(WATCHDOG_SETUP_ID), true);
  assert.equal(leadsWithWatchdog('./other.setup.mjs'), false);
  assert.equal(leadsWithWatchdog(['./a', WATCHDOG_SETUP_ID]), false);
  assert.equal(leadsWithWatchdog([WATCHDOG_SETUP_ID]), true);
});

test('resolved watchdog module identity passes only in first position', async (t) => {
  const actualConfig = path.join(REPO_ROOT, 'apps/desktop/vitest.config.mts');
  const watchdogPath = createRequire(actualConfig).resolve(WATCHDOG_SETUP_ID);
  const root = makeWorkspace(t, {
    impostor: `export default { test: { setupFiles: ['./vitest.event-loop-watchdog.setup.mjs'] } };`,
    resolved: `export default { test: { setupFiles: [${JSON.stringify(watchdogPath)}] } };`,
    second: `export default { test: { setupFiles: ['./other.setup.mjs', ${JSON.stringify(watchdogPath)}] } };`,
  });
  symlinkSync(
    path.join(REPO_ROOT, 'apps/desktop/node_modules'),
    path.join(root, 'node_modules'),
    'dir'
  );
  writeFileSync(
    path.join(root, 'packages/impostor/vitest.event-loop-watchdog.setup.mjs'),
    'export {};'
  );
  assert.deepEqual(
    await missingIn(root, [
      { config: 'packages/resolved/vitest.config.mts' },
      { config: 'packages/second/vitest.config.mts' },
      { config: 'packages/impostor/vitest.config.mts' },
    ]),
    ['packages/second/vitest.config.mts', 'packages/impostor/vitest.config.mts']
  );
});

test('CONTROL: a scalar setupFiles value loads and passes', async (t) => {
  const root = makeWorkspace(t, {
    scalar: `export default { test: { setupFiles: '${WATCHDOG_SETUP_ID}' } };`,
  });
  assert.deepEqual(await missingIn(root, [{ config: 'packages/scalar/vitest.config.mts' }]), []);
});

const INTEGRATION_PACKAGES = [
  'apps/desktop',
  'packages/agent',
  'packages/app-shell',
  'packages/assistant-data',
  'packages/embeddings',
  'packages/file-import',
  'packages/settings-ui',
];

for (const packagePath of INTEGRATION_PACKAGES) {
  test(`integration overrides that drop or reorder setup are rejected (${packagePath} shape)`, async (t) => {
    const root = makeWorkspace(t, {});
    const dir = path.join(root, packagePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'vitest.config.mts'), FIRST);
    const integrationConfig = `${packagePath}/vitest.integration.config.mts`;
    const lanes = PGLITE_LANES.filter((lane) => path.dirname(lane.config) === packagePath);
    for (const setup of [[], ['./other.setup.mjs', WATCHDOG_SETUP_ID]]) {
      writeFileSync(
        path.join(root, integrationConfig),
        `
        import base from './vitest.config.mts';
        export default { ...base, test: { ...base.test, setupFiles: ${JSON.stringify(setup)} } };
      `
      );
      assert.deepEqual(await missingIn(root, lanes), [integrationConfig]);
    }
    writeFileSync(
      path.join(root, integrationConfig),
      `
      import base from './vitest.config.mts';
      export default { ...base, test: { ...base.test, include: ['**/*.integration.test.ts'] } };
    `
    );
    assert.deepEqual(await missingIn(root, lanes), []);
  });
}

test('a config load failure names the lane and still reports other broken lanes', async (t) => {
  const root = makeWorkspace(t, {
    broken: "throw new Error('fixture dependency unavailable'); export default {};",
    late: SECOND,
  });
  const missing = await findLanesMissingWatchdog(root, [
    { config: 'packages/broken/vitest.config.mts' },
    { config: 'packages/late/vitest.config.mts' },
  ]);
  assert.equal(missing.length, 2);
  assert.equal(missing[0].config, 'packages/broken/vitest.config.mts');
  assert.match(missing[0].reason, /config failed to load:.*fixture dependency unavailable/);
  assert.equal(missing[1].config, 'packages/late/vitest.config.mts');
});

test('main rejects an unverifiable root without changing the caller exit code', async (t) => {
  const root = makeWorkspace(t, {});
  const originalExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = originalExitCode;
  });
  await assert.rejects(() => main({ repoRoot: root }), /config file does not exist/);
  assert.equal(process.exitCode, originalExitCode);
});

test('the actual CLI reports failing lanes and exits nonzero', (t) => {
  const root = makeWorkspace(t, {});
  const dir = path.join(root, 'scripts');
  mkdirSync(dir);
  const script = path.join(dir, 'verify-event-loop-watchdog.mjs');
  copyFileSync(path.join(REPO_ROOT, 'scripts/verify-event-loop-watchdog.mjs'), script);
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /packages\/assistant-data\/vitest.integration.config.mts/);
  assert.match(result.stderr, /config file does not exist/);
  assert.match(result.stderr, /Put this as the FIRST entry/);
});

test('refuses a lane list below the floor rather than reporting a vacuous pass', async () => {
  await assert.rejects(
    () => main({ lanes: PGLITE_LANES.slice(0, MIN_LANES - 1), repoRoot: REPO_ROOT }),
    /below the floor/
  );
});

test('MONEY TEST: the real repository passes the actual watchdog CLI', () => {
  assert.ok(PGLITE_LANES.length >= MIN_LANES);
  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'scripts/verify-event-loop-watchdog.mjs')],
    { encoding: 'utf8' }
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /verify-event-loop-watchdog: OK/);
  assert.match(result.stdout, /OK \(18 PGlite-hosting lanes/);
});
