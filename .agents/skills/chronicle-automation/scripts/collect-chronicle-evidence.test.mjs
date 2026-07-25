import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'collect-chronicle-evidence.mjs'
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

function charter(name, cron) {
  return [`# ${name}`, '', '```', `NAME=${name}`, `SCHEDULE="${cron}"`, '```', ''].join('\n');
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
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(process.env.FAKE_GH_PRS);
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const number = args[2];
  const checks = number === '2'
    ? [
        { conclusion: 'SUCCESS', name: 'unit', status: 'COMPLETED' },
        { conclusion: 'FAILURE', name: 'e2e', status: 'COMPLETED' },
        { conclusion: null, name: 'pending', status: 'IN_PROGRESS' },
      ]
    : [];
  process.stdout.write(JSON.stringify({ statusCheckRollup: checks }));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const number = args.find((argument) => argument.startsWith('number='))?.slice('number='.length);
  const cursor = args.find((argument) => argument.startsWith('cursor='));
  const reviewThreads = cursor
    ? {
        nodes: [{ id: 'thread-3', isResolved: false }],
        pageInfo: { endCursor: null, hasNextPage: false },
      }
    : {
        nodes: [
          { id: 'thread-1', isResolved: false },
          { id: 'thread-2', isResolved: true },
        ],
        pageInfo: { endCursor: 'page-2', hasNextPage: true },
      };
  // commits(last: 1) — the head commit only, never a truncated first page.
  const commits = {
    nodes: [
      {
        commit: {
          committedDate: number === '2' ? '2026-07-21T11:30:00Z' : '2026-07-18T09:00:00Z',
        },
      },
    ],
  };
  process.stdout.write(JSON.stringify({
    data: { repository: { pullRequest: { commits, reviewThreads } } },
  }));
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'list') {
  const limit = args[args.indexOf('--limit') + 1];
  if (process.env.FAKE_GH_PENDING_ONLY === '1') {
    const count = limit === '100' ? 6 : 2;
    process.stdout.write(JSON.stringify(Array.from({ length: count }, (_, index) => ({
      conclusion: null,
      createdAt: \`2026-07-2\${index % 9}T12:00:00Z\`,
      databaseId: 800 + index,
      headSha: \`pending-\${index}\`,
      status: 'in_progress',
    }))));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify([
    {
      conclusion: null,
      createdAt: '2026-07-22T12:00:00Z',
      databaseId: 902,
      headSha: 'pending-sha',
      status: 'in_progress',
    },
    {
      conclusion: 'success',
      createdAt: '2026-07-21T12:00:00Z',
      databaseId: 901,
      headSha: 'completed-sha',
      status: 'completed',
    },
  ]));
  process.exit(0);
}
process.stderr.write(\`unexpected gh invocation: \${args.join(' ')}\\n\`);
process.exit(2);
`
  );
  fs.chmodSync(gh, 0o755);
  return bin;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-collector-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  run('git', ['init', '--initial-branch=main'], repo);
  run('git', ['config', 'user.email', 'chronicle@example.test'], repo);
  run('git', ['config', 'user.name', 'Chronicle Test'], repo);
  write(repo, '.night-shift/PROTOCOL.md', '# Protocol\n');
  write(repo, '.night-shift/charters/daily.md', charter('Daily', '0 12 * * *'));
  write(repo, '.night-shift/charters/weekly.md', charter('Weekly', '0 12 * * 1'));
  write(
    repo,
    '.github/workflows/scheduled.yml',
    "name: Scheduled Fixture\n\non:\n  schedule:\n    - cron: '0 1 * * *'\n"
  );
  write(
    repo,
    '.github/workflows/manual.yml',
    'name: Manual Fixture\n\non:\n  workflow_dispatch:\n'
  );
  write(
    repo,
    '.github/workflows/commented.yml',
    'name: Commented Decoy\n\non:\n  # schedule:\n  workflow_dispatch:\n'
  );
  commitAll(repo, 'fixture');
  const bin = createFakeGh(root);
  const prs = [
    {
      createdAt: '2026-07-20T18:00:00Z',
      headRefName: 'night-shift/daily/merged',
      isDraft: false,
      mergedAt: '2026-07-21T06:00:00Z',
      number: 1,
      state: 'MERGED',
      title: 'Merged in window',
    },
    {
      createdAt: '2026-07-21T08:00:00Z',
      headRefName: 'night-shift/daily/opened',
      isDraft: false,
      mergedAt: null,
      number: 2,
      state: 'OPEN',
      title: 'Opened in window',
    },
    {
      createdAt: '2026-07-19T08:00:00Z',
      headRefName: 'night-shift/daily/closed',
      isDraft: false,
      mergedAt: null,
      number: 3,
      state: 'CLOSED',
      title: 'Old and closed',
    },
    {
      createdAt: '2026-07-18T08:00:00Z',
      headRefName: 'night-shift/weekly/still-open',
      isDraft: true,
      mergedAt: null,
      number: 4,
      state: 'OPEN',
      title: 'Still open',
    },
  ];
  return { bin, prs, repo, root };
}

function collect(fixture, start, end, extraEnvironment = {}, scheduleTimezone = 'UTC') {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      '--repo',
      fixture.repo,
      '--revision',
      'HEAD',
      '--window-start',
      start,
      '--window-end',
      end,
      '--schedule-timezone',
      scheduleTimezone,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_GH_PRS: JSON.stringify(fixture.prs),
        PATH: `${fixture.bin}:${process.env.PATH}`,
        ...extraEnvironment,
      },
    }
  );
}

test('collects 24-hour roster, PR, paginated thread, check, and scheduled-workflow evidence', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture, '2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z');
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);

  assert.equal(evidence.schema, 'collect-chronicle-evidence');
  assert.deepEqual(evidence.window, {
    end: '2026-07-22T00:00:00.000Z',
    scheduleSlackMinutes: 90,
    scheduleTimezone: 'UTC',
    start: '2026-07-21T00:00:00.000Z',
  });
  assert.deepEqual(evidence.roster, [
    { cron: '0 12 * * *', expectedWakes: 1, name: 'Daily', pendingWakes: 0 },
    { cron: '0 12 * * 1', expectedWakes: 0, name: 'Weekly', pendingWakes: 0 },
  ]);
  assert.deepEqual(
    evidence.prs.merged.map((pr) => pr.number),
    [1]
  );
  assert.deepEqual(
    evidence.prs.opened.map((pr) => pr.number),
    [2]
  );
  assert.deepEqual(
    evidence.prs.open.map((pr) => pr.number),
    [2, 4]
  );
  assert.deepEqual(evidence.prs.open[0].checks, { failing: 1, pending: 1 });
  assert.equal(evidence.prs.open[0].unresolvedThreads, 2);
  // Head-commit committedDate via commits(last: 1) — exact for any commit count.
  assert.equal(evidence.prs.open[0].lastCommitAt, '2026-07-21T11:30:00.000Z');
  assert.deepEqual(evidence.prs.open[1].checks, { failing: 0, pending: 0 });
  assert.equal(evidence.prs.open[1].unresolvedThreads, 2);
  assert.equal(evidence.prs.open[1].lastCommitAt, '2026-07-18T09:00:00.000Z');
  assert.deepEqual(evidence.scheduledWorkflows, [
    {
      file: '.github/workflows/scheduled.yml',
      latestCompleted: {
        conclusion: 'success',
        createdAt: '2026-07-21T12:00:00.000Z',
        databaseId: 901,
        headSha: 'completed-sha',
        status: 'completed',
      },
      name: 'Scheduled Fixture',
      pendingOnly: false,
    },
  ]);
});

