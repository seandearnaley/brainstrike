// Paired test for scripts/verify-event-loop-watchdog.mjs (BST-1221).
//
// Proves the guard can FAIL: the fixtures below are the exact shapes a
// text-matching guard would wave through — the setup listed second, mentioned
// in a comment, or imported but never registered — and each must be rejected.
// The real-repo case is the enforcement: every PGlite-hosting lane leads its
// setupFiles with the watchdog.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
function makeWorkspace(configsByPackage) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bst1221-watchdog-guard-'));
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

test('MONEY TEST: the watchdog listed SECOND is REJECTED', async () => {
  const root = makeWorkspace({ late: SECOND });
  assert.deepEqual(await missingIn(root, [{ config: 'packages/late/vitest.config.mts' }]), [
    'packages/late/vitest.config.mts',
  ]);
});

test('a lane that omits the watchdog is REJECTED', async () => {
  const root = makeWorkspace({ bare: ABSENT, none: NO_SETUP });
  assert.deepEqual(
    await missingIn(root, [
      { config: 'packages/bare/vitest.config.mts' },
      { config: 'packages/none/vitest.config.mts' },
    ]),
    ['packages/bare/vitest.config.mts', 'packages/none/vitest.config.mts']
  );
});

test('a comment mentioning the setup is REJECTED', async () => {
  const root = makeWorkspace({ prose: COMMENTED });
  assert.deepEqual(await missingIn(root, [{ config: 'packages/prose/vitest.config.mts' }]), [
    'packages/prose/vitest.config.mts',
  ]);
});

test('a lane whose config file is missing is REJECTED, not skipped', async () => {
  const root = makeWorkspace({ present: FIRST });
  const missing = await findLanesMissingWatchdog(root, [
    { config: 'packages/present/vitest.config.mts' },
    { config: 'packages/gone/vitest.config.mts' },
  ]);
  assert.deepEqual(
    missing.map((lane) => [lane.config, lane.reason]),
    [['packages/gone/vitest.config.mts', 'config file does not exist']]
  );
});

test('CONTROL: the watchdog listed FIRST passes', async () => {
  const root = makeWorkspace({ good: FIRST });
  assert.deepEqual(await missingIn(root, [{ config: 'packages/good/vitest.config.mts' }]), []);
});

test('an inline project is checked by name, and a missing project name throws', async () => {
  const root = makeWorkspace({ multi: PROJECTS });
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

test('leadsWithWatchdog rejects non-arrays and non-leading positions', () => {
  assert.equal(leadsWithWatchdog(undefined), false);
  assert.equal(leadsWithWatchdog(WATCHDOG_SETUP_ID), false);
  assert.equal(leadsWithWatchdog(['./a', WATCHDOG_SETUP_ID]), false);
  assert.equal(leadsWithWatchdog([WATCHDOG_SETUP_ID]), true);
});

test('refuses a lane list below the floor rather than reporting a vacuous pass', async () => {
  await assert.rejects(
    () => main({ lanes: PGLITE_LANES.slice(0, MIN_LANES - 1), repoRoot: REPO_ROOT }),
    /below the floor/
  );
});

test('MONEY TEST: every PGlite-hosting lane in the real repo leads its setupFiles with the watchdog', async () => {
  assert.ok(PGLITE_LANES.length >= MIN_LANES);
  const missing = await findLanesMissingWatchdog(REPO_ROOT, PGLITE_LANES);
  assert.deepEqual(
    missing.map(
      (lane) => `${lane.config}${lane.project ? ` (${lane.project})` : ''}: ${lane.reason}`
    ),
    []
  );
});
