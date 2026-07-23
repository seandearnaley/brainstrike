#!/usr/bin/env node

// Read-only merge-eligibility evidence for Porter (charters/porter.md).
// Emits facts only — the charter owns every eligibility judgment, and any
// value this script cannot prove is emitted as a failure, never a guess.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_NAME = 'collect-porter-evidence';
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const HOLD_FILE = '.night-shift/HOLD';
const ASSAY_MARKER = /<!--\s*assay:v1\s+assay:(\d+):([^:\s]+):\d+\s*-->/u;

function fail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write('Usage: node collect-porter-evidence.mjs --repo <path> [--pretty]\n');
      process.exit(0);
    }
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (argument !== '--repo') {
      fail(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`${argument} requires a value`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.repo) {
    fail('--repo is required');
  }
  return options;
}

function execute(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    const detail = stderr || (error instanceof Error ? error.message : String(error));
    fail(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function validateRepo(repoArgument) {
  let repo;
  try {
    repo = realpathSync(resolve(repoArgument));
  } catch (error) {
    fail(
      `cannot resolve --repo ${repoArgument}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const topLevel = execute('git', ['-C', repo, 'rev-parse', '--show-toplevel'], repo).trim();
  let realTopLevel;
  try {
    realTopLevel = realpathSync(topLevel);
  } catch (error) {
    fail(
      `cannot resolve git work-tree root ${topLevel}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (realTopLevel !== repo) {
    fail(`--repo must name the git work-tree root: ${realTopLevel}`);
  }
  if (!existsSync(resolve(repo, '.night-shift/PROTOCOL.md'))) {
    fail(`${repo} does not contain .night-shift/PROTOCOL.md`);
  }
  return repo;
}

function runJson(command, args, cwd) {
  const output = execute(command, args, cwd);
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(
      `${command} ${args.join(' ')} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function resolveRepository(repo) {
  const payload = runJson('gh', ['repo', 'view', '--json', 'nameWithOwner'], repo);
  if (
    !payload ||
    typeof payload.nameWithOwner !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/u.test(payload.nameWithOwner)
  ) {
    fail('gh repo view did not return a valid nameWithOwner');
  }
  const [owner, name] = payload.nameWithOwner.split('/');
  return { name, nameWithOwner: payload.nameWithOwner, owner };
}

function holdFileLive(repo, repository) {
  // The kill switch is read LIVE from the API, never from a local
  // remote-tracking ref that may be stale or absent. Only a proven 404
  // means "not held"; every other failure is an unreadable switch state,
  // and an unreadable kill switch must fail the whole run (fail closed).
  try {
    execFileSync(
      'gh',
      ['api', `repos/${repository.nameWithOwner}/contents/${HOLD_FILE}?ref=main`],
      {
        cwd: repo,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    return true;
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
    if (/\b404\b/u.test(stderr)) {
      return false;
    }
    const detail = stderr.trim() || (error instanceof Error ? error.message : String(error));
    fail(`HOLD kill-switch state is unreadable — refusing to report it absent: ${detail}`);
  }
}

function collectRequiredContexts(repo, repository) {
  const rules = runJson(
    'gh',
    ['api', `repos/${repository.nameWithOwner}/rules/branches/main`],
    repo
  );
  if (!Array.isArray(rules)) {
    fail('branch rules endpoint did not return an array');
  }
  const contexts = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || rule.type !== 'required_status_checks') {
      continue;
    }
    const checks = rule.parameters?.required_status_checks;
    if (!Array.isArray(checks)) {
      fail('required_status_checks rule lacks a parameters.required_status_checks array');
    }
    for (const check of checks) {
      if (!check || typeof check.context !== 'string' || !check.context) {
        fail('required_status_checks rule contains a check without a context');
      }
      contexts.push(check.context);
    }
  }
  if (contexts.length === 0) {
    fail(
      'no required contexts found on main — a merge-evidence run without a required-check list proves nothing'
    );
  }
  return [...new Set(contexts)].sort((left, right) => left.localeCompare(right));
}

function normalizePr(pr, index) {
  if (
    !pr ||
    typeof pr !== 'object' ||
    !Number.isSafeInteger(pr.number) ||
    typeof pr.title !== 'string' ||
    typeof pr.isDraft !== 'boolean' ||
    typeof pr.headRefName !== 'string' ||
    typeof pr.baseRefName !== 'string' ||
    typeof pr.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(pr.updatedAt)) ||
    !Array.isArray(pr.labels)
  ) {
    fail(`gh pr list returned malformed PR at index ${index}`);
  }
  const labels = pr.labels.map((label) => {
    if (!label || typeof label.name !== 'string') {
      fail(`PR #${pr.number} has a malformed label`);
    }
    return label.name;
  });
  return {
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    isDraft: pr.isDraft,
    labels,
    number: pr.number,
    title: pr.title,
    updatedAt: new Date(pr.updatedAt).toISOString(),
  };
}

const PR_LIST_FIELDS = 'number,title,isDraft,headRefName,baseRefName,labels,updatedAt';

function listPrs(repo, args) {
  const payload = runJson('gh', args, repo);
  if (!Array.isArray(payload)) {
    fail('gh pr list did not return an array');
  }
  if (payload.length >= 500) {
    fail('gh pr list reached its 500-item limit; completeness is unproven');
  }
  return payload.map(normalizePr);
}

function parseTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${label} is not a valid timestamp`);
  }
  return Date.parse(value);
}

function collectPrGraph(repo, repository, prNumber) {
  const query = `
    query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          headRefOid
          commits(last: 1) { nodes { commit { committedDate } } }
          reviews(last: 1) { nodes { submittedAt } }
          comments(last: 50) { nodes { body createdAt } }
          reviewThreads(first:100, after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id isResolved comments(last: 1) { nodes { createdAt } } }
          }
        }
      }
    }
  `;
  let cursor = null;
  let firstPage = null;
  let unresolvedThreads = 0;
  let latestThreadCommentMs = null;
  const seenCursors = new Set();
  do {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      `owner=${repository.owner}`,
      '-F',
      `repo=${repository.name}`,
      '-F',
      `number=${prNumber}`,
    ];
    if (cursor !== null) {
      args.push('-F', `cursor=${cursor}`);
    }
    const payload = runJson('gh', args, repo);
    const pullRequest = payload?.data?.repository?.pullRequest;
    const connection = pullRequest?.reviewThreads;
    if (
      !(connection && Array.isArray(connection.nodes) && connection.pageInfo) ||
      typeof connection.pageInfo.hasNextPage !== 'boolean'
    ) {
      fail(`PR #${prNumber} returned an unexpected reviewThreads response`);
    }
    if (firstPage === null) {
      firstPage = pullRequest;
    }
    for (const thread of connection.nodes) {
      if (
        !thread ||
        typeof thread !== 'object' ||
        typeof thread.id !== 'string' ||
        typeof thread.isResolved !== 'boolean' ||
        !Array.isArray(thread.comments?.nodes)
      ) {
        fail(`PR #${prNumber} returned a malformed review thread`);
      }
      if (!thread.isResolved) {
        unresolvedThreads += 1;
      }
      for (const comment of thread.comments.nodes) {
        const at = parseTimestamp(comment?.createdAt, `PR #${prNumber} thread comment createdAt`);
        if (latestThreadCommentMs === null || at > latestThreadCommentMs) {
          latestThreadCommentMs = at;
        }
      }
    }
    if (connection.pageInfo.hasNextPage) {
      const nextCursor = connection.pageInfo.endCursor;
      if (typeof nextCursor !== 'string' || !nextCursor || seenCursors.has(nextCursor)) {
        fail(`PR #${prNumber} review-thread pagination omitted a unique next cursor`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } else {
      cursor = null;
    }
  } while (cursor !== null);

  if (typeof firstPage.headRefOid !== 'string' || !firstPage.headRefOid) {
    fail(`PR #${prNumber} did not report a headRefOid`);
  }
  const headCommit = firstPage.commits?.nodes?.[0]?.commit;
  if (!headCommit) {
    fail(`PR #${prNumber} did not report a head commit`);
  }
  const lastCommitMs = parseTimestamp(
    headCommit.committedDate,
    `PR #${prNumber} head committedDate`
  );

  let latestActivityMs = lastCommitMs;
  if (latestThreadCommentMs !== null && latestThreadCommentMs > latestActivityMs) {
    latestActivityMs = latestThreadCommentMs;
  }
  const latestReview = firstPage.reviews?.nodes?.[0];
  if (latestReview) {
    const at = parseTimestamp(latestReview.submittedAt, `PR #${prNumber} review submittedAt`);
    if (at > latestActivityMs) {
      latestActivityMs = at;
    }
  }
  if (!Array.isArray(firstPage.comments?.nodes)) {
    fail(`PR #${prNumber} returned a malformed comments connection`);
  }
  let assayWorkKeyHeadSha = null;
  for (const comment of firstPage.comments.nodes) {
    const at = parseTimestamp(comment?.createdAt, `PR #${prNumber} comment createdAt`);
    if (at > latestActivityMs) {
      latestActivityMs = at;
    }
    if (typeof comment.body !== 'string') {
      fail(`PR #${prNumber} returned a comment without a body`);
    }
    const marker = ASSAY_MARKER.exec(comment.body);
    if (marker) {
      // Later comments win: the newest assay brief carries the live work_key.
      assayWorkKeyHeadSha = marker[2];
    }
  }

  return {
    assayWorkKeyHeadSha,
    headSha: firstPage.headRefOid,
    lastActivityAt: new Date(latestActivityMs).toISOString(),
    lastCommitAt: new Date(lastCommitMs).toISOString(),
    unresolvedThreads,
  };
}

