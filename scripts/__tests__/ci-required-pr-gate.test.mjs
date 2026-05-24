import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseRequiredPrGateEnv,
  verifyRequiredPrGate,
} from '../ci-required-pr-gate.mjs';

function needsWith(overrides = {}) {
  return {
    'browser-tests': { result: 'skipped' },
    checks: { result: 'success' },
    'desktop-e2e-pr': { result: 'skipped' },
    'desktop-e2e-embedding-pr': { result: 'skipped' },
    'desktop-e2e-smoke-pr': { result: 'skipped' },
    'desktop-e2e-ipc-reset-pr': { result: 'skipped' },
    'desktop-e2e-runtime-hosts-pr': { result: 'skipped' },
    'desktop-e2e-db-storage-pr': { result: 'skipped' },
    e2e: { result: 'skipped' },
    'e2e-destructive': { result: 'skipped' },
    'e2e-stateful': { result: 'skipped' },
    'pr-sentinel': { result: 'success' },
    'prepare-desktop': { result: 'skipped' },
    'prepare-web': { result: 'skipped' },
    unit_affected: { result: 'skipped' },
    unit_coverage: { result: 'skipped' },
    'web-e2e-assistant-state-pr': { result: 'skipped' },
    'web-e2e-db-startup-pr': { result: 'skipped' },
    'web-e2e-destructive-reset-pr': { result: 'skipped' },
    'web-e2e-file-explorer-persistence-pr': { result: 'skipped' },
    'web-e2e-import-indexing-pr': { result: 'skipped' },
    'web-e2e-settings-state-pr': { result: 'skipped' },
    'web-e2e-smoke-pr': { result: 'skipped' },
    ...overrides,
  };
}

test('verifyRequiredPrGate fails ci:full when expanded lane jobs are skipped', () => {
  const failures = verifyRequiredPrGate({
    needs: needsWith(),
    requiredLabels: ['ci:full'],
    requiredLanes: [
      'ci:browser',
      'ci:web-smoke',
      'ci:web-file-explorer-persistence',
      'ci:web-import-indexing',
      'ci:web-assistant-state',
      'ci:web-settings-state',
      'ci:web-db-startup',
      'ci:web-destructive-reset',
      'ci:web-e2e',
      'ci:desktop-smoke',
      'ci:desktop-ipc-reset',
      'ci:desktop-runtime-hosts',
      'ci:desktop-db-storage',
      'ci:desktop',
      'ci:embedding',
      'ci:unit',
      'ci:coverage-db',
      'ci:coverage-full',
    ],
  });

  assert.match(failures.join('\n'), /ci:browser requires browser-tests, got skipped/);
  assert.match(failures.join('\n'), /ci:desktop requires desktop-e2e-pr, got skipped/);
  assert.match(failures.join('\n'), /ci:unit requires unit_affected, got skipped/);
});

test('verifyRequiredPrGate passes a narrow lane when its jobs succeeded', () => {
  assert.deepEqual(
    verifyRequiredPrGate({
      needs: needsWith({
        'prepare-web': { result: 'success' },
        'web-e2e-smoke-pr': { result: 'success' },
      }),
      requiredLabels: ['ci:web-smoke'],
      requiredLanes: ['ci:web-smoke'],
    }),
    []
  );
});

test('verifyRequiredPrGate fails closed when labels have no expanded lanes', () => {
  assert.deepEqual(
    verifyRequiredPrGate({
      needs: needsWith(),
      requiredLabels: ['ci:full'],
      requiredLanes: [],
    }),
    ['PR Sentinel selected labels ci:full but produced no expanded lanes']
  );
});

test('verifyRequiredPrGate fails closed on unmapped expanded lanes', () => {
  assert.deepEqual(
    verifyRequiredPrGate({
      needs: needsWith(),
      requiredLabels: ['ci:unknown'],
      requiredLanes: ['ci:unknown'],
    }),
    ['expanded lane ci:unknown has no Required PR Gate job mapping']
  );
});

test('parseRequiredPrGateEnv reads workflow outputs from environment', () => {
  assert.deepEqual(
    parseRequiredPrGateEnv({
      REQUIRED_EXPANDED_LANES: 'ci:unit,ci:browser',
      REQUIRED_LABELS: 'ci:full',
      REQUIRED_NEEDS: JSON.stringify(needsWith()),
    }),
    {
      needs: needsWith(),
      requiredLabels: ['ci:full'],
      requiredLanes: ['ci:unit', 'ci:browser'],
    }
  );
});
