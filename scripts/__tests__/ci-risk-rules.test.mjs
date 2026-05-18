import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  expandRiskLanes,
  selectRiskLanesForFiles,
  toRiskLabels,
} from '../ci-risk-rules.mjs';

test('docs-only changes select no cloud risk lanes', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['apps/docs/docs/development/local-ci.md']),
    []
  );
});

test('workflow and CI script changes select the full lane', () => {
  assert.deepEqual(
    selectRiskLanesForFiles([
      '.github/workflows/test.yml',
      'scripts/check-ci-workflow-contracts.mjs',
    ]),
    ['ci:full']
  );
  assert.deepEqual(expandRiskLanes(['ci:full']), [
    'ci:browser',
    'ci:web-e2e',
    'ci:desktop',
    'ci:embedding',
    'ci:coverage',
  ]);
});

test('browser storage changes select browser and coverage lanes', () => {
  assert.deepEqual(selectRiskLanesForFiles(['packages/storage/src/opfs.ts']), [
    'ci:browser',
    'ci:coverage',
  ]);
});

test('desktop host changes select desktop and embedding lanes', () => {
  assert.deepEqual(
    selectRiskLanesForFiles(['apps/desktop/src/embedding-host-manager.ts']),
    ['ci:desktop', 'ci:embedding', 'ci:coverage']
  );
});

test('web app changes select web e2e and coverage lanes', () => {
  assert.deepEqual(selectRiskLanesForFiles(['apps/web/src/App.tsx']), [
    'ci:web-e2e',
    'ci:coverage',
  ]);
});

test('new runtime app changes fall back to coverage', () => {
  assert.deepEqual(selectRiskLanesForFiles(['apps/new-app/src/index.ts']), [
    'ci:coverage',
  ]);
});

test('risk labels match lane names', () => {
  assert.deepEqual(toRiskLabels(['ci:browser', 'ci:desktop']), [
    'ci:browser',
    'ci:desktop',
  ]);
});
