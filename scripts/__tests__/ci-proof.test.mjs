import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildProofManifest,
  defaultRunner,
  normalizeRepositoryIdentifier,
  parseProofArgs,
  prove,
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
    repository: 'seandearnaley/brainstrike',
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

test('normalizeRepositoryIdentifier extracts GitHub owner and repo', () => {
  assert.equal(
    normalizeRepositoryIdentifier('git@github.com:seandearnaley/brainstrike.git\n'),
    'seandearnaley/brainstrike'
  );
  assert.equal(
    normalizeRepositoryIdentifier('https://github.com/seandearnaley/brainstrike.git'),
    'seandearnaley/brainstrike'
  );
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

test('prove reports the failing proof command name', async () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const runner = async (command, args, options = {}) => {
    if (options.shell === true) {
      throw new Error('exit 1');
    }
    if (command === 'git' && args.join(' ') === 'status --porcelain') {
      return '';
    }
    if (command === 'git' && args.join(' ') === 'merge-base origin/main HEAD') {
      return `${baseSha}\n`;
    }
    if (command === 'git' && args.join(' ') === 'rev-parse origin/main') {
      return `${baseSha}\n`;
    }
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
      return `${headSha}\n`;
    }
    if (
      command === 'git' &&
      args.join(' ') ===
        `diff --name-only --diff-filter=ACMRTUXB ${baseSha} HEAD`
    ) {
      return 'apps/docs/docs/development/local-ci.md\n';
    }
    if (command === 'git' && args.join(' ') === 'remote get-url origin') {
      return 'git@github.com:seandearnaley/brainstrike.git\n';
    }
    if (command === 'pnpm' && args.join(' ') === '--version') {
      return '10.33.0\n';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  await assert.rejects(
    () => prove({ base: 'origin/main', head: 'HEAD' }, runner),
    /proof command "lint-ci" failed: exit 1/
  );
});

test('defaultRunner rejects shell args before dropping them', async () => {
  await assert.rejects(
    () => defaultRunner('node', ['--version'], { shell: true }),
    /args must be empty when shell is true/
  );
});
