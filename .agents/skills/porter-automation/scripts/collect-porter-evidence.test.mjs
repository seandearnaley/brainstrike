import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'collect-porter-evidence.mjs'
);

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, content) {
  const file = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commitAll(repo, message) {
  run('git', ['add', '--all'], repo);
  run('git', ['commit', '-m', message], repo);
}

function createFakeGh(root) {
  const bin = path.join(root, 'bin');
  const gh = path.join(bin, 'gh');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.FAKE_GH_FAIL === '1') {
  process.stderr.write('forced gh failure detail\\n');
  process.exit(9);
}
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({ nameWithOwner: 'fixture/brainstrike' }));
  process.exit(0);
}
if (args[0] === 'api' && args[1].startsWith('repos/fixture/brainstrike/contents/.night-shift/HOLD')) {
  if (process.env.FAKE_GH_HOLD === '1') {
    process.stdout.write(JSON.stringify({ name: 'HOLD', path: '.night-shift/HOLD' }));
    process.exit(0);
  }
  if (process.env.FAKE_GH_HOLD_ERROR === '1') {
    process.stderr.write('gh: HTTP 500 upstream unavailable\\n');
    process.exit(1);
  }
  process.stderr.write('gh: Not Found (HTTP 404)\\n');
  process.exit(1);
}
if (args[0] === 'api' && args[1] === 'repos/fixture/brainstrike/rules/branches/main') {
  if (process.env.FAKE_GH_NO_RULES === '1') {
    process.stdout.write(JSON.stringify([]));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify([
    { type: 'pull_request', parameters: {} },
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [
          { context: 'Build' },
          { context: 'Static' },
          { context: 'Unit (db)' },
        ],
      },
    },
  ]));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  if (args.includes('--search')) {
    process.stderr.write('unexpected --search: night-shift PRs derive from the full open list\\n');
    process.exit(2);
  }
  process.stdout.write(process.env.FAKE_GH_PRS);
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const number = args[2];
  // Heterogeneous rollups: CheckRun entries carry name/status/conclusion,
  // StatusContext entries carry context/state and NO name — both real.
  const rollups = {
    '10': [
      { name: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { context: 'Static', state: 'SUCCESS' },
      { name: 'Unit (db)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { context: 'Vercel', state: 'FAILURE' },
    ],
    // Unit (db) entirely ABSENT from the rollup: the skipped-check masking
    // shape. Rollup-level "no failures" must still read as not-green.
    '11': [
      { name: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Static', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    '12': [
      { name: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Static', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Unit (db)', status: 'IN_PROGRESS', conclusion: null },
    ],
  };
  process.stdout.write(JSON.stringify({ statusCheckRollup: rollups[number] ?? [] }));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const number = args.find((argument) => argument.startsWith('number='))?.slice(7);
  const byNumber = {
    '10': {
      commits: { nodes: [{ commit: { committedDate: '2026-07-23T01:00:00Z' } }] },
      comments: { nodes: [
        { body: 'looks good', createdAt: '2026-07-23T02:00:00Z' },
        { body: 'brief <!-- assay:v1 assay:10:headsha10:1 --> end', createdAt: '2026-07-23T03:00:00Z' },
      ] },
      headRefOid: 'headsha10',
      reviews: { nodes: [{ submittedAt: '2026-07-23T02:30:00Z' }] },
      reviewThreads: {
        nodes: [
          { id: 't1', isResolved: true, comments: { nodes: [{ createdAt: '2026-07-23T02:15:00Z' }] } },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    },
    '11': {
      commits: { nodes: [{ commit: { committedDate: '2026-07-23T04:00:00Z' } }] },
      comments: { nodes: [] },
      headRefOid: 'headsha11',
      reviews: { nodes: [] },
      reviewThreads: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
    },
    '12': {
      commits: { nodes: [{ commit: { committedDate: '2026-07-23T05:00:00Z' } }] },
      comments: { nodes: [{ body: '<!-- assay:v1 assay:12:stalesha:1 -->', createdAt: '2026-07-23T05:30:00Z' }] },
      headRefOid: 'headsha12',
      reviews: { nodes: [] },
      reviewThreads: {
        nodes: [
          { id: 't2', isResolved: false, comments: { nodes: [{ createdAt: '2026-07-23T06:00:00Z' }] } },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    },
  };
  const pullRequest = byNumber[number];
  if (!pullRequest) {
    process.stderr.write('unexpected graphql PR number\\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ data: { repository: { pullRequest } } }));
  process.exit(0);
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(2);
`
  );
  fs.chmodSync(gh, 0o755);
  return bin;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porter-collector-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  run('git', ['init', '--initial-branch=main'], repo);
  run('git', ['config', 'user.email', 'porter@example.test'], repo);
  run('git', ['config', 'user.name', 'Porter Test'], repo);
  write(repo, '.night-shift/PROTOCOL.md', '# Protocol\n');
  commitAll(repo, 'fixture');
  const bin = createFakeGh(root);
  const prs = [
    {
      baseRefName: 'main',
      headRefName: 'night-shift/bolt/fast-path',
      isDraft: false,
      labels: [{ name: 'review/risk-1-low' }],
      number: 10,
      state: 'OPEN',
      title: 'Bolt: fast path',
      updatedAt: '2026-07-23T02:45:00Z',
    },
    {
      baseRefName: 'main',
      headRefName: 'night-shift/palette/aria-fix',
      isDraft: false,
      labels: [{ name: 'review/risk-1-low' }, { name: 'review/hold' }],
      number: 11,
      state: 'OPEN',
      title: 'Palette: aria fix',
      updatedAt: '2026-07-23T04:10:00Z',
    },
    {
      baseRefName: 'main',
      headRefName: 'night-shift/sentinel/harden',
      isDraft: false,
      labels: [{ name: 'review/risk-2-moderate' }],
      number: 12,
      state: 'OPEN',
      title: 'Sentinel: harden',
      updatedAt: '2026-07-23T07:00:00Z',
    },
    {
      baseRefName: 'night-shift/sentinel/harden',
      headRefName: 'feature/stacked-on-sentinel',
      isDraft: false,
      labels: [],
      number: 13,
      state: 'OPEN',
      title: 'Stacked child',
      updatedAt: '2026-07-23T07:05:00Z',
    },
  ];
  return { bin, prs, repo, root };
}

function collect(fixture, extraEnvironment = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--repo', fixture.repo], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_GH_PRS: JSON.stringify(fixture.prs),
      PATH: `${fixture.bin}:${process.env.PATH}`,
      ...extraEnvironment,
    },
  });
}

test('collects merge-eligibility evidence for open night-shift PRs', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);

  assert.equal(evidence.schema, 'collect-porter-evidence');
  assert.equal(evidence.holdFile, false);
  assert.deepEqual(evidence.requiredContexts, ['Build', 'Static', 'Unit (db)']);
  assert.deepEqual(
    evidence.prs.map((pr) => pr.number),
    [10, 11, 12]
  );

  const [eligible, masked, stacked] = evidence.prs;

  assert.equal(eligible.headSha, 'headsha10');
  assert.equal(eligible.riskLabel, 'review/risk-1-low');
  assert.equal(eligible.holdLabel, false);
  // 'Static' reports as a StatusContext (context/state) and still satisfies
  // its required slot; the CheckRun entries satisfy theirs.
  assert.equal(eligible.requiredGreen, true);
  assert.deepEqual(eligible.missingRequiredContexts, []);
  // Vercel is a StatusContext failure — advisory, not a crash.
  assert.deepEqual(eligible.failingAdvisoryChecks, ['Vercel']);
  assert.equal(eligible.unresolvedThreads, 0);
  assert.equal(eligible.assayWorkKeyHeadSha, 'headsha10');
  // Latest of comment 03:00, review 02:30, thread 02:15, commit 01:00,
  // updatedAt 02:45.
  assert.equal(eligible.lastActivityAt, '2026-07-23T03:00:00.000Z');
  assert.deepEqual(eligible.dependentPrs, []);

  // Required context absent from the rollup must read as NOT green — the
  // skipped-check masking shape.
  assert.equal(masked.requiredGreen, false);
  assert.deepEqual(masked.missingRequiredContexts, ['Unit (db)']);
  assert.equal(masked.holdLabel, true);
  assert.equal(masked.assayWorkKeyHeadSha, null);
  // updatedAt (04:10) is newer than the head commit (04:00): a push or edit
  // the commit date does not reflect still restarts the cooling clock.
  assert.equal(masked.lastActivityAt, '2026-07-23T04:10:00.000Z');

  assert.equal(stacked.requiredGreen, false);
  assert.equal(stacked.riskLabel, 'review/risk-2-moderate');
  assert.equal(stacked.unresolvedThreads, 1);
  // Stale assay work_key: recorded verbatim so the agent sees the mismatch.
  assert.equal(stacked.assayWorkKeyHeadSha, 'stalesha');
  assert.equal(stacked.lastActivityAt, '2026-07-23T07:00:00.000Z');
  assert.deepEqual(stacked.dependentPrs, [13]);
});

test('reports the HOLD kill switch from the live contents API', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture, { FAKE_GH_HOLD: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).holdFile, true);
});

test('fails closed when the HOLD state is unreadable (non-404 error)', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture, { FAKE_GH_HOLD_ERROR: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /HOLD/u);
});

test('fails closed when the ruleset yields no required contexts', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture, { FAKE_GH_NO_RULES: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required contexts/u);
});

test('fails closed with gh stderr detail when a GitHub call exits non-zero', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture, { FAKE_GH_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forced gh failure detail/u);
});
