#!/usr/bin/env node

// The Linear steps around one nightly fix attempt (BST-2189). The fix agent
// itself holds no Linear key: .github/workflows/nightly-fix-agent.yml runs
// these before and after it.
//
//   node scripts/nightly-fix-issue.mjs claim --issue BST-123 --claimant <who> \
//     --run-url <url> --issue-file <path>
//   node scripts/nightly-fix-issue.mjs comment --issue BST-123 --body-file <path>
//
// The claim is the lock. An open nightly-alert issue in Triage, Backlog or Todo
// is claimed: assigned to the key's owner, moved to In Progress, a `Claimed by`
// comment added, and its text written to --issue-file. An issue already started,
// done or canceled is held by someone else: claim exits 3 and writes nothing.
// Linear has no compare-and-set, so two claimants racing within one read can
// both win; the workflow's per-issue concurrency group serializes CI runs.
//
// Exit codes: 0 claimed or commented, 3 already claimed, 1 any failure.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSucceeded, createLinearClient, exactlyOne, nodesOf } from './lib/linear-api.mjs';

export const ALREADY_CLAIMED = 3;
const UNCLAIMED_STATE_TYPES = new Set(['triage', 'backlog', 'unstarted']);
const ALERT_LABEL = 'nightly-alert';
const ISSUE_ID = /^BST-\d+$/u;
const COMMANDS = {
  claim: ['issue', 'claimant', 'run-url', 'issue-file'],
  comment: ['issue', 'body-file'],
};

const ISSUE_QUERY = `query ($id: String!) {
  issue(id: $id) {
    id identifier title description url
    state { name type }
    assignee { name }
    team { key }
    labels { nodes { name } }
  }
}`;
const IN_PROGRESS_QUERY =
  'query { workflowStates(filter: { team: { key: { eq: "BST" } }, name: { eq: "In Progress" } }) { nodes { id } } }';
const VIEWER_QUERY = 'query { viewer { id } }';
const ISSUE_UPDATE_MUTATION = `mutation ($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;
const COMMENT_CREATE_MUTATION = `mutation ($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

function parseCli(argv) {
  const [command, ...rest] = argv;
  const required = COMMANDS[command];
  if (!required) {
    throw new Error(`Usage: nightly-fix-issue.mjs <${Object.keys(COMMANDS).join('|')}> [options].`);
  }
  const { values } = parseArgs({
    allowPositionals: false,
    args: rest,
    options: Object.fromEntries(required.map((name) => [name, { type: 'string' }])),
    strict: true,
  });
  const missing = required.filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required argument(s): ${missing.map((n) => `--${n}`).join(', ')}.`);
  }
  if (!ISSUE_ID.test(values.issue)) {
    throw new Error(
      `--issue must be a BST issue identifier such as BST-123, not "${values.issue}".`
    );
  }
  return { command, ...values };
}

async function readNightlyIssue(linear, identifier) {
  const { issue } = await linear(ISSUE_QUERY, { id: identifier });
  if (!issue?.id) {
    throw new Error(`Linear has no issue ${identifier}.`);
  }
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name);
  if (issue.team?.key !== 'BST' || !labels.includes(ALERT_LABEL)) {
    throw new Error(
      `${identifier} is not a BST ${ALERT_LABEL} issue; the fix agent takes only those.`
    );
  }
  return issue;
}

async function addComment(linear, issueId, body) {
  assertSucceeded(
    await linear(COMMENT_CREATE_MUTATION, { input: { body, issueId } }),
    'commentCreate'
  );
}

async function claim(linear, cli, stdout) {
  const issue = await readNightlyIssue(linear, cli.issue);
  if (!UNCLAIMED_STATE_TYPES.has(issue.state?.type)) {
    const holder = issue.assignee?.name ?? 'nobody';
    stdout.write(
      `${issue.identifier} is already claimed: ${issue.state?.name ?? 'unknown state'}, assigned to ${holder}.\n`
    );
    return ALREADY_CLAIMED;
  }
  const inProgress = exactlyOne(
    nodesOf(await linear(IN_PROGRESS_QUERY), 'workflowStates'),
    'workflow state "In Progress" on team BST'
  );
  const { viewer } = await linear(VIEWER_QUERY);
  if (!viewer?.id) {
    throw new Error('Linear API response is missing viewer.id.');
  }
  assertSucceeded(
    await linear(ISSUE_UPDATE_MUTATION, {
      id: issue.id,
      input: { assigneeId: viewer.id, stateId: inProgress.id },
    }),
    'issueUpdate'
  );
  await addComment(
    linear,
    issue.id,
    `Claimed by \`${cli.claimant}\` for a fix attempt: ${cli['run-url']}`
  );
  writeFileSync(
    cli['issue-file'],
    `# ${issue.identifier}: ${issue.title}\n\n${issue.url}\n\n${issue.description ?? ''}\n`
  );
  stdout.write(`${issue.identifier} claimed by ${cli.claimant}.\n`);
  return 0;
}

async function comment(linear, cli, stdout) {
  const body = readFileSync(cli['body-file'], 'utf8').trim();
  if (!body) {
    throw new Error(`--body-file ${cli['body-file']} is empty.`);
  }
  const issue = await readNightlyIssue(linear, cli.issue);
  await addComment(linear, issue.id, body);
  stdout.write(`Commented on ${issue.identifier}.\n`);
  return 0;
}

/**
 * @returns {Promise<number>} 0, ALREADY_CLAIMED, or 1 on any failure.
 */
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const cli = parseCli(argv);
    if (!env.LINEAR_API_KEY) {
      throw new Error('LINEAR_API_KEY is not set');
    }
    const linear = createLinearClient(fetchImpl, env.LINEAR_API_KEY);
    return cli.command === 'claim'
      ? await claim(linear, cli, stdout)
      : await comment(linear, cli, stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`nightly-fix-issue: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
