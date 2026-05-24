import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifySelectorSelection } from '../ci-selector-guard.mjs';

function selection(overrides = {}) {
  return {
    riskProfile: {
      category: 'config-tooling',
      cloudLabels: ['ci:unit'],
    },
    labels: ['ci:unit'],
    lanes: ['ci:unit'],
    commands: [{ name: 'diff-check' }, { name: 'ci-script-tests' }],
    ...overrides,
  };
}

test('verifySelectorSelection accepts internally consistent selected labels', () => {
  assert.deepEqual(verifySelectorSelection(selection()), []);
});

test('verifySelectorSelection rejects profile and label disagreement', () => {
  assert.deepEqual(
    verifySelectorSelection(
      selection({
        riskProfile: {
          category: 'config-tooling',
          cloudLabels: ['ci:web-e2e', 'ci:unit'],
        },
      })
    ),
    [
      'risk profile and selected labels disagree: profile=ci:web-e2e,ci:unit labels=ci:unit',
    ]
  );
});

test('verifySelectorSelection rejects labels and lanes disagreement', () => {
  assert.deepEqual(
    verifySelectorSelection(
      selection({
        lanes: ['ci:web-e2e', 'ci:unit'],
      })
    ),
    ['selection labels and lanes disagree: labels=ci:unit lanes=ci:web-e2e,ci:unit']
  );
});

test('verifySelectorSelection rejects e2e proof commands without their cloud label', () => {
  assert.deepEqual(
    verifySelectorSelection(
      selection({
        commands: [{ name: 'diff-check' }, { name: 'web-full-regression-tests' }],
      })
    ),
    ['web-full-regression-tests requires ci:web-e2e, but selected labels are ci:unit']
  );
});

test('verifySelectorSelection rejects docs-only cloud labels', () => {
  assert.deepEqual(
    verifySelectorSelection(
      selection({
        riskProfile: {
          category: 'docs-only',
          cloudLabels: ['ci:unit'],
        },
        labels: ['ci:unit'],
        lanes: ['ci:unit'],
        commands: [{ name: 'diff-check' }, { name: 'docs-static' }],
      })
    ),
    ['docs-only selection must not request cloud labels: ci:unit']
  );
});
