import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDbCoverageLaneMap,
  buildDbUnitLaneMap,
} from '../../packages/db/scripts/db-test-lane-manifest.mjs';

test('shared DB lane manifest reports synthetic tests without unit lane ownership', () => {
  const tests = ['known-db-test.test.ts', 'synthetic-new-db-test.test.ts'];

  assert.deepEqual(
    buildDbUnitLaneMap(tests, [
      { matches: [/^known-db-test\.test\.ts$/], name: 'schema-migration' },
    ]).failures,
    ['synthetic-new-db-test.test.ts matched 0 DB test lanes: ']
  );
});

test('coverage lanes report unit-owned tests without a coverage default', () => {
  assert.deepEqual(
    buildDbCoverageLaneMap(['known-db-test.test.ts'], {
      coverageDefaultsByUnitLane: {},
      laneOrder: ['architecture'],
      unitLaneDefinitions: [{ matches: [/^known-db-test\.test\.ts$/], name: 'schema-migration' }],
    }).failures,
    [
      'Test known-db-test.test.ts has no coverage default for DB unit lane schema-migration.',
      'Lane architecture has no tests.',
    ]
  );
});

test('coverage lanes reject default coverage targets outside laneOrder', () => {
  const { failures, laneMap } = buildDbCoverageLaneMap(['migration-a.test.ts'], {
    coverageDefaultsByUnitLane: {
      'schema-migration': 'migrationz',
    },
    laneOrder: ['migrations'],
    unitLaneDefinitions: [{ matches: [/^migration-a\.test\.ts$/], name: 'schema-migration' }],
  });

  assert.deepEqual(failures, [
    'Coverage default for DB unit lane schema-migration references unknown coverage lane migrationz.',
    'Test migration-a.test.ts maps to unknown coverage lane migrationz.',
    'Lane migrations has no tests.',
  ]);
  assert.deepEqual([...laneMap.entries()], [['migrations', []]]);
});

test('coverage lanes reject coverage override keys outside laneOrder', () => {
  const { failures, laneMap } = buildDbCoverageLaneMap(['worker-a.test.ts'], {
    coverageDefaultsByUnitLane: {
      integration: 'architecture',
    },
    coverageOverridesByLane: {
      runtimee: ['worker-a.test.ts'],
    },
    laneOrder: ['architecture', 'runtime'],
    unitLaneDefinitions: [{ matches: [/^worker-a\.test\.ts$/], name: 'integration' }],
  });

  assert.deepEqual(failures, [
    'Coverage override references unknown coverage lane runtimee.',
    'Test worker-a.test.ts maps to unknown coverage lane runtimee.',
    'Lane architecture has no tests.',
    'Lane runtime has no tests.',
  ]);
  assert.deepEqual(
    [...laneMap.entries()],
    [
      ['architecture', []],
      ['runtime', []],
    ]
  );
});

test('coverage lanes derive from unit lane ownership unless a coverage override is declared', () => {
  const { failures, laneMap } = buildDbCoverageLaneMap(
    ['migration-a.test.ts', 'queue-a.test.ts', 'worker-a.test.ts'],
    {
      coverageDefaultsByUnitLane: {
        queue: 'queue',
        'schema-migration': 'migrations',
      },
      coverageOverridesByLane: {
        runtime: ['worker-a.test.ts'],
      },
      laneOrder: ['migrations', 'queue', 'runtime'],
      unitLaneDefinitions: [
        { matches: [/^queue-a\.test\.ts$/], name: 'queue' },
        { matches: [/^migration-a\.test\.ts$/], name: 'schema-migration' },
        { matches: [/^worker-a\.test\.ts$/], name: 'integration' },
      ],
    }
  );

  assert.deepEqual(failures, []);
  assert.deepEqual(
    [...laneMap.entries()],
    [
      ['migrations', ['migration-a.test.ts']],
      ['queue', ['queue-a.test.ts']],
      ['runtime', ['worker-a.test.ts']],
    ]
  );
});
