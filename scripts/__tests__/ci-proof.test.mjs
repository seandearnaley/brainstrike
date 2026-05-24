import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSelection } from '../ci-select.mjs';
import {
  buildProofManifest,
  defaultRunner,
  normalizeRepositoryIdentifier,
  parseProofArgs,
  prove,
  validateProofManifest,
  verifyLabels,
  verifyProof,
  verifyProofTipDiff,
} from '../ci-proof.mjs';

function successfulResult(name, command, owner = 'tooling') {
  return {
    budgetMs: 30_000,
    budgetStatus: 'ok',
    command,
    durationMs: 1,
    exitCode: 0,
    name,
    owner,
  };
}

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

test('parseProofArgs explicit mode is independent of invoked filename', () => {
  assert.deepEqual(parseProofArgs(['verify-proof'], '/tmp/ci-prove.mjs'), {
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
      successfulResult('lint-ci', 'pnpm lint:ci'),
      successfulResult('type-check', 'pnpm type-check'),
      successfulResult('build', 'pnpm build'),
      successfulResult(
        'unit',
        'TURBO_TEST_MODE=unit pnpm exec turbo run test --summarize --log-order=grouped --concurrency=2'
      ),
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
      budget: {
        target: 'fast-local',
        targetMs: 120_000,
        totalMs: 60_000,
        status: 'within-target',
      },
      riskProfile: {
        category: 'docs-only',
        cloudLabels: [],
        domains: ['documentation'],
        e2eLanes: [],
        proofCommands: ['diff-check', 'docs-static'],
        riskLevel: 'low',
      },
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
    selection: {
      labels: [],
      commands: [],
      budget: {
        target: 'fast-local',
        targetMs: 120_000,
        totalMs: 60_000,
        status: 'within-target',
      },
      riskProfile: {
        category: 'docs-only',
        cloudLabels: [],
        domains: ['documentation'],
        e2eLanes: [],
        proofCommands: ['diff-check', 'docs-static'],
        riskLevel: 'low',
      },
    },
    testedHeadSha: '2222222222222222222222222222222222222222',
  });

  assert.match(failures.join('\n'), /command build failed/);
});

test('validateProofManifest rejects invalid tested head SHAs', () => {
  const failures = validateProofManifest({
    schemaVersion: 1,
    commandResults: [],
    generatedAt: '2026-05-18T12:00:00.000Z',
    packageManager: 'pnpm@10.33.0',
    pnpmVersion: '10.33.0',
    repository: 'seandearnaley/brainstrike',
    selection: {
      labels: [],
      commands: [],
      budget: {
        target: 'fast-local',
        targetMs: 120_000,
        totalMs: 60_000,
        status: 'within-target',
      },
      riskProfile: {
        category: 'docs-only',
        cloudLabels: [],
        domains: ['documentation'],
        e2eLanes: [],
        proofCommands: ['diff-check', 'docs-static'],
        riskLevel: 'low',
      },
    },
    testedHeadSha: 'abc\nextra-output=injected',
  });

  assert.match(
    failures.join('\n'),
    /testedHeadSha must be a 40-character hex SHA/
  );
});

test('validateProofManifest requires a recorded risk profile', () => {
  const failures = validateProofManifest({
    schemaVersion: 1,
    commandResults: [],
    generatedAt: '2026-05-18T12:00:00.000Z',
    packageManager: 'pnpm@10.33.0',
    pnpmVersion: '10.33.0',
    repository: 'seandearnaley/brainstrike',
    selection: { labels: [], commands: [] },
    testedHeadSha: '2222222222222222222222222222222222222222',
  });

  assert.match(failures.join('\n'), /selection\.riskProfile must be an object/);
});

test('validateProofManifest requires a recorded selection budget', () => {
  const failures = validateProofManifest({
    schemaVersion: 1,
    commandResults: [],
    generatedAt: '2026-05-18T12:00:00.000Z',
    packageManager: 'pnpm@10.33.0',
    pnpmVersion: '10.33.0',
    repository: 'seandearnaley/brainstrike',
    selection: {
      labels: [],
      commands: [],
      riskProfile: {
        category: 'docs-only',
        cloudLabels: [],
        domains: ['documentation'],
        e2eLanes: [],
        proofCommands: ['diff-check', 'docs-static'],
        riskLevel: 'low',
      },
    },
    testedHeadSha: '2222222222222222222222222222222222222222',
  });

  assert.match(failures.join('\n'), /selection\.budget must be an object/);
});

