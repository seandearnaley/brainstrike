import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildAffectedPackageFilter,
  buildLanePackageNames,
  buildPackageLanePackageNames,
  buildTurboBuildFilterOutput,
  buildWeightedPackageLanes,
  createDbCoverageLaneCommands,
  createDbLaneCommands,
  dbChangeRequiresDependentUnitExpansion,
  filterCoveragePackages,
  filterTestablePackages,
  listCiDbCoverageLanes,
  listCiDbLaneGroups,
  modeIncludesDependentPackages,
  parsePnpmListJson,
  runCommandSequence,
  selectDbCoverageCiLanes,
  selectDbUnitCiLanes,
} from '../affected-unit-tests.mjs';
import {
  dbCoverageLaneDefinitions,
  dbUnitLaneDefinitions,
} from '../../packages/db/scripts/db-test-lane-manifest.mjs';

function extractWorkflowJob(workflow, jobName) {
  const start = workflow.indexOf(`  ${jobName}:\n`);
  assert.notEqual(start, -1, `Missing workflow job ${jobName}`);
  const nextJob = workflow.slice(start + 1).search(/\n  [a-zA-Z0-9_-]+:\n/);
  if (nextJob === -1) {
    return workflow.slice(start);
  }
  return workflow.slice(start, start + 1 + nextJob);
}

test('parsePnpmListJson extracts named workspaces in stable order', () => {
  assert.deepEqual(
    parsePnpmListJson(
      JSON.stringify([
        { name: '@brainstrike/db', path: '/repo/packages/db' },
        { path: '/repo/packages/no-name' },
        { name: '@brainstrike/app-shell', path: '/repo/packages/app-shell' },
      ])
    ),
    ['@brainstrike/app-shell', '@brainstrike/db']
  );
});

test('filterTestablePackages keeps only packages with a test script', () => {
  assert.deepEqual(
    filterTestablePackages(
      ['@brainstrike/app-shell', '@brainstrike/build-utils', '@brainstrike/db'],
      new Map([
        ['@brainstrike/app-shell', { scripts: { test: 'vitest run' } }],
        ['@brainstrike/build-utils', { scripts: { build: 'tsup' } }],
        ['@brainstrike/db', { scripts: { test: 'node scripts/test-lanes.mjs run all' } }],
      ])
    ),
    ['@brainstrike/app-shell', '@brainstrike/db']
  );
});

test('filterCoveragePackages keeps only packages with a coverage script', () => {
  assert.deepEqual(
    filterCoveragePackages(
      ['@brainstrike/app-shell', '@brainstrike/build-utils', '@brainstrike/db'],
      new Map([
        ['@brainstrike/app-shell', { scripts: { 'test:coverage': 'vitest run --coverage' } }],
        ['@brainstrike/build-utils', { scripts: { build: 'tsup' } }],
        ['@brainstrike/db', { scripts: { test: 'node scripts/test-lanes.mjs run all' } }],
      ])
    ),
    ['@brainstrike/app-shell']
  );
});

test('buildLanePackageNames assigns every package to exactly one lane', () => {
  const packages = [
    '@brainstrike/agent',
    '@brainstrike/app-shell',
    '@brainstrike/db',
    '@brainstrike/desktop',
    '@brainstrike/preferences',
    '@brainstrike/vector-management',
  ];

  const lanes = [
    buildLanePackageNames(packages, 1, 3),
    buildLanePackageNames(packages, 2, 3),
    buildLanePackageNames(packages, 3, 3),
  ];

  assert.deepEqual([...new Set(lanes.flat())].sort(), packages);
  assert.equal(lanes.flat().length, packages.length);
  assert.ok(lanes.every((lane) => lane.length > 0));
});

test('buildWeightedPackageLanes keeps the slowest packages in separate lanes', () => {
  const lanes = buildWeightedPackageLanes(
    [
      '@brainstrike/agent',
      '@brainstrike/app-shell',
      '@brainstrike/db',
      '@brainstrike/desktop',
      '@brainstrike/embeddings',
    ],
    4
  );

  assert.equal(lanes.filter((lane) => lane.includes('@brainstrike/db')).length, 1);
  assert.equal(lanes.filter((lane) => lane.includes('@brainstrike/desktop')).length, 1);
  assert.notEqual(
    lanes.findIndex((lane) => lane.includes('@brainstrike/db')),
    lanes.findIndex((lane) => lane.includes('@brainstrike/desktop'))
  );
  assert.notEqual(
    lanes.findIndex((lane) => lane.includes('@brainstrike/db')),
    lanes.findIndex((lane) => lane.includes('@brainstrike/embeddings'))
  );
});

