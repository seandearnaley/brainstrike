import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readNightlyTestResults } from '../lib/nightly-test-results.mjs';
import { main } from '../notify-linear-nightly.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '../notify-linear-nightly.mjs');
const REPO_ROOT = path.resolve(here, '../..');
const API_KEY = 'lin_api_test_key_0000';
const WORKFLOW = 'Desktop E2E';
const RUN_URL = 'https://github.com/seandearnaley/brainstrike/actions/runs/42';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const GATE = 'desktop-full-regression-gate';
const EMBEDDING = 'desktop-embedding-e2e';
// A hosted runner's workspace: the reader keeps only apps/desktop/e2e.
const DESKTOP_ROOT = '/home/runner/work/brainstrike/brainstrike/apps/desktop/e2e';
const RECORDED_REPORT = path.join(here, 'fixtures/playwright-json-report.recorded.json');

const ALERT_LABEL = { id: 'label-alert', name: 'nightly-alert' };
const FLAKY_LABEL = { id: 'label-flaky', name: 'flaky' };
const CI_LABEL = { id: 'label-ci', name: 'area-ci' };
const HUMAN_LABEL = { id: 'label-human', name: 'needs-human' };
const ALL_LABELS = [ALERT_LABEL, FLAKY_LABEL, CI_LABEL, HUMAN_LABEL];

