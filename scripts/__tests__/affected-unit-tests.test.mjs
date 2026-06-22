import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildLanePackageNames,
  buildPackageLanePackageNames,
  buildWeightedPackageLanes,
  createDbLaneCommands,
  filterTestablePackages,
  parsePnpmListJson,
} from '../affected-unit-tests.mjs';

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

test('createDbLaneCommands maps DB lanes to existing package scripts', () => {
  assert.deepEqual(createDbLaneCommands('repository'), [['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:repository']]]);
  assert.deepEqual(createDbLaneCommands('schema-migration'), [['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:schema-migration']]]);
  assert.deepEqual(createDbLaneCommands('remaining'), [
    ['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:queue']],
    ['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:search']],
    ['pnpm', ['--filter', '@brainstrike/db', 'run', 'test:db:integration']],
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
