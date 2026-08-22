import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateContractEvidence } from '../run-script-contracts.mjs';

test('accepts an inventory contract with a non-skipped passing test', () => {
  const issues = validateContractEvidence(
    ['scripts/__tests__/example-guard.test.mjs'],
    [
      {
        data: {
          details: { type: 'test' },
          file: '/repo/scripts/__tests__/example-guard.test.mjs',
          name: 'negative control',
        },
        type: 'test:pass',
      },
    ],
    '/repo'
  );

  assert.deepEqual(issues, []);
});

test('rejects an inventory contract whose tests are all skipped', () => {
  const issues = validateContractEvidence(
    ['scripts/__tests__/example-guard.test.mjs'],
    [
      {
        data: {
          details: { type: 'suite' },
          file: '/repo/scripts/__tests__/example-guard.test.mjs',
          name: 'all controls',
        },
        type: 'test:pass',
      },
      {
        data: {
          details: { type: 'test' },
          file: '/repo/scripts/__tests__/example-guard.test.mjs',
          name: 'negative control',
          skip: 'disabled for this environment',
        },
        type: 'test:pass',
      },
    ],
    '/repo'
  );

  assert.deepEqual(issues, [
    'scripts/__tests__/example-guard.test.mjs: inventory contract has no non-skipped passing test',
  ]);
});