test('verifyLabels requires every selected risk label', () => {
  assert.deepEqual(verifyLabels(['ci:browser', 'ci:coverage'], ['ci:browser']), [
    'missing required PR label ci:coverage',
  ]);
});

test('verifyLabels rejects extra risk labels that would over-select CI', () => {
  assert.deepEqual(verifyLabels(['ci:unit'], ['ci:unit', 'ci:web-e2e']), [
    'unexpected PR label ci:web-e2e; selected labels are ci:unit',
  ]);
});

test('verifyLabels ignores non-risk PR labels', () => {
  assert.deepEqual(verifyLabels(['ci:unit'], ['ci:unit', 'bug', 'ready']), []);
});

test('verifyProofTipDiff only allows the proof manifest after tested head', () => {
  assert.deepEqual(verifyProofTipDiff(['.ci/proof/latest.json']), []);
  assert.deepEqual(
    verifyProofTipDiff(['.ci/proof/latest.json', 'src/app.ts']),
    ['proof is stale: src/app.ts changed after testedHeadSha']
  );
});

test('verifyProofTipDiff allows custom proof manifest paths', () => {
  assert.deepEqual(
    verifyProofTipDiff(['custom/proof.json'], 'custom/proof.json'),
    []
  );
  assert.deepEqual(
    verifyProofTipDiff(['custom/proof.json', 'src/app.ts'], 'custom/proof.json'),
    ['proof is stale: src/app.ts changed after testedHeadSha']
  );
});

