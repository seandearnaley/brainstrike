import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDbCoverageLaneMap,
  buildDbUnitLaneMap,
} from '../../packages/db/scripts/db-test-lane-manifest.mjs';

test('shared DB lane manifest reports synthetic unassigned tests for unit and coverage lanes', () => {
  const tests = ['known-db-test.test.ts', 'synthetic-new-db-test.test.ts'];

  assert.deepEqual(
    buildDbUnitLaneMap(tests, [{ name: 'schema-migration', matches: [/^known-db-test\.test\.ts$/] }])
      .failures,
    ['synthetic-new-db-test.test.ts matched 0 DB test lanes: ']
  );
  assert.deepEqual(buildDbCoverageLaneMap(tests, { architecture: ['known-db-test.test.ts'] }).failures, [
    'Test synthetic-new-db-test.test.ts is not assigned to a coverage lane.',
  ]);
});
