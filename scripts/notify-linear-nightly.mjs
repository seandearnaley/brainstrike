#!/usr/bin/env node

// Files a nightly workflow's results to Linear (BST-1915, BST-2189).
//
// Each failing test gets its own open `nightly-alert` issue, found again by an
// identity marker in its description (workflow, spec path and full title), never
// by its title. A further red night comments on that issue, and the first night
// the test passes comments `Recovered:` on it alone. A test that passed only on
// retry gets the `flaky` label and its own issue. A red job is judged part by
// part (each shard on its own): a red part with no failing test to show for
// it, a part that uploaded nothing, or a report that cannot be read goes to one
// workflow-level issue instead of being dropped. The script never closes or
// reopens an issue. Zero dependencies: Node's native fetch.
//
//   node scripts/notify-linear-nightly.mjs --workflow <name> \
//     --results <job=result,...> --reports <dir> [--parts <job=part part,...>] \
//     --run-url <url> --sha <sha>
//
// Green means every result is exactly `success`. `cancelled` is red: on
// `schedule` a timeout is reported as `cancelled` and must alert. --reports
// holds the results the workflow uploaded, laid out as
// scripts/lib/nightly-test-results.mjs describes. --parts names each job's
// parts when it has more than one (a shard matrix); every other job has the one
// part `main`. In GitHub Actions the step output `fix_issues` lists, as JSON,
// the failing and flaky tests' issues this run filed or commented on: the
// nightly fix agent's queue.

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  allPages,
  assertSucceeded,
  createLinearClient,
  exactlyOne,
  nodesOf,
} from './lib/linear-api.mjs';
import { readNightlyTestResults } from './lib/nightly-test-results.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUCCESS = 'success';
const RECOVERED_PREFIX = 'Recovered:';
const HIGH_PRIORITY = 2;
const ALERT_LABEL = { color: '#E5484D', name: 'nightly-alert' };
const FLAKY_LABEL = { color: '#F2994A', name: 'flaky' };
const REQUIRED_LABEL_NAMES = ['area-ci', 'needs-human'];
const REQUIRED_FLAGS = ['workflow', 'results', 'reports', 'run-url', 'sha'];
const TITLE_LIMIT = 200;
const MARKER_DIGEST_LENGTH = 24;
const IDENTITY_MARKER = /nightly-identity:[0-9a-f]{24}/gu;
const OUTCOME_RANK = { failed: 2, flaky: 1, passed: 0 };
const SINGLE_PART = 'main';
const TEST_LIFECYCLE =
  'Stays open until a human closes it. Each further night this test fails or passes only on retry adds a comment; the first night it passes adds a recovered comment; a failure after you close it opens a new issue.';
const FLAKY_POLICY = 'A flaky test stays in the gate until this issue decides otherwise.';
const WORKFLOW_LIFECYCLE =
  'Stays open until a human closes it. Each further night with such a job adds a comment; the first night without one adds a recovered comment; one after you close it opens a new issue.';

const TEAM_QUERY = 'query { teams(filter: { key: { eq: "BST" } }) { nodes { id } } }';
const STATE_QUERY =
  'query { workflowStates(filter: { team: { key: { eq: "BST" } }, name: { eq: "Todo" } }) { nodes { id } } }';