test('buildPackageLanePackageNames excludes the dedicated DB package lane', () => {
  assert.deepEqual(
    buildPackageLanePackageNames(
      ['@brainstrike/app-shell', '@brainstrike/db', '@brainstrike/desktop'],
      1,
      1
    ),
    ['@brainstrike/app-shell', '@brainstrike/desktop']
  );
});

test('buildAffectedPackageFilter can scope PR units to directly changed packages', () => {
  assert.equal(
    buildAffectedPackageFilter('feature/turso-migration', { includeDependents: false }),
    '[origin/feature/turso-migration]'
  );
  assert.equal(
    buildAffectedPackageFilter('feature/turso-migration', { includeDependents: true }),
    '...[origin/feature/turso-migration]'
  );
});

test('buildTurboBuildFilterOutput emits safe Turbo package filters for lane builds', () => {
  assert.equal(buildTurboBuildFilterOutput(['@brainstrike/db']), '--filter=@brainstrike/db');
  assert.equal(
    buildTurboBuildFilterOutput(['@brainstrike/app-shell', '@brainstrike/vector-management']),
    '--filter=@brainstrike/app-shell --filter=@brainstrike/vector-management'
  );
  assert.throws(
    () => buildTurboBuildFilterOutput(['@brainstrike/db; echo nope']),
    /Unsafe package name for Turbo filter/
  );
  assert.throws(
    () => buildTurboBuildFilterOutput([]),
    /Cannot build a Turbo filter list for an empty package lane/
  );
});

test('PR unit modes expand dependents only for foundational package changes', () => {
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/file-explorer-ui']), false);
  assert.equal(modeIncludesDependentPackages('db', ['@brainstrike/file-explorer-ui']), false);
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/db']), true);
  assert.equal(modeIncludesDependentPackages('db', ['@brainstrike/utils']), true);
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/types']), true);
  assert.equal(modeIncludesDependentPackages('coverage-packages', ['@brainstrike/db']), false);
  assert.equal(modeIncludesDependentPackages('coverage-db', ['@brainstrike/db']), false);
});

test('DB repository-only changes stay on dedicated DB unit lanes', () => {
  const changedFiles = [
    'packages/db/__tests__/turso-token-cache-store.test.ts',
    'packages/db/scripts/db-test-lane-manifest.mjs',
    'packages/db/src/repositories/turso-token-cache-store.ts',
    'packages/db/src/repositories/token-cache-store-types.ts',
  ];

  assert.equal(dbChangeRequiresDependentUnitExpansion(changedFiles), false);
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/db'], changedFiles), false);
});

test('tested DB provider changes still expand dependent package unit shards', () => {
  const changedFiles = [
    'packages/db/__tests__/db-provider-initializing.test.tsx',
    'packages/db/src/db-provider.tsx',
    'packages/db/src/repositories/turso-file-record-repository.ts',
  ];

  assert.equal(dbChangeRequiresDependentUnitExpansion(changedFiles), true);
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/db'], changedFiles), true);
});

test('DB public API and migration changes still expand dependent unit packages', () => {
  assert.equal(dbChangeRequiresDependentUnitExpansion(['packages/db/src/db-provider.tsx']), true);
  assert.equal(
    dbChangeRequiresDependentUnitExpansion(['packages/db/src/repositories/index.ts']),
    true
  );
  assert.equal(
    dbChangeRequiresDependentUnitExpansion(['packages/db/src/migrations/049_public_change.ts']),
    true
  );
  assert.equal(
    modeIncludesDependentPackages('packages', ['@brainstrike/db'], ['packages/db/src/index.ts']),
    true
  );
});

test('Turso profile-bootstrap docs track Turso provider repository coverage', () => {
  const providerSource = readFileSync('packages/db/src/db-provider.tsx', 'utf8');
  const profileBootstrapDoc = readFileSync('docs/turso-migration/profile-bootstrap.md', 'utf8');
  const migratedRepositories = providerSource.match(
    /migratedRepositories:\s*\[(?<entries>[\s\S]*?)\]\s*,\s*unavailableRepositories:/
  )?.groups?.entries;

  assert.match(migratedRepositories ?? '', /'file_records'/);
  assert.doesNotMatch(
    providerSource,
    /unavailableRepositories:\s*\[[^\]]*'file_records'[^\]]*\]/s
  );
  assert.match(
    providerSource,
    /unavailableRepositories:\s*tursoRepositories\.fileChunkRepository\s*\?\s*\[\]\s*:\s*\['file_chunks'\]/
  );
  assert.match(profileBootstrapDoc, /^- `file_records`$/m);
  assert.match(
    profileBootstrapDoc,
    /Turso file-record repository is exposed through the desktop Turso provider/
  );
  assert.match(profileBootstrapDoc, /does not expose a generic `db` handle or `file_chunks`/);
});

