#!/usr/bin/env node

// The Linear steps around one nightly fix attempt (BST-2189). The fix agent
// itself holds no Linear key: .github/workflows/nightly-fix-agent.yml runs
// these before and after it.
//
//   node scripts/nightly-fix-issue.mjs claim --issue BST-123 --claimant <who> \
//     --run-url <url> --issue-file <path>
//   node scripts/nightly-fix-issue.mjs comment --issue BST-123 --body-file <path>
//   node scripts/nightly-fix-issue.mjs link-pr --issue BST-123 --pr-url <url>
//
// The claim is the lock, and its last write takes it. claim reads the issue
// and its comments, writes --issue-file (tonight's failure from --run-url
// first, then the description, which may name an older run), comments
// `Claimed by <claimant>`, and only then moves the issue to In Progress and
// assigns the key's owner. Any failure before that last write leaves the
// issue unlocked for the next run; never an In Progress issue with no fix
// attempt behind it.
//
// An issue in Triage, Backlog or Todo is claimable. A started issue is held,
// unless its newest claim is a bot's (`github-run:`), older than
// CLAIM_LIFETIME_MINUTES and followed by no fix PR: no run that made it can
// still be alive, so a later run reclaims it. A person's claim, a fresh bot
// claim, a claim with a PR, a start with no claim record, and a done or
// canceled issue are held: claim exits 3 and writes nothing. Linear has no
// compare-and-set, so two claimants racing within one read can both win; the
// workflow's per-issue concurrency group serializes CI runs.
//
// Exit codes: 0 claimed or commented, 3 already claimed, 1 any failure.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  allPages,
  assertSucceeded,
  createLinearClient,
  exactlyOne,
  nodesOf,
} from './lib/linear-api.mjs';

export const ALREADY_CLAIMED = 3;
/**
 * How long a bot claim stays live: the fix job's 120-minute timeout plus the
 * publish job's 10, with margin (contract-tested against the workflow). Past
 * it, no run that claimed the issue can still be working on it.
 */
export const CLAIM_LIFETIME_MINUTES = 180;
const BOT_CLAIMANT_PREFIX = 'github-run:';
const CLAIM_COMMENT = /^Claimed by `([^`]+)`/u;
const PR_LINK_PREFIX = 'Fix PR opened for review:';
const OPEN_STATE_TYPES = new Set(['started']);
const UNCLAIMED_STATE_TYPES = new Set(['triage', 'backlog', 'unstarted']);
const ALERT_LABEL = 'nightly-alert';
const ISSUE_ID = /^BST-\d+$/u;
const COMMANDS = {
  claim: ['issue', 'claimant', 'run-url', 'issue-file'],
  comment: ['issue', 'body-file'],
  'link-pr': ['issue', 'pr-url'],
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
const COMMENTS_QUERY = `query ($id: String!, $cursor: String) {
  issue(id: $id) {
    comments(first: 250, after: $cursor) {
      nodes { body createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
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

async function commentsNewestFirst(linear, issue) {
  const comments = await allPages(
    (cursor) => linear(COMMENTS_QUERY, { cursor, id: issue.id }),
    (data) => data.issue?.comments,
    `comments for ${issue.identifier}`
  );
  for (const { createdAt } of comments) {
    if (Number.isNaN(Date.parse(createdAt))) {
      throw new Error(`Linear comment on ${issue.identifier} has an invalid createdAt.`);
    }
  }
  return comments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * Whether a started issue's claim is dead: its newest claim is a bot's, older
 * than CLAIM_LIFETIME_MINUTES, and no fix PR followed it. Returns the stale
 * claimant, or undefined when the claim is live.
 */
function staleBotClaimant(comments, now) {
  for (const { body, createdAt } of comments) {
    if (body.startsWith(PR_LINK_PREFIX)) {
      return;
    }
    const claimant = CLAIM_COMMENT.exec(body)?.[1];
    if (claimant) {
      const ageMinutes = (now - Date.parse(createdAt)) / 60_000;
      return claimant.startsWith(BOT_CLAIMANT_PREFIX) && ageMinutes > CLAIM_LIFETIME_MINUTES
        ? claimant
        : undefined;
    }
  }
  return;
}

/** issue.md: tonight's failure from this run first, then the description. */
function issueText(issue, comments, runUrl) {
  const tonight = comments.find(({ body }) => body.includes(runUrl));
  const description = issue.description ?? '';
  if (!(tonight || description.includes(runUrl))) {
    throw new Error(
      `${issue.identifier} has no failure from ${runUrl}; this run did not queue it.`
    );
  }
  return [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    issue.url,
    '',
    `## Tonight's failure: ${runUrl}`,
    '',
    "Download this run's artifacts; the description below may name an older run.",
    '',
    tonight ? tonight.body : "Filed on this run: the description below is tonight's failure.",
    '',
    '## Description',
    '',
    description,
    '',
  ].join('\n');
}

async function claim(linear, cli, stdout, now) {
  const issue = await readNightlyIssue(linear, cli.issue);
  const type = issue.state?.type;
  const comments = await commentsNewestFirst(linear, issue);
  const stale = OPEN_STATE_TYPES.has(type) ? staleBotClaimant(comments, now()) : undefined;
  if (!(UNCLAIMED_STATE_TYPES.has(type) || stale)) {
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
  writeFileSync(cli['issue-file'], issueText(issue, comments, cli['run-url']));
  await addComment(
    linear,
    issue.id,
    `Claimed by \`${cli.claimant}\` for a fix attempt: ${cli['run-url']}`
  );
  // The lock, last: nothing after it can fail and strand the issue.
  assertSucceeded(
    await linear(ISSUE_UPDATE_MUTATION, {
      id: issue.id,
      input: { assigneeId: viewer.id, stateId: inProgress.id },
    }),
    'issueUpdate'
  );
  stdout.write(
    stale
      ? `${issue.identifier} reclaimed from ${stale} by ${cli.claimant}.\n`
      : `${issue.identifier} claimed by ${cli.claimant}.\n`
  );
  return 0;
}

async function comment(linear, cli, stdout) {
  const body =
    cli.command === 'link-pr'
      ? `${PR_LINK_PREFIX} ${cli['pr-url']}`
      : readFileSync(cli['body-file'], 'utf8').trim();
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
  now = Date.now,
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
      ? await claim(linear, cli, stdout, now)
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
