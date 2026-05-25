import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseRequiredPrGateEnv,
  verifyRequiredPrGate,
} from '../ci-required-pr-gate.mjs';

function needsWith(overrides = {}) {
  return {
    'browser-tests': { result: 'skipped' },
    checks: { result: 'skipped' },
    'desktop-e2e-pr': { result: 'skipped' },
    'docs-static': { result: 'skipped' },
    'merge-reports': { result: 'skipped' },
    plan: { result: 'success' },
    'prepare-desktop': { result: 'skipped' },
    'prepare-web': { result: 'skipped' },
    unit_affected: { result: 'skipped' },
    unit_coverage: { result: 'skipped' },
    'web-e2e-pr': { result: 'skipped' },
    ...overrides,
  };
}

test('verifyRequiredPrGate passes a docs-only plan with only plan and docs-static', () => {
  assert.deepEqual(
    verifyRequiredPrGate({
      needs: needsWith({ 'docs-static': { result: 'success' } }),
      requiredJobs: ['plan', 'docs-static'],
    }),
    []
  );
});

test('verifyRequiredPrGate passes selected web and unit jobs', () => {
  assert.deepEqual(
    verifyRequiredPrGate({
      needs: needsWith({
        checks: { result: 'success' },
        'merge-reports': { result: 'success' },
        'prepare-web': { result: 'success' },
        unit_affected: { result: 'success' },
        'web-e2e-pr': { result: 'success' },
      }),
      requiredJobs: ['plan', 'checks', 'unit_affected', 'prepare-web', 'web-e2e-pr', 'merge-reports'],
    }),
    []
  );
});

test('verifyRequiredPrGate fails when a selected job is skipped', () => {
  const failures = verifyRequiredPrGate({
    needs: needsWith({ checks: { result: 'success' } }),
    requiredJobs: ['plan', 'checks', 'unit_affected'],
  });

  assert.match(failures.join('\n'), /unit_affected: skipped/);
});

test('verifyRequiredPrGate fails when plan is not required', () => {
  assert.deepEqual(
    verifyRequiredPrGate({
      needs: needsWith(),
      requiredJobs: ['checks'],
    }),
    [
      'CI Plan did not mark plan as required',
      'checks: skipped',
      'plan: ran successfully but was not selected by CI Plan',
    ]
  );
});

test('verifyRequiredPrGate catches failed unselected jobs', () => {
  const failures = verifyRequiredPrGate({
    needs: needsWith({ 'prepare-web': { result: 'failure' } }),
    requiredJobs: ['plan'],
  });

  assert.match(failures.join('\n'), /prepare-web: failure/);
});

test('verifyRequiredPrGate reports selected terminal failures once', () => {
  assert.deepEqual(
    verifyRequiredPrGate({
      needs: needsWith({ checks: { result: 'failure' } }),
      requiredJobs: ['plan', 'checks'],
    }),
    ['checks: failure']
  );
});

test('verifyRequiredPrGate fails closed if an unselected job ran', () => {
  const failures = verifyRequiredPrGate({
    needs: needsWith({ unit_coverage: { result: 'success' } }),
    requiredJobs: ['plan'],
  });

  assert.match(failures.join('\n'), /unit_coverage: ran successfully but was not selected by CI Plan/);
});

test('parseRequiredPrGateEnv reads workflow outputs from environment', () => {
  assert.deepEqual(
    parseRequiredPrGateEnv({
      REQUIRED_JOBS_JSON: JSON.stringify(['plan', 'checks']),
      REQUIRED_NEEDS: JSON.stringify(needsWith()),
    }),
    {
      needs: needsWith(),
      requiredJobs: ['plan', 'checks'],
    }
  );
});

test('parseRequiredPrGateEnv rejects missing plan output', () => {
  assert.throws(
    () => parseRequiredPrGateEnv({ REQUIRED_NEEDS: JSON.stringify(needsWith()) }),
    /REQUIRED_JOBS_JSON is required/
  );
});

test('parseRequiredPrGateEnv rejects malformed needs with useful context', () => {
  assert.throws(
    () =>
      parseRequiredPrGateEnv({
        REQUIRED_JOBS_JSON: JSON.stringify(['plan']),
        REQUIRED_NEEDS: '{not-json',
      }),
    /REQUIRED_NEEDS must be a GitHub needs JSON object/
  );
});

test('parseRequiredPrGateEnv validates needs result shape', () => {
  assert.throws(
    () =>
      parseRequiredPrGateEnv({
        REQUIRED_JOBS_JSON: JSON.stringify(['plan']),
        REQUIRED_NEEDS: JSON.stringify({ plan: {} }),
      }),
    /expected plan to include a string result/
  );
});