test('createDbLaneCommands maps DB lanes to existing package scripts', () => {
  assert.deepEqual(createDbLaneCommands('repository'), [['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:repository']]]);
  assert.deepEqual(createDbLaneCommands('schema-migration'), [['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:schema-migration']]]);
  assert.deepEqual(createDbLaneCommands('queue'), [['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:queue']]]);
  assert.deepEqual(createDbLaneCommands('search'), [['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:search']]]);
  assert.deepEqual(createDbLaneCommands('integration'), [['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:integration']]]);
});

test('createDbCoverageLaneCommands maps DB coverage lanes to existing package scripts', () => {
  assert.deepEqual(createDbCoverageLaneCommands('runtime'), [
    ['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:coverage:db:runtime']],
  ]);
});

test('CI DB lane groups cover every DB unit manifest lane exactly once', () => {
  const manifestLaneNames = dbUnitLaneDefinitions.map((lane) => lane.name).sort();
  const ciManifestLanes = listCiDbLaneGroups()
    .flatMap((group) => group.manifestLanes)
    .sort();

  assert.deepEqual(ciManifestLanes, manifestLaneNames);
  assert.equal(new Set(ciManifestLanes).size, ciManifestLanes.length);
});

test('CI DB unit lanes run each manifest lane as its own shard', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
  const unitDbJob = extractWorkflowJob(workflow, 'unit-pr-db');

  assert.deepEqual(
    listCiDbLaneGroups().map((group) => [group.groupName, group.manifestLanes]),
    [
      ['repository', ['repository']],
      ['schema-migration', ['schema-migration']],
      ['queue', ['queue']],
      ['search', ['search']],
      ['integration', ['integration']],
    ]
  );
  assert.throws(() => createDbLaneCommands('remaining'), /Unknown DB lane: remaining/);
  assert.match(
    unitDbJob,
    /db-lane: \[repository, schema-migration, queue, search, integration\]/
  );
  assert.doesNotMatch(unitDbJob, /db-lane: \[repository, schema-migration, remaining\]/);
});

test('CI DB coverage lanes mirror the DB coverage manifest order', () => {
  assert.deepEqual(listCiDbCoverageLanes(), dbCoverageLaneDefinitions.laneOrder);
});

test('narrow DB provider changes select only the owning DB unit and coverage lanes', () => {
  const changedFiles = [
    'packages/db/__tests__/db-provider-initializing.test.tsx',
    'packages/db/src/db-provider-state-reset.ts',
    'packages/db/src/db-provider.tsx',
  ];

  assert.deepEqual(selectDbUnitCiLanes(changedFiles), ['integration']);
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), ['architecture']);
});

test('narrow DB repository test changes select only the repository DB unit and coverage lanes', () => {
  const changedFiles = ['packages/db/__tests__/turso-token-cache-store.test.ts'];

  assert.deepEqual(selectDbUnitCiLanes(changedFiles), ['repository']);
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), ['repositories']);
});

test('Turso repository implementation changes select repository DB lanes', () => {
  const changedFiles = [
    'packages/db/__tests__/turso-file-record-repository.test.ts',
    'packages/db/src/repositories/turso-file-record-repository.ts',
  ];

  assert.deepEqual(selectDbUnitCiLanes(changedFiles), ['repository']);
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), ['repositories']);
});

test('Turso schema baseline internals select only the owning DB lanes', () => {
  const changedFiles = [
    'packages/db/__tests__/turso-schema-baseline.test.ts',
    'packages/db/src/turso/schema-baseline.ts',
    'packages/db/src/turso/schema-ledger.ts',
  ];

  assert.deepEqual(selectDbUnitCiLanes(changedFiles), ['repository', 'search']);
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), ['repositories', 'search']);
});

test('Turso schema baseline internals do not expand dependent package unit shards', () => {
  const changedFiles = [
    'packages/db/__tests__/turso-schema-baseline.test.ts',
    'packages/db/src/turso/schema-baseline.ts',
  ];

  assert.equal(dbChangeRequiresDependentUnitExpansion(changedFiles), false);
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/db'], changedFiles), false);
});

test('chunk embedding job batch public wrapper keeps full DB unit and coverage surfaces', () => {
  const changedFiles = ['packages/db/src/chunk-embedding-job-batch.ts'];

  assert.deepEqual(
    selectDbUnitCiLanes(changedFiles),
    listCiDbLaneGroups().map((group) => group.groupName)
  );
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), listCiDbCoverageLanes());
});

