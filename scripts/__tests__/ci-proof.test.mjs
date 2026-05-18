import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildProofManifest,
  parseProofArgs,
  validateProofManifest,
  verifyLabels,
  verifyProofTipDiff,
} from '../ci-proof.mjs';

test('parseProofArgs requires known mode', () => {
  assert.throws(
    () => parseProofArgs(['unknown']),
    /mode must be prove or verify-proof/
  );
});

test('parseProofArgs accepts an empty labels value for PRs without labels', () => {
  assert.deepEqual(parseProofArgs(['verify-proof', '--labels', '']), {
    base: 'origin/main',
    head: 'HEAD',
    labels: '',
    mode: 'verify-proof',
    proof: '.ci/proof/latest.json',
  });
});

test('buildProofManifest records successful baseline and selected commands', () => {
  const manifest = buildProofManifest({
    commandResults: [
      { command: 'pnpm lint:ci', durationMs: 1, exitCode: 0, name: 'lint-ci' },
      {
        command: 'pnpm type-check',
        durationMs: 1,
        exitCode: 0,
        name: 'type-check',
      },
      { command: 'pnpm build', durationMs: 1, exitCode: 0, name: 'build' },
      {
        command:
          'TURBO_TEST_MODE=unit pnpm exec turbo run test --summarize --log-order=grouped --concurrency=2',
        durationMs: 1,
        exitCode: 0,
        name: 'unit',
      },
    ],
    generatedAt: '2026-05-18T12:00:00.000Z',
    nodeVersion: 'v24.0.0',
    packageManager: 'pnpm@10.33.0',
    pnpmVersion: '10.33.0',
    selection: {
      base: 'origin/main',
      baseSha: '1',
      commands: [],
      expandedLanes: [],
      files: [],
      head: 'HEAD',
      headSha: '2',
      labels: [],
      lanes: [],
      mergeBase: '1',
    },
    testedHeadSha: '2222222222222222222222222222222222222222',
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(validateProofManifest(manifest).length, 0);
});

test('validateProofManifest rejects failed command results', () => {
  const failures = validateProofManifest({
    schemaVersion: 1,
    commandResults: [{ command: 'pnpm build', exitCode: 1, name: 'build' }],
    generatedAt: '2026-05-18T12:00:00.000Z',
    packageManager: 'pnpm@10.33.0',
    pnpmVersion: '10.33.0',
    selection: { labels: [], commands: [] },
    testedHeadSha: '2222222222222222222222222222222222222222',
  });

  assert.match(failures.join('\n'), /command build failed/);
});

test('verifyLabels requires every selected risk label', () => {
  assert.deepEqual(verifyLabels(['ci:browser', 'ci:coverage'], ['ci:browser']), [
    'missing required PR label ci:coverage',
  ]);
});

test('verifyProofTipDiff only allows the proof manifest after tested head', () => {
  assert.deepEqual(verifyProofTipDiff(['.ci/proof/latest.json']), []);
  assert.deepEqual(
    verifyProofTipDiff(['.ci/proof/latest.json', 'src/app.ts']),
    ['proof is stale: src/app.ts changed after testedHeadSha']
  );
});