const LABELS_QUERY = `query {
  issueLabels(filter: {
    or: [{ team: { key: { eq: "BST" } } }, { team: { null: true } }],
    name: { in: ["nightly-alert", "flaky", "area-ci", "needs-human"] }
  }) { nodes { id name } }
}`;
const VIEWER_QUERY = 'query { viewer { id } }';
const OPEN_ISSUES_QUERY = `query ($marker: String!, $cursor: String) {
  issues(first: 100, after: $cursor, filter: {
    team: { key: { eq: "BST" } },
    labels: { name: { eq: "nightly-alert" } },
    description: { contains: $marker },
    state: { type: { nin: ["completed", "canceled"] } }
  }) {
    nodes { id identifier url description labels { nodes { name } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const COMMENTS_QUERY = `query ($id: String!, $cursor: String) {
  issue(id: $id) {
    comments(first: 250, after: $cursor) {
      nodes { body createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const LABEL_CREATE_MUTATION = `mutation ($teamId: String!, $name: String!, $color: String!) {
  issueLabelCreate(input: { teamId: $teamId, name: $name, color: $color }) {
    success
    issueLabel { id }
  }
}`;
const ISSUE_CREATE_MUTATION = `mutation ($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { identifier url } }
}`;
const COMMENT_CREATE_MUTATION = `mutation ($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;
const ADD_LABEL_MUTATION = `mutation ($id: String!, $labelId: String!) {
  issueAddLabel(id: $id, labelId: $labelId) { success }
}`;

/** `job=result,...` into its entries; scripts/nightly-results-artifacts.mjs reads the same input. */
export function parseResults(raw) {
  return raw.split(',').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new Error(`--results entry "${entry}" is not job=result.`);
    }
    return { job: entry.slice(0, separator), result: entry.slice(separator + 1) };
  });
}

/** `job=part part,job=part` into a Map of each job's parts; a job may appear once. */
function parseParts(raw, results) {
  const parts = new Map();
  for (const entry of raw.split(',').filter((text) => text.trim())) {
    const separator = entry.indexOf('=');
    const job = entry.slice(0, separator).trim();
    const names = entry
      .slice(separator + 1)
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    if (separator < 1 || names.length === 0) {
      throw new Error(`--parts entry "${entry}" is not job=part part ….`);
    }
    if (!results.some((result) => result.job === job) || parts.has(job)) {
      throw new Error(`--parts names ${job}, which is not exactly one --results job.`);
    }
    parts.set(job, names);
  }
  return parts;
}

function parseCli(argv) {
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv,
    options: {
      parts: { type: 'string' },
      reports: { type: 'string' },
      results: { type: 'string' },
      'run-url': { type: 'string' },
      sha: { type: 'string' },
      workflow: { type: 'string' },
    },
    strict: true,
  });
  const missing = REQUIRED_FLAGS.filter((flag) => !values[flag]);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.map((f) => `--${f}`).join(', ')}.`);
  }
  const results = parseResults(values.results);
  return {
    parts: parseParts(values.parts ?? '', results),
    reportsDir: values.reports,
    results,
    runUrl: values['run-url'],
    sha: values.sha,
    workflow: values.workflow,
  };
}

function marker(kind, parts) {
  const digest = createHash('sha256').update(parts.join('\n')).digest('hex');
  return `${kind}:${digest.slice(0, MARKER_DIGEST_LENGTH)}`;
}

const workflowMarker = (workflow) => marker('nightly-workflow', [workflow]);
const workflowIdentity = (workflow) => marker('nightly-identity', ['workflow', workflow]);
const testIdentity = (workflow, { spec, title }) =>
  marker('nightly-identity', ['test', workflow, spec, title]);

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Tonight's tests by identity. A test seen in two jobs keeps its worst outcome. */
function testsByIdentity(workflow, tests) {
  const byIdentity = new Map();
  for (const test of tests) {
    const identity = testIdentity(workflow, test);
    const seen = byIdentity.get(identity);
    const jobs = new Set([...(seen?.jobs ?? []), test.job]);
    const worst = seen && OUTCOME_RANK[seen.outcome] >= OUTCOME_RANK[test.outcome] ? seen : test;
    byIdentity.set(identity, { ...worst, identity, jobs });
  }
  return byIdentity;
}

/**
 * Every red part no failing test of its own explains, every part that should
 * have reported and did not, and every report that could not be read. A part
 * is judged alone: a sibling shard's failing test never explains it.
 */
function findGaps(results, declaredParts, { parts, problems, tests }) {
  const failingParts = new Set(
    tests.filter((t) => t.outcome === 'failed').map((t) => `${t.job}/${t.part}`)
  );
  const expected = new Set();
  const gaps = [];
  for (const { job, result } of results) {
    const declared = declaredParts.get(job);
    const names = declared ?? [SINGLE_PART];
    for (const name of names) {
      expected.add(`${job}/${name}`);
    }
    if (result === SUCCESS) {
      continue;
    }
    const verdict = `${result || '(no result)'}`;
    const who = (name) => (declared ? `\`${job}\` part \`${name}\`` : `\`${job}\``);
    let allGreen = true;
    for (const name of names) {
      const part = parts.get(`${job}/${name}`);
      if (part?.status === SUCCESS) {
        continue;
      }
      allGreen = false;
      if (!part) {
        gaps.push(
          declared
            ? `${who(name)} uploaded no test results (\`${job}\` is ${verdict}).`
            : `\`${job}\` is ${verdict}, but it uploaded no test results.`
        );
      } else if (!part.status) {
        gaps.push(`${who(name)} recorded no job status (\`${job}\` is ${verdict}).`);
      } else if (!failingParts.has(`${job}/${name}`)) {
        gaps.push(`${who(name)} is ${part.status}, but its test results show no failing test.`);
      }
    }
    if (allGreen) {
      gaps.push(`\`${job}\` is ${verdict}, but every part reports success.`);
    }
  }
  for (const key of parts.keys()) {
    if (!expected.has(key)) {
      gaps.push(`Results part \`${key}\` names no job and part in --results and --parts.`);
    }
  }
  for (const { file, reason } of problems) {
    gaps.push(`\`${file}\` ${reason}.`);
  }
  return gaps;
}

function jobList(jobs) {
  return [...jobs].map((job) => `\`${job}\``).join(', ');
}

function errorBlock(error) {
  return error ? ['', 'Error:', '````text', error, '````'] : [];
}

function markerLines(workflow, identity) {
  return [`Nightly workflow: \`${workflowMarker(workflow)}\``, `Nightly identity: \`${identity}\``];
}

function describeTestIssue(test, { runUrl, sha, workflow }) {
  const flaky = test.outcome === 'flaky';
  const verdict = flaky ? 'passed this test only on retry' : 'failed this test';
  return {
    description: [
      `Scheduled run of **${workflow}** ${verdict}.`,
      '',
      `- Test: \`${test.title}\``,
      `- Spec: \`${test.spec}\``,
      `- Job: ${jobList(test.jobs)}`,
      `- Run: ${runUrl}`,
      `- Head SHA: ${sha}`,
      `- Date (UTC): ${today()}`,
      ...errorBlock(test.error),
      '',
      flaky ? `${TEST_LIFECYCLE} ${FLAKY_POLICY}` : TEST_LIFECYCLE,
      '',
      ...markerLines(workflow, test.identity),
    ].join('\n'),
    flaky,
    title: truncate(
      `Nightly ${flaky ? 'flaky' : 'red'}: ${workflow} › ${test.spec.split('/').at(-1)} › ${test.title}`,
      TITLE_LIMIT
    ),
  };
}

function testComment(test, { runUrl, sha }) {
  const lead = test.outcome === 'flaky' ? 'Passed only on retry' : 'Red again';
  return [
    `${lead}: ${runUrl}`,
    '',
    `- Head SHA: ${sha}`,
    `- Job: ${jobList(test.jobs)}`,
    ...errorBlock(test.error),
  ].join('\n');
}

function describeWorkflowIssue(gaps, { runUrl, sha, workflow }) {
  return {
    description: [
      `Scheduled run of **${workflow}** has red jobs or results with no failing test to file.`,
      '',
      `- Run: ${runUrl}`,
      `- Head SHA: ${sha}`,
      `- Date (UTC): ${today()}`,
      '',
      'Unexplained:',
      ...gaps.map((gap) => `- ${gap}`),
      '',
      WORKFLOW_LIFECYCLE,
      '',
      ...markerLines(workflow, workflowIdentity(workflow)),
    ].join('\n'),
    flaky: false,
    title: `Nightly red: ${workflow}`,
  };
}

function workflowComment(gaps, { runUrl, sha }) {
  return [
    `Red again: ${runUrl}`,
    '',
    `- Head SHA: ${sha}`,
    'Unexplained:',
    ...gaps.map((gap) => `- ${gap}`),
  ].join('\n');
}

async function openIssuesByIdentity(linear, workflow) {
  const issues = await allPages(
    (cursor) => linear(OPEN_ISSUES_QUERY, { cursor, marker: workflowMarker(workflow) }),
    (data) => data.issues,
    `open nightly issues for ${workflow}`
  );
  const byIdentity = new Map();
  for (const issue of issues) {
    const identities = new Set(String(issue.description ?? '').match(IDENTITY_MARKER) ?? []);
    if (identities.size !== 1) {
      throw new Error(
        `${issue.identifier} carries the nightly marker for ${workflow} but ${identities.size} identity markers; expected exactly one.`
      );
    }
    const [identity] = identities;
    const other = byIdentity.get(identity);
    if (other) {
      throw new Error(
        `Found two open issues for one nightly identity (${other.identifier}, ${issue.identifier}).`
      );
    }
    byIdentity.set(identity, issue);
  }
  return byIdentity;
}

async function newestComment(linear, issueId) {
  const comments = await allPages(
    (cursor) => linear(COMMENTS_QUERY, { cursor, id: issueId }),
    (data) => data.issue?.comments,
    `comments for issue ${issueId}`
  );
  for (const { createdAt } of comments) {
    if (Number.isNaN(Date.parse(createdAt))) {
      throw new Error(`Linear comment on issue ${issueId} has an invalid createdAt.`);
    }
  }
  // Never trust the API's ordering: the newest comment decides.
  comments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return comments.length > 0 ? comments[0] : undefined;
}

async function provisionLabel(linear, teamId, label) {
  const created = assertSucceeded(
    await linear(LABEL_CREATE_MUTATION, { teamId, ...label }),
    'issueLabelCreate'
  );
  return created.issueLabel.id;
}

/**
 * Everything issue creation and the flaky label need, read before any mutation.
 * Provisioning a missing `nightly-alert` or `flaky` label once is not a
 * fallback: every other lookup must find exactly one match or fail.
 */
async function prepareFiling(linear, { creates, needsFlaky }) {
  const team = exactlyOne(nodesOf(await linear(TEAM_QUERY), 'teams'), 'team with key "BST"');
  const labels = nodesOf(await linear(LABELS_QUERY), 'issueLabels');
  const named = (name) => labels.filter((label) => label.name === name);
  const scope = (name) => `label "${name}" (team BST or workspace)`;
  const required = REQUIRED_LABEL_NAMES.map((name) => exactlyOne(named(name), scope(name)).id);
  const existingId = (label) =>
    named(label.name).length > 0 ? exactlyOne(named(label.name), scope(label.name)).id : undefined;
  const alertId = creates ? existingId(ALERT_LABEL) : undefined;
  const flakyId = needsFlaky ? existingId(FLAKY_LABEL) : undefined;
  let stateId;
  let viewerId;
  if (creates) {
    stateId = exactlyOne(
      nodesOf(await linear(STATE_QUERY), 'workflowStates'),
      'workflow state "Todo" on team BST'
    ).id;
    const { viewer } = await linear(VIEWER_QUERY);
    if (!viewer?.id) {
      throw new Error('Linear API response is missing viewer.id.');
    }
    viewerId = viewer.id;
  }
  return {
    alertId: creates
      ? (alertId ?? (await provisionLabel(linear, team.id, ALERT_LABEL)))
      : undefined,
    flakyId: needsFlaky
      ? (flakyId ?? (await provisionLabel(linear, team.id, FLAKY_LABEL)))
      : undefined,
    required,
    stateId,
    teamId: team.id,
    viewerId,
  };
}

async function createIssue(linear, filing, { title, description, flaky }) {
  const labelIds = [filing.alertId, ...(flaky ? [filing.flakyId] : []), ...filing.required];
  const created = assertSucceeded(
    await linear(ISSUE_CREATE_MUTATION, {
      input: {
        assigneeId: filing.viewerId,
        description,
        labelIds,
        priority: HIGH_PRIORITY,
        stateId: filing.stateId,
        teamId: filing.teamId,
        title,
      },
    }),
    'issueCreate'
  );
  return created.issue;
}

async function addComment(linear, issueId, body) {
  assertSucceeded(
    await linear(COMMENT_CREATE_MUTATION, { input: { body, issueId } }),
    'commentCreate'
  );
}

function hasLabel(issue, name) {
  return (issue.labels?.nodes ?? []).some((label) => label.name === name);
}

/** What tonight asks of Linear, decided before anything is written. */
function planNight({ gaps, isGreen, night, open, tonight }) {
  const plan = [];
  for (const test of tonight.values()) {
    const issue = open.get(test.identity);
    if (test.outcome === 'passed') {
      if (issue) {
        plan.push({ issue, kind: 'recover' });
      }
      continue;
    }
    plan.push(
      issue
        ? {
            addFlaky: test.outcome === 'flaky' && !hasLabel(issue, FLAKY_LABEL.name),
            body: testComment(test, night),
            fixable: true,
            issue,
            kind: 'comment',
          }
        : { filing: describeTestIssue(test, night), fixable: true, kind: 'create' }
    );
  }
  const workflowLevel = workflowIdentity(night.workflow);
  const workflowIssue = open.get(workflowLevel);
  if (gaps.length > 0) {
    plan.push(
      workflowIssue
        ? {
            addFlaky: false,
            body: workflowComment(gaps, night),
            issue: workflowIssue,
            kind: 'comment',
          }
        : { filing: describeWorkflowIssue(gaps, night), kind: 'create' }
    );
  } else if (workflowIssue) {
    plan.push({ issue: workflowIssue, kind: 'recover' });
  }
  // Green means nothing failed: every open issue a test did not answer recovers.
  if (isGreen) {
    for (const [identity, issue] of open) {
      if (identity !== workflowLevel && !tonight.has(identity)) {
        plan.push({ issue, kind: 'recover' });
      }
    }
  }
  return plan;
}

async function reportNightly({ linear, parts, reports, results, runUrl, sha, workflow }) {
  const night = { runUrl, sha, workflow };
  const tonight = testsByIdentity(workflow, reports.tests);
  const gaps = findGaps(results, parts, reports);
  const isGreen = results.every(({ result }) => result === SUCCESS);
  const open = await openIssuesByIdentity(linear, workflow);
  const plan = planNight({ gaps, isGreen, night, open, tonight });

  // Reads first: a recovered issue is commented once, until its next red night.
  for (const step of plan) {
    if (step.kind === 'recover') {
      const newest = await newestComment(linear, step.issue.id);
      step.kind = newest?.body.startsWith(RECOVERED_PREFIX) ? 'already-recovered' : 'recover';
    }
  }
  const creates = plan.some((step) => step.kind === 'create');
  const needsFlaky = plan.some((step) => step.addFlaky || step.filing?.flaky);
  const filing = creates || needsFlaky ? await prepareFiling(linear, { creates, needsFlaky }) : {};

  const outcomes = [];
  for (const step of plan) {
    if (step.kind === 'create') {
      const issue = await createIssue(linear, filing, step.filing);
      outcomes.push({ action: 'created', fixable: step.fixable, issue });
    } else if (step.kind === 'comment') {
      await addComment(linear, step.issue.id, step.body);
      if (step.addFlaky) {
        assertSucceeded(
          await linear(ADD_LABEL_MUTATION, { id: step.issue.id, labelId: filing.flakyId }),
          'issueAddLabel'
        );
      }
      outcomes.push({ action: 'commented', fixable: step.fixable, issue: step.issue });
    } else if (step.kind === 'recover') {
      await addComment(linear, step.issue.id, `${RECOVERED_PREFIX} ${runUrl}`);
      outcomes.push({ action: 'recovered', issue: step.issue });
    } else {
      outcomes.push({ action: 'already recovered', issue: step.issue });
    }
  }
  return outcomes;
}

function summaryLines(workflow, outcomes) {
  if (outcomes.length === 0) {
    return [`Linear: no open nightly issue for ${workflow}; nothing to file`];
  }
  return outcomes.map(({ action, issue }) =>
    action === 'already recovered'
      ? `Linear: ${issue.identifier} already recovered`
      : `Linear: ${issue.identifier} ${issue.url} (${action})`
  );
}

/**
 * The issues a fix agent may take tonight (BST-2189): every failing or flaky
 * test's issue this run filed or commented on, never the workflow-level one.
 */
function fixIssues(outcomes) {
  return outcomes.filter((outcome) => outcome.fixable).map(({ issue }) => issue.identifier);
}

/**
 * @returns {Promise<number>} the process exit code: 0, or 1 on any failure.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  githubOutputPath = env.GITHUB_OUTPUT,
  repoRoot = REPO_ROOT,
  stepSummaryPath = env.GITHUB_STEP_SUMMARY,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const cli = parseCli(argv);
    if (!env.LINEAR_API_KEY) {
      throw new Error('LINEAR_API_KEY is not set');
    }
    const reports = readNightlyTestResults({ repoRoot, reportsDir: cli.reportsDir });
    const outcomes = await reportNightly({
      ...cli,
      linear: createLinearClient(fetchImpl, env.LINEAR_API_KEY),
      reports,
    });
    const text = `${summaryLines(cli.workflow, outcomes).join('\n')}\n`;
    stdout.write(text);
    if (stepSummaryPath) {
      appendFileSync(stepSummaryPath, text);
    }
    if (githubOutputPath) {
      appendFileSync(githubOutputPath, `fix_issues=${JSON.stringify(fixIssues(outcomes))}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`notify-linear-nightly: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