const temporaryDirs = [];
after(() => {
  for (const dir of temporaryDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function temporaryDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

/**
 * A Playwright JSON report in the reporter's real shape (see the recorded
 * fixture): file suites titled by their path, describes as nested suites.
 */
function playwrightReport(tests, { errors = [], rootDir = DESKTOP_ROOT } = {}) {
  const files = new Map();
  for (const t of tests) {
    const describe = t.describe ?? 'Suite';
    const fileSuite = files.get(t.file) ?? { file: t.file, specs: [], suites: [], title: t.file };
    files.set(t.file, fileSuite);
    let suite = fileSuite.suites.find((s) => s.title === describe);
    if (!suite) {
      suite = { file: t.file, specs: [], title: describe };
      fileSuite.suites.push(suite);
    }
    const attempts = { expected: 1, flaky: 2, skipped: 1, unexpected: 2 }[t.status] ?? 1;
    suite.specs.push({
      file: t.file,
      tests: [
        {
          projectName: t.project ?? 'regression',
          results: Array.from({ length: attempts }, (_, retry) => ({
            error: t.error && retry === 0 ? { message: t.error } : undefined,
            retry,
          })),
          status: t.status,
        },
      ],
      title: t.title,
    });
  }
  return { config: { rootDir }, errors, suites: [...files.values()] };
}

/** Writes `{ 'relative/path.json': value }` into a fresh --reports directory. */
function reportsDir(files = {}) {
  const dir = temporaryDir('nightly-results-');
  for (const [relative, value] of Object.entries(files)) {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return dir;
}

const failing = (title, file = 'chat.desktop.test.ts') => ({
  error: `\u001b[31mError: expected visible\u001b[39m\n  at ${file}:12`,
  file,
  status: 'unexpected',
  title,
});
const passing = (title, file = 'chat.desktop.test.ts') => ({ file, status: 'expected', title });
const flaky = (title, file = 'chat.desktop.test.ts') => ({
  error: 'Timed out 10000ms waiting for expect(locator).toBeVisible()',
  file,
  status: 'flaky',
  title,
});

function argv(results, reports) {
  return [
    '--workflow',
    WORKFLOW,
    '--results',
    results,
    '--reports',
    reports,
    '--run-url',
    RUN_URL,
    '--sha',
    SHA,
  ];
}

const RED_GATE = `${GATE}=failure,${EMBEDDING}=success`;
const GREEN = `${GATE}=success,${EMBEDDING}=success`;
const gateReport = (...tests) => ({
  [`nightly-results--${GATE}--shard-1/${GATE}/regression.json`]: playwrightReport(tests),
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/**
 * An in-memory Linear: issues and comments persist across runs on one
 * instance, and the open-issue search honours its description filter the way
 * Linear's `description: { contains }` does. `overrides` replace an
 * operation's reply, either as a `data` payload or as a function of the
 * request returning a Response.
 */
function fakeLinear({ issues = [], labels = ALL_LABELS, overrides = {} } = {}) {
  const store = {
    clock: Date.parse('2026-10-01T07:00:00.000Z'),
    issues: issues.map((issue) => ({ comments: [], labels: [ALERT_LABEL.name], ...issue })),
    labels: [...labels],
  };
  const requests = [];
  const tick = () => {
    store.clock += 60_000;
    return new Date(store.clock).toISOString();
  };
  const find = (id) => store.issues.find((issue) => issue.id === id);
  const toNode = (issue) => ({
    description: issue.description,
    id: issue.id,
    identifier: issue.identifier,
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    title: issue.title,
    url: issue.url,
  });
  const operations = {
    commentCreate: ({ input }) => {
      find(input.issueId).comments.push({ body: input.body, createdAt: tick() });
      return { commentCreate: { success: true } };
    },
    comments: ({ id }) => ({
      issue: {
        comments: { nodes: find(id).comments, pageInfo: { endCursor: null, hasNextPage: false } },
      },
    }),
    issueAddLabel: ({ id, labelId }) => {
      find(id).labels.push(store.labels.find((label) => label.id === labelId).name);
      return { issueAddLabel: { success: true } };
    },
    issueCreate: ({ input }) => {
      const number = 3000 + store.issues.length;
      const issue = {
        comments: [],
        description: input.description,
        id: `issue-${number}`,
        identifier: `BST-${number}`,
        labels: input.labelIds.map((id) => store.labels.find((label) => label.id === id).name),
        title: input.title,
        url: `https://linear.app/x/BST-${number}`,
      };
      store.issues.push(issue);
      return {
        issueCreate: { issue: { identifier: issue.identifier, url: issue.url }, success: true },
      };
    },
    issueLabelCreate: ({ name }) => {
      const label = { id: `label-${name}-new`, name };
      store.labels.push(label);
      return { issueLabelCreate: { issueLabel: { id: label.id }, success: true } };
    },
    issueLabels: () => ({ issueLabels: { nodes: store.labels } }),
    issues: ({ marker }) => ({
      issues: {
        nodes: store.issues.filter((issue) => issue.description.includes(marker)).map(toNode),
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    }),
    teams: () => ({ teams: { nodes: [{ id: 'team-1' }] } }),
    viewer: () => ({ viewer: { id: 'user-1' } }),
    workflowStates: () => ({ workflowStates: { nodes: [{ id: 'state-todo' }] } }),
  };
  const operationOf = (query) =>
    Object.keys(operations).find((name) => new RegExp(`\\b${name}\\b`).test(query));

  async function fetchImpl(url, init) {
    const body = JSON.parse(init.body);
    requests.push({ body, init, url });
    const name = operationOf(body.query);
    assert.ok(name, `unscripted Linear operation: ${body.query}`);
    const override = overrides[name];
    if (typeof override === 'function') {
      return override(body);
    }
    return json({ data: override ?? operations[name](body.variables) });
  }

  return {
    fetchImpl,
    issue: (identifier) => store.issues.find((issue) => issue.identifier === identifier),
    issues: store.issues,
    mutations: () => requests.filter(({ body }) => /^\s*mutation\b/.test(body.query)),
    named: (name) => requests.filter(({ body }) => new RegExp(`\\b${name}\\b`).test(body.query)),
    requests,
    reset: () => requests.splice(0),
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
  linear.reset();
  const dir = temporaryDir('notify-linear-');
  const stepSummaryPath = path.join(dir, 'summary.md');
  const githubOutputPath = path.join(dir, 'github-output');
  const stdout = sink();
  const stderr = sink();
  const exitCode = await main({
    argv: args,
    env,
    fetchImpl: linear.fetchImpl,
    githubOutputPath,
    stderr,
    stdout,
    stepSummaryPath,
  });
  const readIfWritten = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      // Not written; asserted by the tests that care.
      return '';
    }
  };
  return {
    exitCode,
    githubOutput: readIfWritten(githubOutputPath),
    stderr: stderr.text,
    stdout: stdout.text,
    summary: readIfWritten(stepSummaryPath),
  };
}

const createdInputs = (linear) =>
  linear.named('issueCreate').map(({ body }) => body.variables.input);
const commentsOn = (linear, issueId) =>
  linear
    .named('commentCreate')
    .map(({ body }) => body.variables.input)
    .filter((input) => input.issueId === issueId)
    .map((input) => input.body);
const identityOf = (description) => description.match(/nightly-identity:[0-9a-f]{24}/gu);

test('RED-FIRST: two failing tests file two issues, one per identity', async () => {
  const linear = fakeLinear();
  const reports = reportsDir(
    gateReport(failing('sends a message'), failing('renders history', 'history.desktop.test.ts'))
  );
  const result = await run(argv(RED_GATE, reports), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const created = createdInputs(linear);
  assert.equal(created.length, 2);
  assert.equal(linear.mutations().length, 2, 'no workflow-level issue: every red job is explained');
  const [first, second] = created;
  assert.equal(
    first.title,
    'Nightly red: Desktop E2E › chat.desktop.test.ts › [regression] › Suite › sends a message'
  );
  assert.equal(
    second.title,
    'Nightly red: Desktop E2E › history.desktop.test.ts › [regression] › Suite › renders history'
  );
  assert.notDeepEqual(identityOf(first.description), identityOf(second.description));
  for (const input of created) {
    assert.equal(identityOf(input.description).length, 1);
    assert.deepEqual(input.labelIds, ['label-alert', 'label-ci', 'label-human']);
    assert.equal(input.stateId, 'state-todo');
    assert.equal(input.assigneeId, 'user-1');
    assert.equal(input.teamId, 'team-1');
    assert.equal(input.priority, 2);
    assert.ok(input.description.includes(RUN_URL));
    assert.ok(input.description.includes(SHA));
    assert.ok(input.description.includes(`- Job: \`${GATE}\``));
    assert.match(input.description, /\d{4}-\d{2}-\d{2}/);
  }
  assert.ok(first.description.includes('- Spec: `apps/desktop/e2e/chat.desktop.test.ts`'));
  assert.ok(first.description.includes('- Test: `[regression] › Suite › sends a message`'));
  assert.ok(first.description.includes('Error: expected visible'), 'the error excerpt is filed');
  assert.ok(!first.description.includes('\u001b['), 'ANSI colour codes are stripped');
  assert.equal(
    result.summary,
    'Linear: BST-3000 https://linear.app/x/BST-3000 (created)\nLinear: BST-3001 https://linear.app/x/BST-3001 (created)\n'
  );
});

test('RED-FIRST: the same failure the next night comments on its issue instead of filing a second', async () => {
  const linear = fakeLinear();
  const reports = reportsDir(gateReport(failing('sends a message')));
  assert.equal((await run(argv(RED_GATE, reports), linear)).exitCode, 0);
  const [filed] = linear.issues;
  // A human retitles the issue: the identity marker in its description still finds it.
  filed.title = 'Chat send flakes under load (triaged)';

  const second = await run(argv(RED_GATE, reports), linear);

  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(linear.named('issueCreate').length, 0, 'deduplicated by identity, not by title');
  assert.equal(linear.issues.length, 1);
  const [comment] = commentsOn(linear, filed.id);
  assert.match(comment, /^Red again: /u);
  assert.ok(comment.includes(SHA));
  assert.ok(comment.includes(`\`${GATE}\``));
  assert.equal(second.summary, `Linear: ${filed.identifier} ${filed.url} (commented)\n`);
});

test('RED-FIRST: a recovery comments only on the recovered test’s own issue', async () => {
  const linear = fakeLinear();
  const night1 = reportsDir(
    gateReport(failing('sends a message'), failing('renders history'), failing('opens settings'))
  );
  assert.equal((await run(argv(RED_GATE, night1), linear)).exitCode, 0);
  const [sends, renders, settings] = linear.issues;

  // Night 2 is still red: one test recovers, one fails again, one never ran.
  const night2 = reportsDir(gateReport(passing('sends a message'), failing('renders history')));
  const result = await run(argv(RED_GATE, night2), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linear.named('issueCreate').length, 0);
  assert.deepEqual(commentsOn(linear, sends.id), [`Recovered: ${RUN_URL}`]);
  assert.match(commentsOn(linear, renders.id)[0], /^Red again: /u);
  assert.equal(commentsOn(linear, renders.id).length, 1);
  assert.deepEqual(commentsOn(linear, settings.id), [], 'a test that did not run is not recovered');
});

test('RED-FIRST: a test that passes only on retry gets the flaky label and its own issue', async () => {
  const linear = fakeLinear({ labels: [ALERT_LABEL, CI_LABEL, HUMAN_LABEL] });
  const reports = reportsDir(gateReport(passing('sends a message'), flaky('renders history')));
  const result = await run(argv(GREEN, reports), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const [labelCreate] = linear.named('issueLabelCreate');
  assert.deepEqual(labelCreate.body.variables, {
    color: '#F2994A',
    name: 'flaky',
    teamId: 'team-1',
  });
  const created = createdInputs(linear);
  assert.equal(created.length, 1, 'a green night still files its flaky test');
  assert.equal(
    created[0].title,
    'Nightly flaky: Desktop E2E › chat.desktop.test.ts › [regression] › Suite › renders history'
  );
  assert.deepEqual(created[0].labelIds, [
    'label-alert',
    'label-flaky-new',
    'label-ci',
    'label-human',
  ]);
  assert.ok(created[0].description.includes('passed this test only on retry'));
  assert.ok(
    created[0].description.includes('stays in the gate until this issue decides otherwise')
  );
});

test('a failing test that flakes the next night is commented and gains the flaky label', async () => {
  const linear = fakeLinear();
  assert.equal(
    (await run(argv(RED_GATE, reportsDir(gateReport(failing('renders history')))), linear))
      .exitCode,
    0
  );
  const [issue] = linear.issues;

  const result = await run(argv(GREEN, reportsDir(gateReport(flaky('renders history')))), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linear.named('issueCreate').length, 0);
  assert.match(commentsOn(linear, issue.id)[0], /^Passed only on retry: /u);
  assert.deepEqual(linear.named('issueAddLabel')[0].body.variables, {
    id: issue.id,
    labelId: 'label-flaky',
  });
  assert.ok(issue.labels.includes('flaky'));

  // Flaky again: the label is already there, so only the comment is added.
  await run(argv(GREEN, reportsDir(gateReport(flaky('renders history')))), linear);
  assert.equal(linear.named('issueAddLabel').length, 0);
  assert.equal(linear.mutations().length, 1);
});

test('RED-FIRST: a red workflow with no parseable results files one workflow-level issue', async () => {
  const linear = fakeLinear();
  const result = await run(argv(`${GATE}=failure,${EMBEDDING}=cancelled`, reportsDir()), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const created = createdInputs(linear);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Nightly red: Desktop E2E');
  assert.ok(
    created[0].description.includes(`\`${GATE}\` is failure, but it uploaded no test results.`)
  );
  assert.ok(
    created[0].description.includes(
      `\`${EMBEDDING}\` is cancelled, but it uploaded no test results.`
    )
  );
  assert.deepEqual(created[0].labelIds, ['label-alert', 'label-ci', 'label-human']);

  // The next unparseable red night comments on the same workflow-level issue.
  const again = await run(argv(`${GATE}=failure,${EMBEDDING}=success`, reportsDir()), linear);
  assert.equal(again.exitCode, 0, again.stderr);
  assert.equal(linear.named('issueCreate').length, 0);
  const [comment] = commentsOn(linear, linear.issues[0].id);
  assert.match(comment, /^Red again: /u);
  assert.ok(comment.includes(`\`${GATE}\` is failure`));
  assert.ok(!comment.includes(EMBEDDING), 'only tonight’s unexplained jobs are listed');
});

test('a red job beside an explained one still reaches the workflow-level issue', async () => {
  const linear = fakeLinear();
  const reports = reportsDir(gateReport(failing('sends a message')));
  const result = await run(argv(`${GATE}=failure,${EMBEDDING}=failure`, reports), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const titles = createdInputs(linear).map((input) => input.title);
  assert.deepEqual(titles, [
    'Nightly red: Desktop E2E › chat.desktop.test.ts › [regression] › Suite › sends a message',
    'Nightly red: Desktop E2E',
  ]);
  assert.ok(createdInputs(linear)[1].description.includes(`\`${EMBEDDING}\` is failure`));
  assert.ok(!createdInputs(linear)[1].description.includes(`\`${GATE}\` is`));
});

test('unreadable reports and run errors are filed, never skipped', async () => {
  const linear = fakeLinear();
  const reports = reportsDir({
    [`a/${GATE}/regression.json`]: playwrightReport([passing('sends a message')], {
      errors: [{ message: 'Timed out waiting 1800s for the test suite to run' }],
    }),
    [`b/${EMBEDDING}/embedding.json`]: '{ "truncated": ',
    [`c/${EMBEDDING}/other.json`]: { not: 'a playwright report' },
    'd/desktop-unknown-job/x.json': playwrightReport([passing('x')]),
    'loose.json': playwrightReport([]),
    [`e/${EMBEDDING}/elsewhere.json`]: playwrightReport([passing('x')], {
      rootDir: '/nowhere/absent-e2e',
    }),
  });
  const result = await run(argv(`${GATE}=failure,${EMBEDDING}=failure`, reports), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const [workflowIssue] = createdInputs(linear);
  assert.equal(workflowIssue.title, 'Nightly red: Desktop E2E');
  for (const expected of [
    `\`${GATE}\` is failure, but its test results show no failing test.`,
    'reports a run error: Timed out waiting 1800s for the test suite to run',
    'is not valid JSON',
    'is not a Playwright JSON report',
    'Results directory `desktop-unknown-job` names no job in --results.',
    '`loose.json` is not inside a job directory.',
    'names rootDir /nowhere/absent-e2e, which is not a directory of this checkout',
  ]) {
    assert.ok(workflowIssue.description.includes(expected), `missing: ${expected}`);
  }
});

test('the recorded Playwright 1.64.1 JSON report parses into failed, flaky and passed tests', () => {
  // Recorded from a real run (four tests: pass, fail, pass-on-retry, skip) with
  // the host's paths rewritten to the hosted runner's workspace layout.
  const reports = reportsDir({
    [`${GATE}/regression.json`]: readFileSync(RECORDED_REPORT, 'utf8'),
  });
  const { problems, tests } = readNightlyTestResults({ repoRoot: REPO_ROOT, reportsDir: reports });

  assert.deepEqual(problems, []);
  assert.deepEqual(
    tests.map(({ job, outcome, spec, title }) => ({ job, outcome, spec, title })),
    [
      {
        job: GATE,
        outcome: 'passed',
        spec: 'apps/desktop/e2e/nightly-fixture.desktop.test.ts',
        title: '[regression] › Nightly fixture › passes',
      },
      {
        job: GATE,
        outcome: 'failed',
        spec: 'apps/desktop/e2e/nightly-fixture.desktop.test.ts',
        title: '[regression] › Nightly fixture › fails every attempt',
      },
      {
        job: GATE,
        outcome: 'flaky',
        spec: 'apps/desktop/e2e/nightly-fixture.desktop.test.ts',
        title: '[regression] › Nightly fixture › passes only on retry',
      },
    ]
  );
  const failed = tests.find((t) => t.outcome === 'failed');
  assert.match(failed.error, /Expected: 2/u);
  assert.ok(!failed.error.includes('\u001b['), 'ANSI colour codes are stripped');
});

test('a green night recovers every open issue of its workflow, once', async () => {
  const linear = fakeLinear();
  await run(argv(RED_GATE, reportsDir(gateReport(failing('sends a message')))), linear);
  await run(
    argv(
      `${GATE}=success,${EMBEDDING}=failure`,
      reportsDir(gateReport(passing('sends a message')))
    ),
    linear
  );
  const [testIssue, workflowIssue] = linear.issues;
  assert.equal(workflowIssue.title, 'Nightly red: Desktop E2E');

  const green = await run(argv(GREEN, reportsDir()), linear);

  assert.equal(green.exitCode, 0, green.stderr);
  assert.deepEqual(commentsOn(linear, workflowIssue.id), [`Recovered: ${RUN_URL}`]);
  assert.deepEqual(commentsOn(linear, testIssue.id), [], 'already recovered on the red night');
  for (const { body } of linear.requests) {
    assert.doesNotMatch(body.query, /issueUpdate|issueArchive|issueDelete/);
  }
  assert.equal(
    green.summary,
    `Linear: ${workflowIssue.identifier} ${workflowIssue.url} (recovered)\nLinear: ${testIssue.identifier} already recovered\n`
  );

  const again = await run(argv(GREEN, reportsDir()), linear);
  assert.equal(again.exitCode, 0, again.stderr);
  assert.equal(linear.mutations().length, 0, 'a second green night adds nothing');
});

test('fix_issues lists tonight’s failing and flaky tests’ issues, never the workflow-level one', async () => {
  const linear = fakeLinear();
  const night1 = reportsDir(gateReport(failing('sends a message'), passing('renders history')));
  const first = await run(argv(`${GATE}=failure,${EMBEDDING}=failure`, night1), linear);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.deepEqual(
    linear.issues.map((issue) => issue.title.split(' › ')[0]),
    ['Nightly red: Desktop E2E', 'Nightly red: Desktop E2E'],
    'one test issue and the workflow-level issue'
  );
  assert.equal(first.githubOutput, 'fix_issues=["BST-3000"]\n');

  const night2 = reportsDir(gateReport(failing('sends a message'), flaky('renders history')));
  const second = await run(argv(`${GATE}=failure,${EMBEDDING}=success`, night2), linear);
  assert.equal(second.exitCode, 0, second.stderr);
  assert.equal(
    second.githubOutput,
    'fix_issues=["BST-3000","BST-3002"]\n',
    'commented and created'
  );

  const green = await run(argv(GREEN, reportsDir(gateReport(passing('sends a message')))), linear);
  assert.equal(green.githubOutput, 'fix_issues=[]\n', 'recoveries are not fix work');
});

test('green with no open issue makes no mutation and exits 0', async () => {
  const linear = fakeLinear();
  const result = await run(argv(GREEN, reportsDir(gateReport(passing('sends a message')))), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(linear.mutations().length, 0);
  assert.equal(result.summary, 'Linear: no open nightly issue for Desktop E2E; nothing to file\n');
});

test('the open-issue search asks Linear for this workflow’s marker, open and labelled', async () => {
  const linear = fakeLinear();
  await run(argv(GREEN, reportsDir()), linear);

  const [search] = linear.named('issues');
  assert.match(search.body.variables.marker, /^nightly-workflow:[0-9a-f]{24}$/u);
  assert.match(search.body.query, /description:\s*\{\s*contains:\s*\$marker\s*\}/u);
  assert.match(search.body.query, /labels:\s*\{\s*name:\s*\{\s*eq:\s*"nightly-alert"\s*\}\s*\}/u);
  assert.match(search.body.query, /state:\s*\{\s*type:\s*\{\s*nin:\s*\["completed", "canceled"\]/u);
});

const RECOVERED_AT = (day) => ({
  body: `Recovered: ${RUN_URL}`,
  createdAt: `2026-09-${day}T07:00:00.000Z`,
});
const RED_AT = (day) => ({
  body: `Red again: ${RUN_URL}`,
  createdAt: `2026-09-${day}T07:00:00.000Z`,
});

async function openTestIssue() {
  const linear = fakeLinear();
  await run(argv(RED_GATE, reportsDir(gateReport(failing('sends a message')))), linear);
  return { issue: linear.issues[0], linear };
}

test('comments returned out of order are sorted by createdAt: a newer red night beats an older Recovered', async () => {
  const { issue, linear } = await openTestIssue();
  issue.comments.push(RECOVERED_AT('02'), RED_AT('30'), RECOVERED_AT('03'));
  await run(argv(GREEN, reportsDir()), linear);

  assert.deepEqual(commentsOn(linear, issue.id), [`Recovered: ${RUN_URL}`]);
});

test('the comment search follows hasNextPage to the newest comment', async () => {
  const { issue } = await openTestIssue();
  const pages = (variables) =>
    json({
      data: {
        issue: {
          comments:
            variables.cursor === 'cursor-1'
              ? { nodes: [RECOVERED_AT('20')], pageInfo: { endCursor: null, hasNextPage: false } }
              : { nodes: [RED_AT('01')], pageInfo: { endCursor: 'cursor-1', hasNextPage: true } },
        },
      },
    });
  const paged = fakeLinear({
    issues: [issue],
    overrides: { comments: ({ variables }) => pages(variables) },
  });
  const result = await run(argv(GREEN, reportsDir()), paged);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(
    paged.named('comments').map(({ body }) => body.variables.cursor),
    [null, 'cursor-1']
  );
  assert.equal(paged.mutations().length, 0);
  assert.equal(result.summary, `Linear: ${issue.identifier} already recovered\n`);
});

test('a next page without a cursor fails instead of looping', async () => {
  const { issue } = await openTestIssue();
  const stuck = fakeLinear({
    issues: [issue],
    overrides: {
      comments: {
        issue: {
          comments: { nodes: [RED_AT('01')], pageInfo: { endCursor: null, hasNextPage: true } },
        },
      },
    },
  });
  const result = await run(argv(GREEN, reportsDir()), stuck);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /no cursor/);
  assert.equal(stuck.mutations().length, 0);
});

test('two open issues for one identity fail without any mutation', async () => {
  const { issue } = await openTestIssue();
  const twin = { ...issue, comments: [], id: 'issue-twin', identifier: 'BST-2002' };
  const linear = fakeLinear({ issues: [issue, twin] });
  const result = await run(
    argv(RED_GATE, reportsDir(gateReport(failing('sends a message')))),
    linear
  );

  assert.notEqual(result.exitCode, 0);
  assert.equal(linear.mutations().length, 0);
  assert.match(result.stderr, new RegExp(`${issue.identifier}, BST-2002`, 'u'));
});

test('an issue with the workflow marker but no identity marker fails without any mutation', async () => {
  const { issue } = await openTestIssue();
  const edited = {
    ...issue,
    description: issue.description.replace(/nightly-identity:[0-9a-f]+/u, ''),
  };
  const linear = fakeLinear({ issues: [edited] });
  const result = await run(
    argv(RED_GATE, reportsDir(gateReport(failing('sends a message')))),
    linear
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /0 identity markers; expected exactly one/u);
  assert.equal(linear.mutations().length, 0);
});

test('a workspace-level label is found and the create path succeeds', async () => {
  const workspaceCi = { id: 'label-ci-ws', name: 'area-ci', team: null };
  const linear = fakeLinear({ labels: [ALERT_LABEL, workspaceCi, HUMAN_LABEL] });
  const result = await run(argv(RED_GATE, reportsDir(gateReport(failing('x')))), linear);

  assert.equal(result.exitCode, 0, result.stderr);
  const [labels] = linear.named('issueLabels');
  assert.match(
    labels.body.query,
    /or:\s*\[\s*\{\s*team:\s*\{\s*key:\s*\{\s*eq:\s*"BST"\s*\}\s*\}\s*\},\s*\{\s*team:\s*\{\s*null:\s*true\s*\}\s*\}\s*\]/
  );
  assert.equal(linear.named('issueLabelCreate').length, 0, 'flaky is provisioned only when needed');
  assert.deepEqual(createdInputs(linear)[0].labelIds, [
    'label-alert',
    'label-ci-ws',
    'label-human',
  ]);
});

test('a label name matching at team and workspace scope is ambiguous and fails', async () => {
  const linear = fakeLinear({
    labels: [ALERT_LABEL, CI_LABEL, { ...CI_LABEL, id: 'label-ci-ws' }, HUMAN_LABEL],
  });
  const result = await run(argv(RED_GATE, reportsDir(gateReport(failing('x')))), linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /2 label "area-ci".*expected exactly one/);
  assert.equal(linear.mutations().length, 0);
});

test('a missing nightly-alert label is provisioned once and the run proceeds', async () => {
  const linear = fakeLinear({ labels: [CI_LABEL, HUMAN_LABEL] });
  const result = await run(
    argv(RED_GATE, reportsDir(gateReport(failing('x'), failing('y')))),
    linear
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const labelCreates = linear.named('issueLabelCreate');
  assert.equal(labelCreates.length, 1);
  assert.deepEqual(labelCreates[0].body.variables, {
    color: '#E5484D',
    name: 'nightly-alert',
    teamId: 'team-1',
  });
  for (const input of createdInputs(linear)) {
    assert.deepEqual(input.labelIds, ['label-nightly-alert-new', 'label-ci', 'label-human']);
  }
});

test('a missing area-ci label fails the run before any mutation', async () => {
  const linear = fakeLinear({ labels: [ALERT_LABEL, HUMAN_LABEL] });
  const result = await run(argv(RED_GATE, reportsDir(gateReport(failing('x')))), linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /area-ci/);
  assert.equal(linear.mutations().length, 0);
});

test('GraphQL errors in a response fail the run', async () => {
  const linear = fakeLinear({
    overrides: {
      issues: () => json({ data: null, errors: [{ message: 'Field "bogus" is not defined' }] }),
    },
  });
  const result = await run(argv(RED_GATE, reportsDir()), linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /Field "bogus" is not defined/);
  assert.equal(linear.mutations().length, 0);
});

test('an HTTP 500 fails the run without echoing the API key', async () => {
  const linear = fakeLinear({
    overrides: { issues: () => new Response('upstream exploded', { status: 500 }) },
  });
  const result = await run(argv(RED_GATE, reportsDir()), linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /HTTP 500/);
  assert.ok(!result.stderr.includes(API_KEY));
  assert.ok(!result.stdout.includes(API_KEY));
  assert.equal(linear.requests.length, 1, 'no retry after a failed response');
});

test('a missing LINEAR_API_KEY fails the run before any fetch', async () => {
  const linear = fakeLinear();
  const result = await run(argv(RED_GATE, reportsDir()), linear, { env: {} });

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /LINEAR_API_KEY is not set/);
  assert.equal(linear.requests.length, 0);
});

test('a missing --reports directory fails the run before any fetch', async () => {
  const linear = fakeLinear();
  const missing = path.join(temporaryDir('notify-linear-'), 'absent');
  const result = await run(argv(RED_GATE, missing), linear);

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--reports directory .*absent does not exist/u);
  assert.equal(linear.requests.length, 0);
});

test('cancelled, skipped and empty results are red too', async () => {
  for (const results of ['job=cancelled', 'job=skipped', 'job=']) {
    const linear = fakeLinear();
    const result = await run(argv(results, reportsDir()), linear);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(linear.named('issueCreate').length, 1, `${results} must be red`);
  }
});

test('the Authorization header is the raw key, with no Bearer prefix', async () => {
  const linear = fakeLinear();
  await run(argv(RED_GATE, reportsDir(gateReport(failing('x')))), linear);

  assert.ok(linear.requests.length > 0);
  for (const { url, init } of linear.requests) {
    assert.equal(url, 'https://api.linear.app/graphql');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, API_KEY);
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
});

test('user-supplied strings travel in variables, never in the query text', async () => {
  const linear = fakeLinear();
  const reports = reportsDir(gateReport(failing('sends a message')));
  await run(argv(RED_GATE, reports), linear);
  const firstNight = [...linear.requests];
  await run(argv(RED_GATE, reports), linear);

  for (const { body } of [...firstNight, ...linear.requests]) {
    for (const text of [WORKFLOW, RUN_URL, 'sends a message', 'nightly-workflow:']) {
      assert.ok(!body.query.includes(text), `${text} leaked into the query text`);
    }
  }
});

test('missing or malformed arguments exit 1 naming the problem and fetch nothing', async () => {
  const reports = reportsDir();
  const cases = [
    [argv('job=failure', reports).slice(0, -2), /--sha/],
    [argv('job=failure', reports).slice(2), /--workflow/],
    [
      argv('job=failure', reports).filter(
        (arg, i, all) => arg !== '--reports' && all[i - 1] !== '--reports'
      ),
      /--reports/,
    ],
    [argv('job-without-result', reports), /job=result/],
  ];
  for (const [args, expected] of cases) {
    const linear = fakeLinear();
    const result = await run(args, linear);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, expected);
    assert.equal(linear.requests.length, 0);
  }
});

test('direct execution exits 1 with the key-missing message and no network', () => {
  const child = spawnSync(process.execPath, [scriptPath, ...argv(RED_GATE, reportsDir())], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });

  assert.equal(child.status, 1);
  assert.match(child.stderr, /LINEAR_API_KEY is not set/);
});