function summarizeRequiredChecks(repo, prNumber, requiredContexts) {
  const payload = runJson(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'statusCheckRollup'],
    repo
  );
  if (!(payload && Array.isArray(payload.statusCheckRollup))) {
    fail(`PR #${prNumber} did not report statusCheckRollup`);
  }
  const byName = new Map();
  const failingAdvisoryChecks = [];
  for (const check of payload.statusCheckRollup) {
    if (!check || typeof check !== 'object') {
      fail(`PR #${prNumber} returned a malformed status check`);
    }
    // The rollup is heterogeneous: GitHub Actions jobs arrive as CheckRun
    // (name/status/conclusion); commit statuses (e.g. Vercel) arrive as
    // StatusContext (context/state) with no name field.
    let name;
    let success;
    let failing;
    if (typeof check.context === 'string' && check.context) {
      if (typeof check.state !== 'string') {
        fail(`PR #${prNumber} returned a StatusContext without a state`);
      }
      name = check.context;
      success = check.state === 'SUCCESS';
      failing = ['ERROR', 'FAILURE'].includes(check.state);
    } else if (typeof check.name === 'string' && check.name) {
      const completed = check.status === 'COMPLETED';
      name = check.name;
      success = completed && check.conclusion === 'SUCCESS';
      failing = completed && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion);
    } else {
      fail(`PR #${prNumber} returned a status check with neither name nor context`);
    }
    byName.set(name, success);
    if (failing && !requiredContexts.includes(name)) {
      failingAdvisoryChecks.push(name);
    }
  }
  // A required context ABSENT from the rollup reads as not green: a skipped
  // or never-reported required check must never unlock a merge (the
  // latest-wins masking class in docs/agents/ci-quality.md).
  const missingRequiredContexts = requiredContexts.filter(
    (context) => byName.get(context) !== true
  );
  return {
    failingAdvisoryChecks: failingAdvisoryChecks.sort((a, b) => a.localeCompare(b)),
    missingRequiredContexts,
    requiredGreen: missingRequiredContexts.length === 0,
  };
}

