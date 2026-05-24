import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildDoctorReport,
  parseDoctorArgs,
  validateCleanWorktree,
  validateDoctorLabels,
} from '../ci-doctor.mjs';

const selection = {
  base: 'origin/main',
  head: 'HEAD',
  files: ['packages/ui/src/prompt-management/components/prompt-card.tsx'],
  labels: ['ci:unit'],
  commands: [
    {
      name: 'diff-check',
      command: 'git diff --check',
      budgetMs: 30_000,
      owner: 'tooling',
    },
    {
      name: 'ui-tests',
      command: 'pnpm --filter @brainstrike/ui test',
      budgetMs: 180_000,
      owner: 'shared-foundation',
    },
  ],
  budget: {
    target: 'local-pr-risk',
    targetMs: 480_000,
    totalMs: 210_000,
    status: 'within-target',
  },
};

test('parseDoctorArgs accepts labels for local PR label validation', () => {
  assert.deepEqual(parseDoctorArgs(['--labels', 'ci:unit,bug']), {
    base: 'origin/main',
    format: 'text',
    head: 'HEAD',
    labels: 'ci:unit,bug',
  });
});

test('validateDoctorLabels fails closed on extra risk labels', () => {
  assert.deepEqual(validateDoctorLabels(selection, 'ci:unit,ci:web-e2e'), [
    'unexpected PR label ci:web-e2e; selected labels are ci:unit',
  ]);
});

test('validateCleanWorktree blocks misleading dirty-worktree reports', () => {
  assert.deepEqual(validateCleanWorktree(''), []);
  assert.deepEqual(validateCleanWorktree(' M AGENTS.md\n?? scripts/ci-doctor.mjs\n'), [
    'ci:doctor only evaluates committed changes; commit or stash dirty files first:\n M AGENTS.md\n?? scripts/ci-doctor.mjs',
  ]);
});

test('buildDoctorReport tells developers the selected safe path', () => {
  const report = buildDoctorReport(selection, []);

  assert.match(report, /Selected PR labels:\n  ci:unit/);
  assert.match(report, /Allowed local proof commands:\n  diff-check/);
  assert.match(report, /ui-tests/);
  assert.match(report, /Do not run broad E2E or add broad ci labels/);
});

test('buildDoctorReport includes label failures before command guidance', () => {
  const report = buildDoctorReport(selection, [
    'unexpected PR label ci:web-e2e; selected labels are ci:unit',
  ]);

  assert.match(report, /Label problems:/);
  assert.match(report, /unexpected PR label ci:web-e2e/);
});
