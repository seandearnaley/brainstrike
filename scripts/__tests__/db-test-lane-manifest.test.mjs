import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDbCoverageLaneMap,
  buildDbUnitLaneMap,
} from '../../packages/db/scripts/db-test-lane-manifest.mjs';

test('shared DB lane manifest reports synthetic tests without unit lane ownership', () => {
  const tests = ['known-db-test.test.ts', 'synthetic-new-db-test.test.ts'];

  assert.deepEqual(
    buildDbUnitLaneMap(tests, [{ name: 'schema-migration', matches: [/^known-db-test\.test\.ts$/] }])
      .failures,
    ['synthetic-new-db-test.test.ts matched 0 DB test lanes: ']
  );
});

test('coverage lanes report unit-owned tests without a coverage default', () => {
  assert.deepEqual(
    buildDbCoverageLaneMap(['known-db-test.test.ts'], {
      coverageDefaultsByUnitLane: {},
      laneOrder: ['architecture'],
      unitLaneDefinitions: [{ name: 'schema-migration', matches: [/^known-db-test\.test\.ts$/] }],
    }).failures,
    [
      'Test known-db-test.test.ts has no coverage default for DB unit lane schema-migration.',
      'Lane architecture has no tests.',
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
        { name: 'queue', matches: [/^queue-a\.test\.ts$/] },
        { name: 'schema-migration', matches: [/^migration-a\.test\.ts$/] },
        { name: 'integration', matches: [/^worker-a\.test\.ts$/] },
      ],
    }
  );

  assert.deepEqual(failures, []);
  assert.deepEqual([...laneMap.entries()], [
    ['migrations', ['migration-a.test.ts']],
    ['queue', ['queue-a.test.ts']],
    ['runtime', ['worker-a.test.ts']],
  ]);
});
