import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../notify-linear-nightly.mjs';

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../notify-linear-nightly.mjs'
);
const API_KEY = 'lin_api_test_key_0000';
const WORKFLOW = 'Desktop E2E';
const RUN_URL = 'https://github.com/seandearnaley/brainstrike/actions/runs/42';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const LIFECYCLE_SENTENCE =
  'Stays open until a human closes it. Each further red night adds a comment; the first green night adds a recovered comment; a red night after you close it opens a new issue.';

const OPEN_ISSUE = { id: 'issue-1', identifier: 'BST-2000', url: 'https://linear.app/x/BST-2000' };
const ALERT_LABEL = { id: 'label-alert', name: 'nightly-alert' };
const CI_LABEL = { id: 'label-ci', name: 'area-ci' };
const HUMAN_LABEL = { id: 'label-human', name: 'needs-human' };

function argv(results) {
  return ['--workflow', WORKFLOW, '--results', results, '--run-url', RUN_URL, '--sha', SHA];
}

const RED = argv('desktop-full-regression=failure,desktop-embedding-e2e=success');
const GREEN = argv('desktop-full-regression=success,desktop-embedding-e2e=success');
const RECOVERED_AT = (day) => ({
  body: `Recovered: ${RUN_URL}`,
  createdAt: `2026-09-${day}T07:00:00.000Z`,
});
const RED_AT = (day) => ({
  body: `Red again: ${RUN_URL}`,
  createdAt: `2026-09-${day}T07:00:00.000Z`,
});
const NO_MORE_PAGES = { endCursor: null, hasNextPage: false };

