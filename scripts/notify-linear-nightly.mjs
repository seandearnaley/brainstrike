#!/usr/bin/env node

// Files a nightly workflow's failure to Linear (BST-1915): one open issue per
// workflow, a comment on each further red night, one `Recovered:` comment per
// recovery, and never a close or reopen. Zero dependencies: Node's native fetch.
//
//   node scripts/notify-linear-nightly.mjs --workflow <name> \
//     --results <job=result,...> --run-url <url> --sha <sha>
//
// Green means every result is exactly `success`. `cancelled` is red: on
// `schedule` a timeout is reported as `cancelled` and must alert.

import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql';
const SUCCESS = 'success';
const RECOVERED_PREFIX = 'Recovered:';
const HIGH_PRIORITY = 2;
const ALERT_LABEL = { color: '#E5484D', name: 'nightly-alert' };
const REQUIRED_LABEL_NAMES = ['area-ci', 'needs-human'];
const REQUIRED_FLAGS = ['workflow', 'results', 'run-url', 'sha'];
const ERROR_BODY_LIMIT = 500;
const LIFECYCLE_SENTENCE =
  'Stays open until a human closes it. Each further red night adds a comment; the first green night adds a recovered comment; a red night after you close it opens a new issue.';

const TEAM_QUERY = 'query { teams(filter: { key: { eq: "BST" } }) { nodes { id } } }';
const STATE_QUERY =
  'query { workflowStates(filter: { team: { key: { eq: "BST" } }, name: { eq: "Todo" } }) { nodes { id } } }';
const LABELS_QUERY = `query {
  issueLabels(filter: {
    or: [{ team: { key: { eq: "BST" } } }, { team: { null: true } }],
    name: { in: ["nightly-alert", "area-ci", "needs-human"] }
  }) { nodes { id name } }
}`;
const VIEWER_QUERY = 'query { viewer { id } }';
const DEDUP_QUERY = `query ($title: String!) {
  issues(first: 5, filter: {
    team: { key: { eq: "BST" } },
    labels: { name: { eq: "nightly-alert" } },
    title: { eq: $title },
    state: { type: { nin: ["completed", "canceled"] } }
  }) { nodes { id identifier url } }
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

function createLinearClient(fetchImpl, apiKey) {
  return async function request(query, variables = {}) {
    // Personal API keys are sent raw: no `Bearer` prefix.
    const response = await fetchImpl(LINEAR_ENDPOINT, {
      body: JSON.stringify({ query, variables }),
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, ERROR_BODY_LIMIT);
      throw new Error(`Linear API returned HTTP ${response.status}: ${detail}`);
    }
    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const messages = payload.errors.map((error) => error?.message ?? 'unknown error');
      throw new Error(`Linear API returned errors: ${messages.join('; ')}`);
    }
    if (typeof payload.data !== 'object' || payload.data === null) {
      throw new Error('Linear API response carried no data.');
    }
    return payload.data;
  };
}

function nodesOf(data, field) {
  const nodes = data[field]?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error(`Linear API response is missing ${field}.nodes.`);
  }
  return nodes;
}

function exactlyOne(nodes, description) {
  if (nodes.length === 0) {
    throw new Error(`Linear has no ${description}.`);
  }
  if (nodes.length > 1) {
    throw new Error(`Linear has ${nodes.length} ${description}; expected exactly one.`);
  }
  return nodes[0];
}

function assertSucceeded(payload, field) {
  if (payload[field]?.success !== true) {
    throw new Error(`Linear ${field} did not report success.`);
  }
  return payload[field];
}

function parseResults(raw) {
  return raw.split(',').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new Error(`--results entry "${entry}" is not job=result.`);
    }
    return { job: entry.slice(0, separator), result: entry.slice(separator + 1) };
  });
}

function parseCli(argv) {
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv,
    options: {
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
  return {
    results: parseResults(values.results),
    runUrl: values['run-url'],
    sha: values.sha,
    workflow: values.workflow,
  };
}

function jobList(results) {
  return results.map(({ job, result }) => `- \`${job}\`: ${result || '(no result)'}`).join('\n');
}