test('counts one weekly wake across the selected eight-day window and reports pending-only runs', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  // Evening's 2026-07-28T23:00Z wake falls inside the trailing 90-minute
  // slack (due horizon 22:30) — pending, not yet missable.
  write(fixture.repo, '.night-shift/charters/evening.md', charter('Evening', '0 23 * * *'));
  commitAll(fixture.repo, 'add evening charter');

  const result = collect(fixture, '2026-07-21T00:00:00Z', '2026-07-29T00:00:00Z', {
    FAKE_GH_PENDING_ONLY: '1',
  });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.roster, [
    { cron: '0 12 * * *', expectedWakes: 8, name: 'Daily', pendingWakes: 0 },
    { cron: '0 23 * * *', expectedWakes: 7, name: 'Evening', pendingWakes: 1 },
    { cron: '0 12 * * 1', expectedWakes: 1, name: 'Weekly', pendingWakes: 0 },
  ]);
  assert.equal(evidence.scheduledWorkflows[0].latestCompleted, null);
  assert.equal(evidence.scheduledWorkflows[0].pendingOnly, true);
});

test('fails closed with gh stderr detail when a GitHub call exits non-zero', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = collect(fixture, '2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z', {
    FAKE_GH_FAIL: '1',
  });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^collect-chronicle-evidence: gh repo view .*forced gh failure detail/mu
  );
});

