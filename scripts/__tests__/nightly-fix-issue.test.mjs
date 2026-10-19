import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALREADY_CLAIMED, main } from '../nightly-fix-issue.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../nightly-fix-issue.mjs'
);
const API_KEY = 'lin_api_test_key_0000';
const RUN_URL = 'https://github.com/seandearnaley/brainstrike/actions/runs/77';
const CLAIMANT = 'github-run:77';
const dir = mkdtempSync(path.join(tmpdir(), 'nightly-fix-issue-'));
after(() => rmSync(dir, { force: true, recursive: true }));

const issueFile = path.join(dir, 'issue.md');
const ISSUE = {
  assignee: { name: 'Sean Dearnaley' },
  description:
    'Scheduled run of **Desktop E2E** failed this test.\n\nNightly identity: `nightly-identity:abc`',
  id: 'issue-uuid-1',
  identifier: 'BST-3000',
  labels: { nodes: [{ name: 'nightly-alert' }, { name: 'area-ci' }] },
  state: { name: 'Todo', type: 'unstarted' },
  team: { key: 'BST' },
  title: 'Nightly red: Desktop E2E › chat.desktop.test.ts › sends a message',
  url: 'https://linear.app/x/BST-3000',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function fakeLinear({ issue = ISSUE, overrides = {} } = {}) {
  const table = {
    commentCreate: { commentCreate: { success: true } },
    issue: { issue },
    issueUpdate: { issueUpdate: { success: true } },
    viewer: { viewer: { id: 'user-1' } },
    workflowStates: { workflowStates: { nodes: [{ id: 'state-in-progress' }] } },
    ...overrides,
  };
  const requests = [];
  const operationOf = (query) =>
    ['commentCreate', 'issueUpdate', 'workflowStates', 'viewer', 'issue'].find((name) =>
      new RegExp(`\\b${name}\\b`).test(query)
    );
  return {
    async fetchImpl(url, init) {
      const body = JSON.parse(init.body);
      requests.push({ body, init, url });
      const name = operationOf(body.query);
      assert.ok(name, `unscripted Linear operation: ${body.query}`);
      const reply = table[name];
      return typeof reply === 'function' ? reply(body) : json({ data: reply });
    },
    mutations: () => requests.filter(({ body }) => /^\s*mutation\b/.test(body.query)),
    requests,
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
  const exitCode = await main({ argv, env, fetchImpl: linear.fetchImpl, stderr, stdout });
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

test('an unclaimed nightly issue is assigned, moved to In Progress, commented and written out', async () => {
  rmSync(issueFile, { force: true });
  const linear = fakeLinear();
  const result = await run(claimArgs(), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const [update, comment] = linear.mutations().map(({ body }) => body.variables);
  assert.deepEqual(update, {
    id: 'issue-uuid-1',
    input: { assigneeId: 'user-1', stateId: 'state-in-progress' },
  });
  assert.equal(comment.input.issueId, 'issue-uuid-1');
  assert.equal(comment.input.body, `Claimed by \`${CLAIMANT}\` for a fix attempt: ${RUN_URL}`);
  const written = readFileSync(issueFile, 'utf8');
  assert.ok(written.startsWith(`# BST-3000: ${ISSUE.title}\n`));
  assert.ok(written.includes(ISSUE.description));
  assert.match(result.stdout, /BST-3000 claimed by github-run:77/u);
});

test('RED-FIRST: an issue already in progress is held: exit 3, no write, no issue file', async () => {
  for (const state of [
    { name: 'In Progress', type: 'started' },
    { name: 'Done', type: 'completed' },
    { name: 'Canceled', type: 'canceled' },
  ]) {
    rmSync(issueFile, { force: true });
    const linear = fakeLinear({ issue: { ...ISSUE, state } });
    const result = await run(claimArgs(), linear);

    assert.equal(result.exitCode, ALREADY_CLAIMED, `${state.name} must be held`);
    assert.equal(linear.mutations().length, 0);
    assert.ok(!existsSync(issueFile), 'the agent gets no issue to work on');
    assert.match(
      result.stdout,
      new RegExp(`already claimed: ${state.name}, assigned to Sean Dearnaley`, 'u')
    );
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

test('comment posts the body file to the issue', async () => {
  const bodyFile = path.join(dir, 'evidence.md');
  writeFileSync(bodyFile, 'Reproduced on run 77; root cause is the stale watcher.\n');
  const linear = fakeLinear();
  const result = await run(['comment', '--issue', 'BST-3000', '--body-file', bodyFile], linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const [comment] = linear.mutations().map(({ body }) => body.variables.input);
  assert.deepEqual(comment, {
    body: 'Reproduced on run 77; root cause is the stale watcher.',
    issueId: 'issue-uuid-1',
  });
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
  const linear = fakeLinear({ overrides: { issue: () => new Response('nope', { status: 500 }) } });
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