function commentsReply(nodes, pageInfo = NO_MORE_PAGES) {
  return { issue: { comments: { nodes, pageInfo } } };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// Answers each Linear operation from a scripted table. A table entry is the
// `data` payload, or a function returning a Response for transport-level cases.
function scriptedLinear(overrides = {}) {
  const table = {
    commentCreate: { commentCreate: { success: true } },
    comments: commentsReply([]),
    issueCreate: {
      issueCreate: {
        issue: { identifier: 'BST-2001', url: 'https://linear.app/x/BST-2001' },
        success: true,
      },
    },
    issueLabelCreate: {
      issueLabelCreate: { issueLabel: { id: 'label-alert-new' }, success: true },
    },
    issueLabels: { issueLabels: { nodes: [ALERT_LABEL, CI_LABEL, HUMAN_LABEL] } },
    issues: { issues: { nodes: [] } },
    teams: { teams: { nodes: [{ id: 'team-1' }] } },
    viewer: { viewer: { id: 'user-1' } },
    workflowStates: { workflowStates: { nodes: [{ id: 'state-todo' }] } },
    ...overrides,
  };
  const requests = [];
  const operationOf = (query) =>
    Object.keys(table).find((name) => new RegExp(`\\b${name}\\b`).test(query));

  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    requests.push({ body, init, url });
    const name = operationOf(body.query);
    assert.ok(name, `unscripted Linear operation: ${body.query}`);
    const reply = table[name];
    return typeof reply === 'function' ? reply(body) : json({ data: reply });
  }

  return {
    fetchImpl,
    mutations: () => requests.filter(({ body }) => /^\s*mutation\b/.test(body.query)),
    named: (name) => requests.filter(({ body }) => new RegExp(`\\b${name}\\b`).test(body.query)),
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

async function run(args, linear, { env = { LINEAR_API_KEY: API_KEY } } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'notify-linear-'));
  const stepSummaryPath = path.join(dir, 'summary.md');
  const stdout = sink();
  const stderr = sink();
  try {
    const exitCode = await main({
      argv: args,
      env,
      fetchImpl: linear.fetchImpl,
      stderr,
      stdout,
      stepSummaryPath,
    });
    let summary = '';
    try {
      summary = readFileSync(stepSummaryPath, 'utf8');
    } catch {
      // No summary line was written; asserted by the tests that care.
    }
    return { exitCode, stderr: stderr.text, stdout: stdout.text, summary };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test('red with no open issue creates exactly one fully-specified issue', async () => {
  const linear = scriptedLinear();
  const result = await run(RED, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const creates = linear.named('issueCreate');
  assert.equal(creates.length, 1);
  assert.equal(linear.mutations().length, 1);
  const { input } = creates[0].body.variables;
  assert.deepEqual(input.labelIds, ['label-alert', 'label-ci', 'label-human']);
  assert.equal(input.stateId, 'state-todo');
  assert.equal(input.assigneeId, 'user-1');
  assert.equal(input.teamId, 'team-1');
  assert.equal(input.priority, 2);
  assert.equal(input.title, `Nightly red: ${WORKFLOW}`);
  assert.ok(input.description.includes(LIFECYCLE_SENTENCE));
  assert.ok(input.description.includes(WORKFLOW));
  assert.ok(input.description.includes(RUN_URL));
  assert.ok(input.description.includes(SHA));
  assert.ok(input.description.includes('- `desktop-full-regression`: failure'));
  assert.ok(input.description.includes('- `desktop-embedding-e2e`: success'));
  assert.match(input.description, /\d{4}-\d{2}-\d{2}/);
  assert.equal(result.summary, 'Linear: BST-2001 https://linear.app/x/BST-2001 (created)\n');
});

test('red with one open issue comments and never creates', async () => {
  const linear = scriptedLinear({ issues: { issues: { nodes: [OPEN_ISSUE] } } });
  const result = await run(RED, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linear.named('issueCreate').length, 0);
  const comments = linear.named('commentCreate');
  assert.equal(comments.length, 1);
  assert.equal(linear.mutations().length, 1);
  const { input } = comments[0].body.variables;
  assert.equal(input.issueId, 'issue-1');
  assert.ok(input.body.includes(RUN_URL));
  assert.ok(input.body.includes(SHA));
  assert.ok(input.body.includes('`desktop-full-regression`: failure'));
  assert.ok(!input.body.includes('desktop-embedding-e2e'), 'only failed jobs are listed');
  assert.equal(result.summary, 'Linear: BST-2000 https://linear.app/x/BST-2000 (commented)\n');
});

test('green with one open issue adds a Recovered comment and never closes it', async () => {
  const linear = scriptedLinear({ issues: { issues: { nodes: [OPEN_ISSUE] } } });
  const result = await run(GREEN, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const mutations = linear.mutations();
  assert.equal(mutations.length, 1);
  assert.equal(linear.named('commentCreate').length, 1);
  assert.ok(mutations[0].body.variables.input.body.startsWith('Recovered: '));
  assert.equal(mutations[0].body.variables.input.body, `Recovered: ${RUN_URL}`);
  for (const { body } of linear.requests) {
    assert.doesNotMatch(body.query, /issueUpdate|issueArchive|issueDelete/);
    assert.equal(body.variables?.input?.stateId, undefined);
  }
  assert.equal(result.summary, 'Linear: BST-2000 https://linear.app/x/BST-2000 (recovered)\n');
});

test('green with no open issue makes no mutation and exits 0', async () => {
  const linear = scriptedLinear();
  const result = await run(GREEN, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linear.mutations().length, 0);
  assert.equal(result.summary, 'Linear: no open nightly issue; green\n');
});

test('green after a red night comments Recovered once, reading the issue comments', async () => {
  const linear = scriptedLinear({
    comments: commentsReply([RECOVERED_AT('01'), RED_AT('02')]),
    issues: { issues: { nodes: [OPEN_ISSUE] } },
  });
  const result = await run(GREEN, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linear.named('comments')[0].body.variables.id, 'issue-1');
  const mutations = linear.mutations();
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.variables.input.body, `Recovered: ${RUN_URL}`);
  assert.equal(result.summary, 'Linear: BST-2000 https://linear.app/x/BST-2000 (recovered)\n');
});

test('green when the newest comment is already Recovered makes no mutation', async () => {
  const linear = scriptedLinear({
    comments: commentsReply([RED_AT('05'), RECOVERED_AT('20'), RED_AT('10')]),
    issues: { issues: { nodes: [OPEN_ISSUE] } },
  });
  const result = await run(GREEN, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linear.mutations().length, 0);
  assert.equal(result.summary, 'Linear: BST-2000 already recovered\n');
});

test('comments returned out of order are sorted by createdAt: a newer red night beats an older Recovered', async () => {
  const linear = scriptedLinear({
    comments: commentsReply([RECOVERED_AT('02'), RED_AT('30'), RECOVERED_AT('03')]),
    issues: { issues: { nodes: [OPEN_ISSUE] } },
  });
  const result = await run(GREEN, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const mutations = linear.mutations();
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].body.variables.input.body, `Recovered: ${RUN_URL}`);
});

test('the comment search follows hasNextPage to the newest comment', async () => {
  const linear = scriptedLinear({
    comments: ({ variables }) =>
      json({
        data:
          variables.cursor === 'cursor-1'
            ? commentsReply([RECOVERED_AT('20')])
            : commentsReply([RED_AT('01')], { endCursor: 'cursor-1', hasNextPage: true }),
      }),
    issues: { issues: { nodes: [OPEN_ISSUE] } },
  });
  const result = await run(GREEN, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const pages = linear.named('comments');
  assert.deepEqual(
    pages.map(({ body }) => body.variables.cursor),
    [null, 'cursor-1']
  );
  assert.equal(linear.mutations().length, 0);
  assert.equal(result.summary, 'Linear: BST-2000 already recovered\n');
});

test('a next page without a cursor fails instead of looping', async () => {
  const linear = scriptedLinear({
    comments: commentsReply([RED_AT('01')], { endCursor: null, hasNextPage: true }),
    issues: { issues: { nodes: [OPEN_ISSUE] } },
  });
  const result = await run(GREEN, linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /no cursor/);
  assert.equal(linear.mutations().length, 0);
});

test('a workspace-level label is found and the create path succeeds', async () => {
  const workspaceCi = { id: 'label-ci-ws', name: 'area-ci', team: null };
  const linear = scriptedLinear({
    issueLabels: { issueLabels: { nodes: [ALERT_LABEL, workspaceCi, HUMAN_LABEL] } },
  });
  const result = await run(RED, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const [labels] = linear.named('issueLabels');
  assert.match(
    labels.body.query,
    /or:\s*\[\s*\{\s*team:\s*\{\s*key:\s*\{\s*eq:\s*"BST"\s*\}\s*\}\s*\},\s*\{\s*team:\s*\{\s*null:\s*true\s*\}\s*\}\s*\]/
  );
  assert.equal(linear.named('issueLabelCreate').length, 0);
  const [issueCreate] = linear.named('issueCreate');
  assert.deepEqual(issueCreate.body.variables.input.labelIds, [
    'label-alert',
    'label-ci-ws',
    'label-human',
  ]);
});

test('a label name matching at team and workspace scope is ambiguous and fails', async () => {
  const linear = scriptedLinear({
    issueLabels: {
      issueLabels: {
        nodes: [ALERT_LABEL, CI_LABEL, { ...CI_LABEL, id: 'label-ci-ws' }, HUMAN_LABEL],
      },
    },
  });
  const result = await run(RED, linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /2 label "area-ci".*expected exactly one/);
  assert.equal(linear.mutations().length, 0);
});

test('two open issues for one workflow fail without any mutation', async () => {
  const linear = scriptedLinear({
    issues: {
      issues: { nodes: [OPEN_ISSUE, { ...OPEN_ISSUE, id: 'issue-2', identifier: 'BST-2002' }] },
    },
  });
  const result = await run(RED, linear);

  assert.notEqual(result.exitCode, 0);
  assert.equal(linear.mutations().length, 0);
  assert.match(result.stderr, /BST-2000, BST-2002/);
});

test('GraphQL errors in a response fail the run', async () => {
  const linear = scriptedLinear({
    issues: () => json({ data: null, errors: [{ message: 'Field "bogus" is not defined' }] }),
  });
  const result = await run(RED, linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Field "bogus" is not defined/);
  assert.equal(linear.mutations().length, 0);
});

test('an HTTP 500 fails the run without echoing the API key', async () => {
  const linear = scriptedLinear({
    issues: () => new Response('upstream exploded', { status: 500 }),
  });
  const result = await run(RED, linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /HTTP 500/);
  assert.ok(!result.stderr.includes(API_KEY));
  assert.ok(!result.stdout.includes(API_KEY));
  assert.equal(linear.requests.length, 1, 'no retry after a failed response');
});

test('a missing nightly-alert label is provisioned once and the run proceeds', async () => {
  const linear = scriptedLinear({
    issueLabels: { issueLabels: { nodes: [CI_LABEL, HUMAN_LABEL] } },
  });
  const result = await run(RED, linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const labelCreates = linear.named('issueLabelCreate');
  assert.equal(labelCreates.length, 1);
  assert.deepEqual(labelCreates[0].body.variables, {
    color: '#E5484D',
    name: 'nightly-alert',
    teamId: 'team-1',
  });
  const [issueCreate] = linear.named('issueCreate');
  assert.deepEqual(issueCreate.body.variables.input.labelIds, [
    'label-alert-new',
    'label-ci',
    'label-human',
  ]);
});

test('a missing area-ci label fails the run before any mutation', async () => {
  const linear = scriptedLinear({
    issueLabels: { issueLabels: { nodes: [ALERT_LABEL, HUMAN_LABEL] } },
  });
  const result = await run(RED, linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /area-ci/);
  assert.equal(linear.mutations().length, 0);
});

test('a missing LINEAR_API_KEY fails the run before any fetch', async () => {
  const linear = scriptedLinear();
  const result = await run(RED, linear, { env: {} });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /LINEAR_API_KEY is not set/);
  assert.equal(linear.requests.length, 0);
});

test('a cancelled result is red and files an issue', async () => {
  const linear = scriptedLinear();
  const result = await run(
    argv('desktop-full-regression=cancelled,desktop-embedding-e2e=success'),
    linear
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linear.named('issueCreate').length, 1);
});

test('skipped and empty results are red too', async () => {
  for (const results of ['job=skipped', 'job=']) {
    const linear = scriptedLinear();
    const result = await run(argv(results), linear);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(linear.named('issueCreate').length, 1, `${results} must be red`);
  }
});

test('the Authorization header is the raw key, with no Bearer prefix', async () => {
  const linear = scriptedLinear();
  await run(RED, linear);

  assert.ok(linear.requests.length > 0);
  for (const { url, init } of linear.requests) {
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, API_KEY);
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
});

test('user-supplied strings travel in variables, never in the query text', async () => {
  const linear = scriptedLinear();
  await run(RED, linear);
  const dedup = scriptedLinear({ issues: { issues: { nodes: [OPEN_ISSUE] } } });
  await run(RED, dedup);

  for (const { body } of [...linear.requests, ...dedup.requests]) {
    assert.ok(!body.query.includes(WORKFLOW), 'workflow name leaked into the query text');
    assert.ok(!body.query.includes(RUN_URL), 'run URL leaked into the query text');
  }
  assert.equal(linear.named('issues')[0].body.variables.title, `Nightly red: ${WORKFLOW}`);
});

test('missing or malformed arguments exit 1 naming the problem and fetch nothing', async () => {
  const cases = [
    [['--workflow', WORKFLOW, '--results', 'job=failure', '--run-url', RUN_URL], /--sha/],
    [['--results', 'job=failure', '--run-url', RUN_URL, '--sha', SHA], /--workflow/],
    [argv('job-without-result'), /job=result/],
  ];
  for (const [args, expected] of cases) {
    const linear = scriptedLinear();
    const result = await run(args, linear);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, expected);
    assert.equal(linear.requests.length, 0);
  }
});

test('direct execution exits 1 with the key-missing message and no network', () => {
  const child = spawnSync(process.execPath, [scriptPath, ...RED], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });

  assert.equal(child.status, 1);
  assert.match(child.stderr, /LINEAR_API_KEY is not set/);
});