test('supports weekday cron ranges and fails closed on an inverted range', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  write(fixture.repo, '.night-shift/charters/weekdays.md', charter('Weekdays', '0 12 * * 1-5'));
  commitAll(fixture.repo, 'weekday range cron');

  // 2026-07-21 is a Tuesday; weekday noons through the due horizon
  // (2026-07-28T22:30Z) are Tue 21, Wed 22, Thu 23, Fri 24, Mon 27, Tue 28.
  const ok = collect(fixture, '2026-07-21T00:00:00Z', '2026-07-29T00:00:00Z');
  assert.equal(ok.status, 0, ok.stderr);
  const roster = JSON.parse(ok.stdout).roster;
  assert.deepEqual(
    roster.find((entry) => entry.name === 'Weekdays'),
    { cron: '0 12 * * 1-5', expectedWakes: 6, name: 'Weekdays', pendingWakes: 0 }
  );

  write(fixture.repo, '.night-shift/charters/weekdays.md', charter('Weekdays', '0 12 * * 5-1'));
  commitAll(fixture.repo, 'inverted range cron');
  const bad = collect(fixture, '2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unsupported cron day-of-week field: 5-1/u);
});

test('evaluates roster crons in the declared scheduler timezone, DST-aware', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  fs.rmSync(path.join(fixture.repo, '.night-shift/charters/weekly.md'));
  write(fixture.repo, '.night-shift/charters/daily.md', charter('daily', '0 10 * * *'));
  commitAll(fixture.repo, 'roster: single daily loop');

  // July: America/New_York is UTC-4, so 10:00 local fires at 14:00Z.
  const july = collect(
    fixture,
    '2026-07-21T00:00:00Z',
    '2026-07-21T13:00:00Z',
    {},
    'America/New_York'
  );
  assert.equal(july.status, 0, july.stderr);
  const julyEvidence = JSON.parse(july.stdout);
  assert.equal(julyEvidence.window.scheduleTimezone, 'America/New_York');
  assert.deepEqual(julyEvidence.roster, [
    { cron: '0 10 * * *', expectedWakes: 0, name: 'daily', pendingWakes: 0 },
  ]);
  const julyHit = collect(
    fixture,
    '2026-07-21T00:00:00Z',
    '2026-07-21T16:00:00Z',
    {},
    'America/New_York'
  );
  assert.equal(julyHit.status, 0, julyHit.stderr);
  assert.deepEqual(JSON.parse(julyHit.stdout).roster, [
    { cron: '0 10 * * *', expectedWakes: 1, name: 'daily', pendingWakes: 0 },
  ]);

  // January: same zone is UTC-5, so 10:00 local fires at 15:00Z — a fixed
  // offset would put the wake inside this window; real DST handling must not.
  const january = collect(
    fixture,
    '2026-01-20T00:00:00Z',
    '2026-01-20T14:30:00Z',
    {},
    'America/New_York'
  );
  assert.equal(january.status, 0, january.stderr);
  assert.deepEqual(JSON.parse(january.stdout).roster, [
    { cron: '0 10 * * *', expectedWakes: 0, name: 'daily', pendingWakes: 0 },
  ]);
});

test('fails closed on a missing or invalid schedule timezone', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const invalid = collect(
    fixture,
    '2026-07-21T00:00:00Z',
    '2026-07-22T00:00:00Z',
    {},
    'America/Springfield'
  );
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /schedule-timezone/);
  const missing = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--repo', fixture.repo, '--window-start', '2026-07-21T00:00:00Z'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}` } }
  );
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--schedule-timezone is required/);
});