test('verifyProof rejects stale command definitions', async () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const selection = buildSelection({
    base: 'origin/main',
    baseSha,
    files: ['apps/docs/docs/development/local-ci.md'],
    head: headSha,
    headSha,
    mergeBase: baseSha,
  });
  const staleSelection = {
    ...selection,
    commands: selection.commands.map((command, index) =>
      index === 0 ? { ...command, command: 'pnpm stale-lint' } : command
    ),
  };
  const manifest = buildProofManifest({
    commandResults: staleSelection.commands.map((command) => ({
      budgetMs: command.budgetMs,
      budgetStatus: 'ok',
      command: command.command,
      durationMs: 1,
      exitCode: 0,
      name: command.name,
      owner: command.owner,
    })),
    generatedAt: '2026-05-18T12:00:00.000Z',
    nodeVersion: 'v24.0.0',
    packageManager: 'pnpm@10.33.0',
    pnpmVersion: '10.33.0',
    repository: 'seandearnaley/brainstrike',
    selection: staleSelection,
    testedHeadSha: headSha,
  });
  const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-proof-test-'));
  const proofPath = join(tempDir, 'latest.json');
  const githubOutputPath = join(tempDir, 'github-output.txt');
  await writeFile(proofPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const runner = async (command, args) => {
    if (command === 'git' && args.join(' ') === `merge-base origin/main ${headSha}`) {
      return `${baseSha}\n`;
    }
    if (command === 'git' && args.join(' ') === 'rev-parse origin/main') {
      return `${baseSha}\n`;
    }
    if (command === 'git' && args.join(' ') === `rev-parse ${headSha}`) {
      return `${headSha}\n`;
    }
    if (
      command === 'git' &&
      args.join(' ') ===
        `diff --name-only --diff-filter=ACDMRTUXB ${baseSha} ${headSha}`
    ) {
      return 'apps/docs/docs/development/local-ci.md\n';
    }
    if (
      command === 'git' &&
      args.join(' ') === `merge-base --is-ancestor ${headSha} HEAD`
    ) {
      return '';
    }
    if (
      command === 'git' &&
      args.join(' ') ===
        `diff --name-only --diff-filter=ACDMRTUXB ${headSha} HEAD`
    ) {
      return '.ci/proof/latest.json\n';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  try {
    await assert.rejects(
      () =>
        verifyProof(
          {
            base: 'origin/main',
            'github-output': githubOutputPath,
            head: 'HEAD',
            labels: '',
            proof: proofPath,
          },
          runner
        ),
      /selection\.commands\[0\]\.command differs/
    );
    await assert.rejects(() => readFile(githubOutputPath, 'utf8'), {
      code: 'ENOENT',
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('verifyProof explains missing proof manifests', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-proof-test-'));
  const proofPath = join(tempDir, 'missing.json');

  try {
    await assert.rejects(
      () => verifyProof({ base: 'origin/main', head: 'HEAD', labels: '', proof: proofPath }),
      /could not read proof manifest.*pnpm ci:prove/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('verifyProof treats deleted files after proof as stale changes', async () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const selection = buildSelection({
    base: 'origin/main',
    baseSha,
    files: ['apps/docs/docs/development/local-ci.md'],
    head: headSha,
    headSha,
    mergeBase: baseSha,
  });
  const manifest = buildProofManifest({
    commandResults: selection.commands.map((command) => ({
      budgetMs: command.budgetMs,
      budgetStatus: 'ok',
      command: command.command,
      durationMs: 1,
      exitCode: 0,
      name: command.name,
      owner: command.owner,
    })),
    generatedAt: '2026-05-18T12:00:00.000Z',
    nodeVersion: 'v24.0.0',
    packageManager: 'pnpm@10.33.0',
    pnpmVersion: '10.33.0',
    repository: 'seandearnaley/brainstrike',
    selection,
    testedHeadSha: headSha,
  });
  const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-proof-test-'));
  const proofPath = join(tempDir, 'latest.json');
  await writeFile(proofPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const runner = async (command, args) => {
    if (command === 'git' && args.join(' ') === `merge-base origin/main ${headSha}`) {
      return `${baseSha}\n`;
    }
    if (command === 'git' && args.join(' ') === 'rev-parse origin/main') {
      return `${baseSha}\n`;
    }
    if (command === 'git' && args.join(' ') === `rev-parse ${headSha}`) {
      return `${headSha}\n`;
    }
    if (
      command === 'git' &&
      args.join(' ') ===
        `diff --name-only --diff-filter=ACDMRTUXB ${baseSha} ${headSha}`
    ) {
      return 'apps/docs/docs/development/local-ci.md\n';
    }
    if (
      command === 'git' &&
      args.join(' ') === `merge-base --is-ancestor ${headSha} HEAD`
    ) {
      return '';
    }
    if (
      command === 'git' &&
      args.join(' ') ===
        `diff --name-only --diff-filter=ACDMRTUXB ${headSha} HEAD`
    ) {
      return 'apps/web/src/deleted-route.tsx\n';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  try {
    await assert.rejects(
      () =>
        verifyProof(
          {
            base: 'origin/main',
            head: 'HEAD',
            labels: '',
            proof: proofPath,
          },
          runner
        ),
      /proof is stale: apps\/web\/src\/deleted-route\.tsx changed after testedHeadSha/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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
        `diff --name-only --diff-filter=ACDMRTUXB ${baseSha} HEAD`
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
    /proof command "diff-check" \(owner: tooling\) failed: exit 1/
  );
});

test('prove records owner and budget status for each selected command', async () => {
  const baseSha = '1111111111111111111111111111111111111111';
  const headSha = '2222222222222222222222222222222222222222';
  const tempDir = await mkdtemp(join(tmpdir(), 'brainstrike-proof-budget-test-'));
  const originalNow = Date.now;
  const timestamps = [1_000, 2_000, 3_000, 40_000];
  Date.now = () => timestamps.shift() ?? 40_000;
  const runner = async (command, args) => {
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
        `diff --name-only --diff-filter=ACDMRTUXB ${baseSha} HEAD`
    ) {
      return 'docs/architecture-reset/report.html\n';
    }
    if (command === 'git' && args.join(' ') === 'remote get-url origin') {
      return 'git@github.com:seandearnaley/brainstrike.git\n';
    }
    if (command === 'pnpm' && args.join(' ') === '--version') {
      return '10.33.0\n';
    }
    return '';
  };

  try {
    const manifest = await prove(
      { base: 'origin/main', head: 'HEAD', proof: join(tempDir, 'latest.json') },
      runner
    );

    assert.deepEqual(
      manifest.commandResults.map((result) => ({
        budgetMs: result.budgetMs,
        budgetStatus: result.budgetStatus,
        durationMs: result.durationMs,
        name: result.name,
        owner: result.owner,
      })),
      [
        {
          budgetMs: 30_000,
          budgetStatus: 'ok',
          durationMs: 1_000,
          name: 'diff-check',
          owner: 'tooling',
        },
        {
          budgetMs: 30_000,
          budgetStatus: 'over-budget',
          durationMs: 37_000,
          name: 'docs-static',
          owner: 'documentation',
        },
      ]
    );
  } finally {
    Date.now = originalNow;
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('defaultRunner rejects shell args before dropping them', async () => {
  await assert.rejects(
    () => defaultRunner('node', ['--version'], { shell: true }),
    /args must be empty when shell is true/
  );
});