test('chunk embedding job batch public wrapper expands dependent package unit shards', () => {
  const changedFiles = ['packages/db/src/chunk-embedding-job-batch.ts'];

  assert.equal(dbChangeRequiresDependentUnitExpansion(changedFiles), true);
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/db'], changedFiles), true);
});

test('chunk embedding job batch private implementation selects only queue-owned DB lanes', () => {
  const changedFiles = [
    'packages/db/__tests__/job-queue-turso-transactional-enqueue.test.ts',
    'packages/db/src/queue/chunk-embedding-job-batch-impl.ts',
  ];

  assert.deepEqual(selectDbUnitCiLanes(changedFiles), ['queue']);
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), ['queue']);
});

test('chunk embedding job batch private implementation does not expand dependent package unit shards', () => {
  const changedFiles = [
    'packages/db/__tests__/job-queue-turso-transactional-enqueue.test.ts',
    'packages/db/src/queue/chunk-embedding-job-batch-impl.ts',
  ];

  assert.equal(dbChangeRequiresDependentUnitExpansion(changedFiles), false);
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/db'], changedFiles), false);
});

test('chunk embedding job batch plus public DB exports still expands dependent unit shards', () => {
  const changedFiles = [
    'packages/db/src/queue/chunk-embedding-job-batch-impl.ts',
    'packages/db/src/index.ts',
  ];

  assert.equal(dbChangeRequiresDependentUnitExpansion(changedFiles), true);
  assert.equal(modeIncludesDependentPackages('packages', ['@brainstrike/db'], changedFiles), true);
});

test('shared DB repository implementation changes keep the full DB unit and coverage surfaces', () => {
  const changedFiles = ['packages/db/src/repositories/file-chunk-repository.ts'];

  assert.deepEqual(
    selectDbUnitCiLanes(changedFiles),
    listCiDbLaneGroups().map((group) => group.groupName)
  );
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), listCiDbCoverageLanes());
});

test('unknown DB source changes keep the full DB unit and coverage surfaces', () => {
  const changedFiles = ['packages/db/src/new-public-runtime.ts'];

  assert.deepEqual(
    selectDbUnitCiLanes(changedFiles),
    listCiDbLaneGroups().map((group) => group.groupName)
  );
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), listCiDbCoverageLanes());
});

test('mixed narrow and unknown DB changes keep the full DB unit and coverage surfaces', () => {
  const changedFiles = [
    'packages/db/__tests__/turso-token-cache-store.test.ts',
    'packages/db/src/repositories/turso-token-cache-store.ts',
    'packages/db/scripts/db-test-lane-manifest.mjs',
  ];

  assert.deepEqual(
    selectDbUnitCiLanes(changedFiles),
    listCiDbLaneGroups().map((group) => group.groupName)
  );
  assert.deepEqual(selectDbCoverageCiLanes(changedFiles), listCiDbCoverageLanes());
});

test('narrow DB lane selections preserve workflow matrix order', () => {
  const changedFiles = [
    'packages/db/__tests__/db-provider-initializing.test.tsx',
    'packages/db/__tests__/turso-token-cache-store.test.ts',
  ];

  assert.deepEqual(selectDbUnitCiLanes(changedFiles), ['repository', 'integration']);
});

test('runCommandSequence returns failure for a selected DB lane command', () => {
  const calls = [];
  const status = runCommandSequence(
    createDbLaneCommands('queue'),
    '/repo',
    'linux',
    (command, args) => {
      calls.push([command, args]);
      return { status: 1 };
    }
  );

  assert.equal(status, 1);
  assert.deepEqual(
    calls.map(([, args]) => args.at(-1)),
    ['test:db:queue']
  );
});

test('runCommandSequence runs every command before returning failure', () => {
  const calls = [];
  const status = runCommandSequence(
    [
      ['first-command', ['first-arg']],
      ['second-command', ['second-arg']],
    ],
    '/repo',
    'linux',
    (command, args) => {
      calls.push([command, args]);
      return { status: calls.length === 1 ? 1 : 0 };
    }
  );

  assert.equal(status, 1);
  assert.deepEqual(calls, [
    ['first-command', ['first-arg']],
    ['second-command', ['second-arg']],
  ]);
});

test('buildLanePackageNames rejects invalid lanes', () => {
  assert.throws(() => buildLanePackageNames(['@brainstrike/db'], 0, 4), /lane must be between 1 and 4/);
  assert.throws(() => buildLanePackageNames(['@brainstrike/db'], 5, 4), /lane must be between 1 and 4/);
});

