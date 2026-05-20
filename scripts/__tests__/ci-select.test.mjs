import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSelection,
  collectGitSelection,
  E2E_LANES,
  LOCAL_PROOF_COMMANDS,
  parseSelectArgs,
  renderSelectionJson,
} from '../ci-select.mjs';

test('parseSelectArgs defaults base and head', () => {
  assert.deepEqual(parseSelectArgs([]), {
    base: 'origin/main',
    format: 'json',
    head: 'HEAD',
  });
});

test('parseSelectArgs rejects duplicate flags', () => {
  assert.throws(
    () => parseSelectArgs(['--base', 'main', '--base', 'origin/main']),
    /--base can only be provided once/
  );
});

test('buildSelection returns files, lanes, expanded lanes, labels, and commands', () => {
  const selection = buildSelection({
    base: 'origin/main',
    baseSha: '1111111111111111111111111111111111111111',
    files: ['apps/desktop/src/embedding-host-manager.ts'],
    head: 'HEAD',
    headSha: '2222222222222222222222222222222222222222',
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, [
    'ci:desktop',
    'ci:embedding',
    'ci:coverage',
  ]);
  assert.deepEqual(selection.labels, [
    'ci:desktop',
    'ci:embedding',
    'ci:coverage',
  ]);
  assert.deepEqual(selection.expandedLanes, [
    'ci:desktop',
    'ci:embedding',
    'ci:coverage',
  ]);
  assert.equal(
    selection.commands.some((entry) => entry.name === 'desktop-smoke-tests'),
    true
  );
  assert.equal(
    selection.commands.some((entry) => entry.name === 'desktop-embedding-smoke'),
    true
  );
});

test('buildSelection includes deterministic risk profile and local proof commands', () => {
  const selection = buildSelection({
    base: 'origin/main',
    baseSha: '1111111111111111111111111111111111111111',
    files: ['packages/file-explorer-ui/src/tree/optimized-file-tree.tsx'],
    head: 'HEAD',
    headSha: '2222222222222222222222222222222222222222',
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.equal(selection.riskProfile.category, 'web-ui-file-explorer');
  assert.deepEqual(selection.riskProfile.e2eLanes, ['web-functional-stateful']);
  assert.deepEqual(
    selection.commands.map((entry) => entry.name),
    ['diff-check', 'file-explorer-tests', 'web-smoke-tests']
  );
  assert.deepEqual(
    selection.commands.map((entry) => entry.owner),
    ['tooling', 'workspace-experience', 'applications']
  );
  assert.deepEqual(
    selection.commands.map((entry) => typeof entry.budgetMs),
    ['number', 'number', 'number']
  );
  assert.deepEqual(selection.budget, {
    target: 'normal-pr-risk',
    targetMs: 15 * 60_000,
    totalMs: 570_000,
    status: 'within-target',
  });
});

test('buildSelection keeps docs-only proof cheap and without labels', () => {
  const selection = buildSelection({
    base: 'origin/main',
    baseSha: '1111111111111111111111111111111111111111',
    files: ['docs/architecture-reset/report.html'],
    head: 'HEAD',
    headSha: '2222222222222222222222222222222222222222',
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, []);
  assert.deepEqual(selection.labels, []);
  assert.deepEqual(selection.riskProfile.e2eLanes, []);
  assert.deepEqual(
    selection.commands.map((entry) => entry.name),
    ['diff-check', 'docs-static']
  );
  assert.deepEqual(selection.budget, {
    target: 'fast-local',
    targetMs: 2 * 60_000,
    totalMs: 60_000,
    status: 'within-target',
  });
});

test('buildSelection keeps isolated unit tests out of product e2e lanes', () => {
  const selection = buildSelection({
    files: ['packages/utils/src/__tests__/token-counting-boundary.test.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.equal(selection.riskProfile.category, 'isolated-unit-test-only');
  assert.deepEqual(selection.riskProfile.e2eLanes, []);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'changed-unit-tests']
  );
  assert.equal(
    selection.commands[1].command,
    'node scripts/run-changed-unit-tests.mjs --base 1111111111111111111111111111111111111111 --head HEAD'
  );
});

test('buildSelection marks full release proof as explicit release budget', () => {
  const selection = buildSelection({
    base: 'origin/main',
    baseSha: '1111111111111111111111111111111111111111',
    files: ['turbo.jsonc'],
    head: 'HEAD',
    headSha: '2222222222222222222222222222222222222222',
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.budget, {
    target: 'release-full-risk',
    targetMs: 60 * 60_000,
    totalMs: 3_030_000,
    status: 'within-target',
  });
});

test('E2E lane command taxonomy is explicit and avoids hidden full-suite fallback', () => {
  assert.deepEqual(Object.keys(E2E_LANES), [
    'critical-smoke',
    'web-functional-stateful',
    'desktop-smoke-regression',
    'desktop-embedding-diagnostics',
    'destructive-reset',
    'long-soak-release-only',
  ]);
  assert.match(E2E_LANES['desktop-embedding-diagnostics'].command, /@desktop-embedding-lifecycle/);
  assert.doesNotMatch(
    E2E_LANES['desktop-embedding-diagnostics'].command,
    /@desktop-embedding-crash/
  );
  assert.match(E2E_LANES['destructive-reset'].command, /@destructive/);
  assert.match(E2E_LANES['long-soak-release-only'].tagContract, /release/);
});

test('local proof command registry has owners and timing budgets for failure routing', () => {
  for (const command of Object.values(LOCAL_PROOF_COMMANDS)) {
    assert.equal(typeof command.owner, 'string', command.name);
    assert.equal(typeof command.budgetMs, 'number', command.name);
    assert.equal(command.budgetMs > 0, true, command.name);
  }
  assert.equal(LOCAL_PROOF_COMMANDS['db-tests'].budgetMs, 300_000);
  assert.match(
    LOCAL_PROOF_COMMANDS['migration-tests'].command,
    /__tests__\/migration-integration\.test\.ts/
  );
  assert.match(
    LOCAL_PROOF_COMMANDS['migration-tests'].command,
    /__tests__\/drizzle-migrate\.test\.ts/
  );
  assert.doesNotMatch(LOCAL_PROOF_COMMANDS['migration-tests'].command, /\*\*/);
});

test('buildSelection routes storage changes to storage tests instead of db tests', () => {
  const selection = buildSelection({
    files: ['packages/storage/src/safe-json-state-storage.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'storage-tests']
  );
});

test('buildSelection rejects unsafe merge-base placeholders', () => {
  assert.throws(
    () =>
      buildSelection({
        base: 'origin/main',
        baseSha: '1111111111111111111111111111111111111111',
        files: ['packages/storage/src/opfs.ts'],
        head: 'HEAD',
        headSha: '2222222222222222222222222222222222222222',
        mergeBase: 'main;echo unsafe',
      }),
    /mergeBase must be a 40-character git SHA/
  );
});

test('collectGitSelection includes deleted files in risk selection', async () => {
  const commands = [];
  const runner = async (command, args) => {
    commands.push([command, args]);
    if (command === 'git' && args.join(' ') === 'merge-base origin/main HEAD') {
      return '1111111111111111111111111111111111111111\n';
    }
    if (command === 'git' && args.join(' ') === 'rev-parse origin/main') {
      return '1111111111111111111111111111111111111111\n';
    }
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
      return '2222222222222222222222222222222222222222\n';
    }
    if (
      command === 'git' &&
      args.join(' ') ===
        'diff --name-only --diff-filter=ACDMRTUXB 1111111111111111111111111111111111111111 HEAD'
    ) {
      return 'apps/web/src/deleted-route.tsx\n';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const selection = await collectGitSelection(
    { base: 'origin/main', head: 'HEAD' },
    runner
  );

  assert.deepEqual(selection.files, ['apps/web/src/deleted-route.tsx']);
  assert.deepEqual(selection.lanes, ['ci:web-e2e', 'ci:coverage']);
  assert.equal(
    commands.some(
      ([command, args]) =>
        command === 'git' &&
        args.join(' ') ===
          'diff --name-only --diff-filter=ACDMRTUXB 1111111111111111111111111111111111111111 HEAD'
    ),
    true
  );
});

test('renderSelectionJson emits stable JSON', () => {
  const json = renderSelectionJson({
    base: 'origin/main',
    baseSha: '1',
    commands: [],
    budget: null,
    expandedLanes: [],
    files: [],
    riskProfile: null,
    head: 'HEAD',
    headSha: '2',
    labels: [],
    lanes: [],
    mergeBase: '1',
  });

  assert.equal(json.endsWith('\n'), true);
  assert.deepEqual(Object.keys(JSON.parse(json)), [
    'base',
    'baseSha',
    'head',
    'headSha',
    'mergeBase',
    'files',
    'riskProfile',
    'lanes',
    'expandedLanes',
    'labels',
    'commands',
    'budget',
  ]);
});