function describeRedNight({ workflow, results, runUrl, sha }) {
  return {
    comment: [
      `Red again: ${runUrl}`,
      '',
      `- Head SHA: ${sha}`,
      'Failed jobs:',
      jobList(results.filter(({ result }) => result !== SUCCESS)),
    ].join('\n'),
    description: [
      `Scheduled run of **${workflow}** is red.`,
      '',
      `- Run: ${runUrl}`,
      `- Head SHA: ${sha}`,
      `- Date (UTC): ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Job results:',
      jobList(results),
      '',
      LIFECYCLE_SENTENCE,
    ].join('\n'),
  };
}

async function resolveAlertLabelIds(linear, teamId) {
  const labels = nodesOf(await linear(LABELS_QUERY), 'issueLabels');
  const named = (name) => labels.filter((label) => label.name === name);
  const required = REQUIRED_LABEL_NAMES.map((name) =>
    exactlyOne(named(name), `label "${name}" (team BST or workspace)`)
  );
  const alertMatches = named(ALERT_LABEL.name);
  if (alertMatches.length > 0) {
    const alert = exactlyOne(alertMatches, `label "${ALERT_LABEL.name}" (team BST or workspace)`);
    return [alert.id, ...required.map((label) => label.id)];
  }
  // Provisioning the alert label once, not a fallback: every other lookup fails.
  const created = assertSucceeded(
    await linear(LABEL_CREATE_MUTATION, { teamId, ...ALERT_LABEL }),
    'issueLabelCreate'
  );
  return [created.issueLabel.id, ...required.map((label) => label.id)];
}

async function createIssue(linear, { title, description }) {
  const team = exactlyOne(nodesOf(await linear(TEAM_QUERY), 'teams'), 'team with key "BST"');
  const state = exactlyOne(
    nodesOf(await linear(STATE_QUERY), 'workflowStates'),
    'workflow state "Todo" on team BST'
  );
  const labelIds = await resolveAlertLabelIds(linear, team.id);
  const { viewer } = await linear(VIEWER_QUERY);
  if (!viewer?.id) {
    throw new Error('Linear API response is missing viewer.id.');
  }
  const created = assertSucceeded(
    await linear(ISSUE_CREATE_MUTATION, {
      input: {
        assigneeId: viewer.id,
        description,
        labelIds,
        priority: HIGH_PRIORITY,
        stateId: state.id,
        teamId: team.id,
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

async function newestComment(linear, issueId) {
  const comments = [];
  let cursor = null;
  do {
    const { issue } = await linear(COMMENTS_QUERY, { cursor, id: issueId });
    const page = issue?.comments;
    if (!(Array.isArray(page?.nodes) && page.pageInfo)) {
      throw new Error(`Linear API response is missing comments for issue ${issueId}.`);
    }
    comments.push(...page.nodes);
    if (page.pageInfo.hasNextPage && !page.pageInfo.endCursor) {
      throw new Error(`Linear reported more comments for issue ${issueId} but no cursor.`);
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  for (const { createdAt } of comments) {
    if (Number.isNaN(Date.parse(createdAt))) {
      throw new Error(`Linear comment on issue ${issueId} has an invalid createdAt.`);
    }
  }
  // Never trust the API's ordering: the newest comment decides.
  comments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return comments.length > 0 ? comments[0] : undefined;
}

async function reportNightly({ linear, workflow, results, runUrl, sha }) {
  const title = `Nightly red: ${workflow}`;
  const isGreen = results.every(({ result }) => result === SUCCESS);
  const open = nodesOf(await linear(DEDUP_QUERY, { title }), 'issues');
  if (open.length > 1) {
    const identifiers = open.map((issue) => issue.identifier).join(', ');
    throw new Error(`Found ${open.length} open issues titled "${title}" (${identifiers}).`);
  }
  const existing = open.length === 1 ? open[0] : undefined;
  const red = describeRedNight({ results, runUrl, sha, workflow });

  if (existing && !isGreen) {
    await addComment(linear, existing.id, red.comment);
    return { action: 'commented', issue: existing };
  }
  if (existing) {
    const newest = await newestComment(linear, existing.id);
    if (newest?.body.startsWith(RECOVERED_PREFIX)) {
      return { action: 'already-recovered', issue: existing };
    }
    await addComment(linear, existing.id, `${RECOVERED_PREFIX} ${runUrl}`);
    return { action: 'recovered', issue: existing };
  }
  if (isGreen) {
    return { action: 'none' };
  }
  const issue = await createIssue(linear, { description: red.description, title });
  return { action: 'created', issue };
}

function summaryLine({ issue, action }) {
  if (action === 'none') {
    return 'Linear: no open nightly issue; green';
  }
  if (action === 'already-recovered') {
    return `Linear: ${issue.identifier} already recovered`;
  }
  return `Linear: ${issue.identifier} ${issue.url} (${action})`;
}

/**
 * @returns {Promise<number>} the process exit code: 0, or 1 on any failure.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stepSummaryPath = env.GITHUB_STEP_SUMMARY,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const cli = parseCli(argv);
    if (!env.LINEAR_API_KEY) {
      throw new Error('LINEAR_API_KEY is not set');
    }
    const outcome = await reportNightly({
      ...cli,
      linear: createLinearClient(fetchImpl, env.LINEAR_API_KEY),
    });
    const line = summaryLine(outcome);
    stdout.write(`${line}\n`);
    if (stepSummaryPath) {
      appendFileSync(stepSummaryPath, `${line}\n`);
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
