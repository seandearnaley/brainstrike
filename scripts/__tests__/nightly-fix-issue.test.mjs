import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALREADY_CLAIMED, CLAIM_LIFETIME_MINUTES, main } from '../nightly-fix-issue.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../nightly-fix-issue.mjs'
);
const API_KEY = 'lin_api_test_key_0000';
const RUNS = 'https://github.com/seandearnaley/brainstrike/actions/runs';
const FIRST_RUN_URL = `${RUNS}/41`;
const RUN_URL = `${RUNS}/77`;
const CLAIMANT = 'github-run:77';
const NOW = Date.parse('2026-10-19T09:00:00.000Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const dir = mkdtempSync(path.join(tmpdir(), 'nightly-fix-issue-'));
after(() => rmSync(dir, { force: true, recursive: true }));

const issueFile = path.join(dir, 'issue.md');
// Filed by run 41: its description names that run, not tonight's.
const ISSUE = {
  assignee: { name: 'Sean Dearnaley' },
  description: `Scheduled run of **Desktop E2E** failed this test.\n\n- Run: ${FIRST_RUN_URL}\n\nNightly identity: \`nightly-identity:abc\``,
  id: 'issue-uuid-1',
  identifier: 'BST-3000',
  labels: { nodes: [{ name: 'nightly-alert' }, { name: 'area-ci' }] },
  state: { name: 'Todo', type: 'unstarted' },
  team: { key: 'BST' },
  title: 'Nightly red: Desktop E2E › chat.desktop.test.ts › sends a message',
  url: 'https://linear.app/x/BST-3000',
};
// What Notify Linear posted on tonight's run 77.
const TONIGHT = {
  body: `Red again: ${RUN_URL}\n\n- Head SHA: abc123\n- Job: \`desktop-full-regression-gate\`\n\nError:\n\`\`\`\`text\nTimed out waiting for the composer\n\`\`\`\``,
  createdAt: minutesAgo(30),
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/**
 * An in-memory Linear issue with its comments. `fail` names operations that
 * answer HTTP 500; a failed mutation changes nothing, as on the real API.
 */
function fakeLinear({ comments = [TONIGHT], fail = [], issue = ISSUE } = {}) {
  const state = { comments: [...comments], issue: structuredClone(issue) };
  const requests = [];
  const operations = {
    commentCreate: ({ input }) => {
      state.comments.push({ body: input.body, createdAt: new Date(NOW).toISOString() });
      return { commentCreate: { success: true } };
    },
    comments: () => ({
      issue: {
        comments: { nodes: state.comments, pageInfo: { endCursor: null, hasNextPage: false } },
      },
    }),
    issue: () => ({ issue: state.issue }),
    issueUpdate: ({ input }) => {
      state.issue.state = { name: 'In Progress', type: 'started' };
      state.issue.assignee = { name: `viewer ${input.assigneeId}` };
      return { issueUpdate: { success: true } };
    },
    viewer: () => ({ viewer: { id: 'user-1' } }),
    workflowStates: () => ({ workflowStates: { nodes: [{ id: 'state-in-progress' }] } }),
  };
  // `comments` before `issue`: the comments query also reads issue(id:).
  const operationOf = (query) =>
    ['commentCreate', 'issueUpdate', 'workflowStates', 'viewer', 'comments', 'issue'].find((name) =>
      new RegExp(`\\b${name}\\b`).test(query)
    );
  return {
    async fetchImpl(url, init) {
      const body = JSON.parse(init.body);
      requests.push({ body, init, url });
      const name = operationOf(body.query);
      assert.ok(name, `unscripted Linear operation: ${body.query}`);
      if (fail.includes(name)) {
        return new Response('upstream exploded', { status: 500 });
      }
      return json({ data: operations[name](body.variables) });
    },
    mutations: () => requests.filter(({ body }) => /^\s*mutation\b/.test(body.query)),
    named: (name) => requests.filter(({ body }) => new RegExp(`\\b${name}\\b`).test(body.query)),
    requests,
    state,
  };
}

function sink() {
  let text = '';
  return {
    get text() {
      return text;
    },
    write(chunk) {
      text += chunk;
    },
  };
}

async function run(argv, linear, env = { LINEAR_API_KEY: API_KEY }) {
  const stdout = sink();
  const stderr = sink();
  const exitCode = await main({
    argv,
    env,
    fetchImpl: linear.fetchImpl,
    now: () => NOW,
    stderr,
    stdout,
  });
  return { exitCode, stderr: stderr.text, stdout: stdout.text };
}

const claimArgs = (issue = 'BST-3000') => [
  'claim',
  '--issue',
  issue,
  '--claimant',
  CLAIMANT,
  '--run-url',
  RUN_URL,
  '--issue-file',
  issueFile,
];

const claimedBy = (claimant, minutes) => ({
  body: `Claimed by \`${claimant}\` for a fix attempt: ${RUNS}/1`,
  createdAt: minutesAgo(minutes),
});
const STARTED = { ...ISSUE, state: { name: 'In Progress', type: 'started' } };

test('an unclaimed nightly issue is commented, then assigned and moved to In Progress', async () => {
  rmSync(issueFile, { force: true });
  const linear = fakeLinear();
  const result = await run(claimArgs(), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const [comment, update] = linear.mutations().map(({ body }) => body.variables);
  assert.equal(comment.input.body, `Claimed by \`${CLAIMANT}\` for a fix attempt: ${RUN_URL}`);
  assert.deepEqual(update, {
    id: 'issue-uuid-1',
    input: { assigneeId: 'user-1', stateId: 'state-in-progress' },
  });
  assert.match(result.stdout, /BST-3000 claimed by github-run:77/u);
});

test('RED-FIRST: issue.md points at tonight’s run and failure, not the run that filed it', async () => {
  rmSync(issueFile, { force: true });
  const result = await run(claimArgs(), fakeLinear());

  assert.equal(result.exitCode, 0, result.stderr);
  const written = readFileSync(issueFile, 'utf8');
  assert.ok(written.startsWith(`# BST-3000: ${ISSUE.title}\n`));
  const [tonight, description] = written.split('\n## Description\n');
  assert.ok(tonight.includes(`## Tonight's failure: ${RUN_URL}`), 'names tonight’s run');
  assert.ok(tonight.includes('Timed out waiting for the composer'), 'carries tonight’s error');
  assert.ok(!tonight.includes(FIRST_RUN_URL), 'the filing run is history, not the evidence');
  assert.ok(description.includes(FIRST_RUN_URL), 'the original description follows');
});

test('an issue filed tonight takes its failure from the description', async () => {
  rmSync(issueFile, { force: true });
  const filedTonight = { ...ISSUE, description: ISSUE.description.replace(FIRST_RUN_URL, RUN_URL) };
  const result = await run(claimArgs(), fakeLinear({ comments: [], issue: filedTonight }));

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(
    readFileSync(issueFile, 'utf8'),
    /Filed on this run: the description below is tonight's failure\./u
  );
});

test('an issue this run never touched is refused before any write', async () => {
  rmSync(issueFile, { force: true });
  const linear = fakeLinear({ comments: [] });
  const result = await run(claimArgs(), linear);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /has no failure from .*runs\/77/u);
  assert.equal(linear.mutations().length, 0);
  assert.ok(!existsSync(issueFile));
});

test('RED-FIRST: a claim comment that fails leaves the issue unlocked, never stranded', async () => {
  const linear = fakeLinear({ fail: ['commentCreate'] });
  const result = await run(claimArgs(), linear);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /HTTP 500/u);
  assert.equal(linear.named('issueUpdate').length, 0, 'the lock is the last write');
  assert.equal(linear.state.issue.state.type, 'unstarted');
  const retry = await run(claimArgs(), fakeLinear());
  assert.equal(retry.exitCode, 0, 'the next run claims it');
});

test('a failed lock leaves the issue unlocked, with a claim record the stale rule can age out', async () => {
  const linear = fakeLinear({ fail: ['issueUpdate'] });
  assert.equal((await run(claimArgs(), linear)).exitCode, 1);
  assert.equal(linear.state.issue.state.type, 'unstarted', 'nothing is locked');
  // Had Linear applied the update and lost only its response, the issue would
  // be started under this bot claim, which goes stale and is reclaimed.
  assert.match(linear.state.comments.at(-1).body, /^Claimed by `github-run:77`/u);
});

test('RED-FIRST: a stale bot claim with no PR is reclaimed', async () => {
  rmSync(issueFile, { force: true });
  const stale = CLAIM_LIFETIME_MINUTES + 1;
  const linear = fakeLinear({
    comments: [claimedBy('github-run:1', stale), TONIGHT],
    issue: STARTED,
  });
  const result = await run(claimArgs(), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /reclaimed from github-run:1/u);
  const [comment, update] = linear.mutations().map(({ body }) => body.variables);
  assert.match(comment.input.body, /^Claimed by `github-run:77`/u);
  assert.deepEqual(update.input, { assigneeId: 'user-1', stateId: 'state-in-progress' });
  assert.ok(existsSync(issueFile));
});

test('RED-FIRST: a live claim is respected', async () => {
  const cases = [
    ['a fresh bot claim', [claimedBy('github-run:1', CLAIM_LIFETIME_MINUTES - 1), TONIGHT]],
    [
      'a stale bot claim with a PR',
      [
        claimedBy('github-run:1', 600),
        {
          body: 'Fix PR opened for review: https://github.com/x/pull/9',
          createdAt: minutesAgo(500),
        },
        TONIGHT,
      ],
    ],
    ['a person’s claim', [claimedBy('sean', 10_000), TONIGHT]],
    ['a start with no claim record', [TONIGHT]],
  ];
  for (const [name, comments] of cases) {
    rmSync(issueFile, { force: true });
    const linear = fakeLinear({ comments, issue: STARTED });
    const result = await run(claimArgs(), linear);

    assert.equal(result.exitCode, ALREADY_CLAIMED, `${name} must be held`);
    assert.equal(linear.mutations().length, 0, name);
    assert.ok(!existsSync(issueFile), name);
  }
});

test('done and canceled issues are never claimed', async () => {
  for (const state of [
    { name: 'Done', type: 'completed' },
    { name: 'Canceled', type: 'canceled' },
  ]) {
    const linear = fakeLinear({
      comments: [claimedBy('github-run:1', 10_000), TONIGHT],
      issue: { ...ISSUE, state },
    });
    const result = await run(claimArgs(), linear);
    assert.equal(result.exitCode, ALREADY_CLAIMED);
    assert.match(result.stdout, new RegExp(`already claimed: ${state.name}`, 'u'));
    assert.equal(linear.mutations().length, 0);
  }
});

test('triage and backlog issues are claimable', async () => {
  for (const type of ['triage', 'backlog']) {
    const linear = fakeLinear({ issue: { ...ISSUE, state: { name: type, type } } });
    assert.equal((await run(claimArgs(), linear)).exitCode, 0);
  }
});

test('an issue without the nightly-alert label is refused before any write', async () => {
  const linear = fakeLinear({ issue: { ...ISSUE, labels: { nodes: [{ name: 'area-ci' }] } } });
  const result = await run(claimArgs(), linear);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /not a BST nightly-alert issue/u);
  assert.equal(linear.mutations().length, 0);
});

