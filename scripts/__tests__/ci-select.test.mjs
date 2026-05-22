import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
    'ci:desktop-runtime-hosts',
    'ci:coverage',
  ]);
  assert.deepEqual(selection.labels, [
    'ci:desktop-runtime-hosts',
    'ci:coverage',
  ]);
  assert.deepEqual(selection.expandedLanes, [
    'ci:desktop-runtime-hosts',
    'ci:coverage',
  ]);
  assert.equal(
    selection.commands.some((entry) => entry.name === 'desktop-runtime-host-tests'),
    true
  );
  assert.equal(
    selection.commands.some((entry) => entry.name === 'desktop-embedding-smoke'),
    false
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
  assert.deepEqual(selection.riskProfile.e2eLanes, ['web-file-explorer-persistence']);
  assert.deepEqual(
    selection.commands.map((entry) => entry.name),
    ['diff-check', 'file-explorer-tests', 'web-file-explorer-persistence-tests']
  );
  assert.deepEqual(
    selection.commands.map((entry) => entry.owner),
    ['tooling', 'workspace-experience', 'workspace-experience']
  );
  assert.deepEqual(
    selection.commands.map((entry) => typeof entry.budgetMs),
    ['number', 'number', 'number']
  );
  assert.deepEqual(selection.budget, {
    target: 'normal-pr-risk',
    targetMs: 15 * 60_000,
    totalMs: 630_000,
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
  const smokeLaneCount = selection.riskProfile.e2eLanes.filter(
    (lane) => lane === 'critical-smoke' || lane === 'web-smoke'
  ).length;
  assert.equal(smokeLaneCount, 1);
});

test('E2E lane command taxonomy is explicit and avoids hidden full-suite fallback', () => {
  assert.deepEqual(Object.keys(E2E_LANES), [
    'critical-smoke',
    'web-smoke',
    'web-file-explorer-persistence',
    'web-import-indexing',
    'web-assistant-state',
    'web-settings-state',
    'web-db-startup',
    'web-destructive-reset',
    'web-full-regression',
    'desktop-smoke',
    'desktop-ipc-reset',
    'desktop-runtime-hosts',
    'desktop-db-storage',
    'desktop-full-regression',
    'desktop-embedding-diagnostics',
    'desktop-llm-host-recovery',
    'long-soak-release-only',
  ]);
  assert.match(E2E_LANES['critical-smoke'].command, /@web-smoke/);
  assert.match(E2E_LANES['web-smoke'].command, /@web-smoke/);
  assert.equal(E2E_LANES['critical-smoke'], E2E_LANES['web-smoke']);
  assert.match(E2E_LANES['web-file-explorer-persistence'].command, /@web-file-explorer-persistence/);
  assert.match(E2E_LANES['web-import-indexing'].command, /@web-import-indexing/);
  assert.match(E2E_LANES['web-assistant-state'].command, /@web-assistant-state/);
  assert.match(E2E_LANES['web-settings-state'].command, /@web-settings-state/);
  assert.match(E2E_LANES['web-db-startup'].command, /@web-db-startup/);
  assert.match(E2E_LANES['web-destructive-reset'].command, /@web-destructive-reset/);
  assert.match(E2E_LANES['web-full-regression'].command, /--grep-invert/);
  assert.match(E2E_LANES['desktop-ipc-reset'].command, /@desktop-ipc-reset/);
  assert.match(E2E_LANES['desktop-runtime-hosts'].command, /@desktop-runtime-hosts/);
  assert.match(E2E_LANES['desktop-db-storage'].command, /@desktop-db-storage/);
  assert.match(E2E_LANES['desktop-full-regression'].command, /--grep-invert "@desktop-embedding-/);
  assert.match(E2E_LANES['desktop-embedding-diagnostics'].command, /@desktop-embedding-lifecycle/);
  assert.doesNotMatch(
    E2E_LANES['desktop-embedding-diagnostics'].command,
    /embedding-worker-renderer\.test\.ts/
  );
  assert.doesNotMatch(
    E2E_LANES['desktop-embedding-diagnostics'].command,
    /@desktop-embedding-crash/
  );
  assert.match(E2E_LANES['desktop-llm-host-recovery'].command, /@desktop-llm-host-recovery/);
  assert.match(E2E_LANES['desktop-llm-host-recovery'].command, /llm-host-renderer\.test\.ts/);
  assert.match(E2E_LANES['long-soak-release-only'].tagContract, /release/);
});

test('E2E lane commands reference existing desktop embedding split specs', () => {
  const desktopEmbeddingCommands = [
    E2E_LANES['desktop-embedding-diagnostics'].command,
    LOCAL_PROOF_COMMANDS['desktop-embedding-smoke'].command,
  ];

  for (const command of desktopEmbeddingCommands) {
    const files = command.match(/\be2e\/embedding-worker-renderer[^\s]*\.test\.ts\b/g) ?? [];
    assert.notEqual(files.length, 0, command);
    for (const file of files) {
      assert.equal(existsSync(`apps/desktop/${file}`), true, file);
    }
  }
});

test('E2E lane commands reference an existing desktop llm host recovery spec', () => {
  const files =
    E2E_LANES['desktop-llm-host-recovery'].command.match(
      /\be2e\/llm-host-renderer\.test\.ts\b/g
    ) ?? [];

  assert.deepEqual(files, ['e2e/llm-host-renderer.test.ts']);
  assert.equal(existsSync('apps/desktop/e2e/llm-host-renderer.test.ts'), true);
});

test('buildSelection routes llm host changes to llm recovery without embedding diagnostics', () => {
  const selection = buildSelection({
    files: ['apps/desktop/src/llm-host-manager.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.equal(selection.riskProfile.category, 'desktop-runtime-hosts');
  assert.deepEqual(selection.riskProfile.e2eLanes, ['desktop-runtime-hosts']);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'desktop-unit-tests', 'desktop-runtime-host-tests']
  );
  assert.equal(
    selection.commands.some((command) => command.name === 'desktop-embedding-smoke'),
    false
  );
  assert.equal(selection.labels.includes('ci:embedding'), false);
  assert.equal(selection.labels.includes('ci:desktop'), false);
});

test('buildSelection routes factory reset changes to the narrow desktop reset lane', () => {
  const selection = buildSelection({
    files: ['apps/desktop/src/desktop-factory-reset.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, ['ci:desktop-ipc-reset', 'ci:coverage']);
  assert.deepEqual(selection.riskProfile.e2eLanes, ['desktop-ipc-reset']);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'desktop-unit-tests', 'desktop-ipc-reset-tests']
  );
  assert.equal(selection.labels.includes('ci:desktop'), false);
});

test('buildSelection proves every selected narrow desktop lane locally', () => {
  const selection = buildSelection({
    files: [
      'apps/desktop/src/desktop-factory-reset.ts',
      'apps/desktop/src/embedding-host-manager.ts',
    ],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, [
    'ci:desktop-ipc-reset',
    'ci:desktop-runtime-hosts',
    'ci:coverage',
  ]);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    [
      'diff-check',
      'desktop-unit-tests',
      'desktop-ipc-reset-tests',
      'desktop-runtime-host-tests',
    ]
  );
});

test('buildSelection routes db IPC changes to db storage without desktop full regression', () => {
  const selection = buildSelection({
    files: ['apps/desktop/src/ipc-domains/db-ipc.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, ['ci:desktop-db-storage', 'ci:coverage']);
  assert.deepEqual(selection.riskProfile.e2eLanes, ['desktop-db-storage']);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'desktop-unit-tests', 'desktop-db-storage-tests']
  );
  assert.equal(selection.labels.includes('ci:embedding'), false);
  assert.equal(selection.labels.includes('ci:desktop'), false);
});

test('buildSelection routes file explorer UI to only file explorer persistence', () => {
  const selection = buildSelection({
    files: ['packages/file-explorer-ui/src/tree/optimized-file-tree.tsx'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, ['ci:web-file-explorer-persistence', 'ci:coverage']);
  assert.deepEqual(selection.riskProfile.e2eLanes, ['web-file-explorer-persistence']);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'file-explorer-tests', 'web-file-explorer-persistence-tests']
  );
  assert.equal(selection.labels.includes('ci:web-import-indexing'), false);
  assert.equal(selection.labels.includes('ci:web-assistant-state'), false);
  assert.equal(selection.labels.includes('ci:web-settings-state'), false);
  assert.equal(selection.labels.includes('ci:web-destructive-reset'), false);
  assert.equal(selection.labels.includes('ci:web-e2e'), false);
});

test('buildSelection routes import indexing UI to import lane plus indexing proof', () => {
  const selection = buildSelection({
    files: ['apps/web/e2e/database-import-backfill.test.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, ['ci:web-import-indexing', 'ci:coverage']);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'indexing-tests', 'web-import-indexing-tests']
  );
  assert.equal(selection.labels.includes('ci:web-e2e'), false);
});

test('buildSelection routes assistant UI to assistant state only', () => {
  const selection = buildSelection({
    files: ['packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, ['ci:web-assistant-state', 'ci:coverage']);
  assert.deepEqual(selection.riskProfile.e2eLanes, ['web-assistant-state']);
});

test('buildSelection routes settings persistence to settings state only', () => {
  const selection = buildSelection({
    files: ['apps/web/e2e/settings-models-and-providers.test.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, ['ci:web-settings-state', 'ci:coverage']);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'web-settings-state-tests']
  );
});

test('buildSelection routes broad app shell to full web regression', () => {
  const selection = buildSelection({
    files: ['apps/web/src/App.tsx'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, ['ci:web-e2e', 'ci:coverage']);
  assert.deepEqual(selection.riskProfile.e2eLanes, ['web-full-regression']);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'web-full-regression-tests']
  );
});

test('buildSelection keeps broad preload bridge changes on full desktop regression', () => {
  const selection = buildSelection({
    files: ['apps/desktop/src/preload.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, ['ci:desktop', 'ci:coverage']);
  assert.deepEqual(selection.riskProfile.e2eLanes, ['desktop-full-regression']);
  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'desktop-unit-tests', 'desktop-full-regression-tests']
  );
});

test('buildSelection only emits E2E lanes with registered commands', () => {
  const representativeFiles = [
    'packages/agent/src/runtime.ts',
    'packages/embeddings/src/worker/embedding-worker.ts',
    'apps/desktop/src/preload.ts',
    'apps/web/src/App.tsx',
  ];

  for (const filePath of representativeFiles) {
    const selection = buildSelection({
      files: [filePath],
      mergeBase: '1111111111111111111111111111111111111111',
    });

    for (const lane of selection.riskProfile.e2eLanes) {
      assert.ok(E2E_LANES[lane], `${filePath} selected unregistered E2E lane ${lane}`);
    }
  }
});

test('local proof command registry has owners and timing budgets for failure routing', () => {
  for (const command of Object.values(LOCAL_PROOF_COMMANDS)) {
    assert.equal(typeof command.owner, 'string', command.name);
    assert.equal(typeof command.budgetMs, 'number', command.name);
    assert.equal(command.budgetMs > 0, true, command.name);
  }
  assert.equal(LOCAL_PROOF_COMMANDS['db-schema-migration-tests'].budgetMs, 120_000);
  assert.equal(LOCAL_PROOF_COMMANDS['db-repository-tests'].budgetMs, 150_000);
  assert.equal(LOCAL_PROOF_COMMANDS['db-queue-tests'].budgetMs, 90_000);
  assert.equal(LOCAL_PROOF_COMMANDS['db-search-tests'].budgetMs, 90_000);
  assert.equal(LOCAL_PROOF_COMMANDS['db-integration-tests'].budgetMs, 150_000);
  assert.match(
    LOCAL_PROOF_COMMANDS['db-schema-migration-tests'].command,
    /test:db:schema-migration/
  );
  assert.match(
    LOCAL_PROOF_COMMANDS['db-integration-tests'].command,
    /test:db:integration/
  );
  assert.doesNotMatch(LOCAL_PROOF_COMMANDS['db-repository-tests'].command, /\*\*/);
});

test('buildSelection routes db queue changes to the queue proof lane only', () => {
  const selection = buildSelection({
    files: ['packages/db/src/queue/job-queue.ts'],
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(
    selection.commands.map((command) => command.name),
    ['diff-check', 'db-queue-tests']
  );
  assert.deepEqual(selection.budget, {
    target: 'local-pr-risk',
    targetMs: 8 * 60_000,
    totalMs: 120_000,
    status: 'within-target',
  });
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