function collect(options) {
  const repo = validateRepo(options.repo);
  const repository = resolveRepository(repo);
  const requiredContexts = collectRequiredContexts(repo, repository);
  // One complete open-PR list; night-shift membership derives from an exact
  // client-side prefix test, never from GitHub search-qualifier semantics.
  const allOpenPrs = listPrs(repo, [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '500',
    '--json',
    PR_LIST_FIELDS,
  ]);
  const nightShiftPrs = allOpenPrs.filter((pr) => pr.headRefName.startsWith('night-shift/'));

  const prs = nightShiftPrs
    .sort((left, right) => left.number - right.number)
    .map((pr) => {
      const graph = collectPrGraph(repo, repository, pr.number);
      const checks = summarizeRequiredChecks(repo, pr.number, requiredContexts);
      const riskLabels = pr.labels.filter((label) => /^review\/risk-/u.test(label));
      // updatedAt joins the cooling clock: a force-push or cherry-pick can
      // carry a committedDate older than the push itself.
      const lastActivityAt =
        Date.parse(pr.updatedAt) > Date.parse(graph.lastActivityAt)
          ? pr.updatedAt
          : graph.lastActivityAt;
      return {
        ...pr,
        ...graph,
        ...checks,
        dependentPrs: allOpenPrs
          .filter((candidate) => candidate.baseRefName === pr.headRefName)
          .map((candidate) => candidate.number)
          .sort((left, right) => left - right),
        holdLabel: pr.labels.includes('review/hold'),
        lastActivityAt,
        riskLabel: riskLabels.length === 1 ? riskLabels[0] : null,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    holdFile: holdFileLive(repo, repository),
    prs,
    requiredContexts,
    schema: SCRIPT_NAME,
  };
}

const options = parseArgs(process.argv.slice(2));
const output = collect(options);
process.stdout.write(`${JSON.stringify(output, null, options.pretty ? 2 : 0)}\n`);