test('comment posts the body file, and link-pr records the pull request', async () => {
  const bodyFile = path.join(dir, 'evidence.md');
  writeFileSync(bodyFile, 'Reproduced on run 77; root cause is the stale watcher.\n');
  const linear = fakeLinear();
  const result = await run(['comment', '--issue', 'BST-3000', '--body-file', bodyFile], linear);
  const linked = await run(
    ['link-pr', '--issue', 'BST-3000', '--pr-url', 'https://github.com/x/pull/9'],
    linear
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linked.exitCode, 0, linked.stderr);
  assert.deepEqual(
    linear.mutations().map(({ body }) => body.variables.input.body),
    [
      'Reproduced on run 77; root cause is the stale watcher.',
      'Fix PR opened for review: https://github.com/x/pull/9',
    ]
  );
});

test('an empty body file fails before any fetch', async () => {
  const bodyFile = path.join(dir, 'empty.md');
  writeFileSync(bodyFile, '  \n');
  const linear = fakeLinear();
  const result = await run(['comment', '--issue', 'BST-3000', '--body-file', bodyFile], linear);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /is empty/u);
  assert.equal(linear.requests.length, 0);
});

test('malformed arguments and a missing key fail before any fetch', async () => {
  const cases = [
    [['merge', '--issue', 'BST-1'], /Usage/u],
    [claimArgs().slice(0, -2), /--issue-file/u],
    [claimArgs('BST-1; rm -rf /'), /BST issue identifier/u],
  ];
  for (const [argv, expected] of cases) {
    const linear = fakeLinear();
    const result = await run(argv, linear);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, expected);
    assert.equal(linear.requests.length, 0);
  }
  const linear = fakeLinear();
  const result = await run(claimArgs(), linear, {});
  assert.match(result.stderr, /LINEAR_API_KEY is not set/u);
  assert.equal(linear.requests.length, 0);
});

test('an HTTP failure exits 1 without echoing the key', async () => {
  const linear = fakeLinear({ fail: ['issue'] });
  const result = await run(claimArgs(), linear);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /HTTP 500/u);
  assert.ok(!`${result.stderr}${result.stdout}`.includes(API_KEY));
  for (const { init } of linear.requests) {
    assert.equal(init.headers.Authorization, API_KEY);
  }
});

test('direct execution exits 1 with the key-missing message and no network', () => {
  const child = spawnSync(process.execPath, [scriptPath, ...claimArgs()], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });

  assert.equal(child.status, 1);
  assert.match(child.stderr, /LINEAR_API_KEY is not set/u);
});