test('unit aggregate job runs even when an affected shard fails', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');

  assert.match(workflow, /^  unit:\n    name: Unit\n    if: .*\balways\(\)/m);
  assert.match(workflow, /- name: Check affected unit shards\n        if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /- name: Push and manual unit tests\n        if: github\.event_name != 'pull_request'/);
});

test('coverage aggregate job preserves the required Coverage check over shards', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');

  assert.match(workflow, /^  coverage-pr-db:\n    name: Coverage DB /m);
  assert.match(workflow, /^  coverage-pr-packages:\n    name: Coverage packages /m);
  assert.match(workflow, /^  coverage:\n    name: Coverage\n    if: .*\balways\(\)/m);
  assert.match(workflow, /needs: \[coverage-pr-db, coverage-pr-packages\]/);
  assert.match(workflow, /pattern: coverage-shard-\*/);
  assert.match(workflow, /merge-multiple: true/);
});

test('unit and coverage shards skip idle build work', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
  const unitDbJob = extractWorkflowJob(workflow, 'unit-pr-db');
  const unitPackagesJob = extractWorkflowJob(workflow, 'unit-pr-packages');
  const coverageDbJob = extractWorkflowJob(workflow, 'coverage-pr-db');
  const coveragePackagesJob = extractWorkflowJob(workflow, 'coverage-pr-packages');

  assert.match(unitDbJob, /id: unit-plan/);
  assert.match(unitPackagesJob, /id: unit-plan/);
  assert.match(unitDbJob, /--github-output "\$GITHUB_OUTPUT"/);
  assert.match(unitPackagesJob, /--github-output "\$GITHUB_OUTPUT"/);
  assert.match(unitDbJob, /if: steps\.unit-plan\.outputs\.has_work == 'true'/);
  assert.match(unitPackagesJob, /if: steps\.unit-plan\.outputs\.has_work == 'true'/);
  assert.match(coverageDbJob, /--github-output "\$GITHUB_OUTPUT"/);
  assert.match(coveragePackagesJob, /--github-output "\$GITHUB_OUTPUT"/);
  assert.match(coverageDbJob, /if: steps\.coverage-plan\.outputs\.has_work == 'true'/);
  assert.match(coveragePackagesJob, /if: steps\.coverage-plan\.outputs\.has_work == 'true'/);
  assert.match(coverageDbJob, /find packages\/db .*coverage-db-\*.*cp --parents/s);
  assert.match(coveragePackagesJob, /find packages apps .*\/coverage\/coverage-final\.json.*cp --parents/s);
  assert.match(workflow, /path: coverage-shard\//);
  assert.match(workflow, /coverage-shard\/marker-db-/);
  assert.match(workflow, /coverage-shard\/marker-packages-/);
  assert.doesNotMatch(workflow, /coverage-shard\/\.marker-/);
  assert.doesNotMatch(workflow, /continue-on-error: true/);
});

test('unit and coverage shards build only planned lane package dependency graphs', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8');
  const unitDbJob = extractWorkflowJob(workflow, 'unit-pr-db');
  const unitPackagesJob = extractWorkflowJob(workflow, 'unit-pr-packages');
  const coverageDbJob = extractWorkflowJob(workflow, 'coverage-pr-db');
  const coveragePackagesJob = extractWorkflowJob(workflow, 'coverage-pr-packages');

  assert.match(
    unitDbJob,
    /pnpm turbo run build \$\{\{ steps\.unit-plan\.outputs\.build_filters \}\} --concurrency=4/
  );
  assert.match(
    unitPackagesJob,
    /pnpm turbo run build \$\{\{ steps\.unit-plan\.outputs\.build_filters \}\} --concurrency=4/
  );
  assert.match(
    coverageDbJob,
    /pnpm turbo run build \$\{\{ steps\.coverage-plan\.outputs\.build_filters \}\} --concurrency=4/
  );
  assert.match(
    coveragePackagesJob,
    /pnpm turbo run build \$\{\{ steps\.coverage-plan\.outputs\.build_filters \}\} --concurrency=4/
  );
  assert.doesNotMatch(unitDbJob, /pnpm turbo run build --concurrency=4/);
  assert.doesNotMatch(unitPackagesJob, /pnpm turbo run build --concurrency=4/);
  assert.doesNotMatch(coverageDbJob, /pnpm turbo run build --concurrency=4/);
  assert.doesNotMatch(coveragePackagesJob, /pnpm turbo run build --concurrency=4/);
});
