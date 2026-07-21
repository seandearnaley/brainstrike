#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const REPOSITORY = 'seandearnaley/brainstrike';
const GREEN_CONCLUSIONS = new Set(['NEUTRAL', 'SKIPPED', 'SUCCESS']);

function usage() {
  return [
    'Usage: audit-bolt-readiness.mjs --repo <absolute-path> --pr <number> --head <full-sha> [--pretty]',
    '',
    'Audit read-only mechanical readiness for one exact Bolt PR head.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { head: null, help: false, pr: null, pretty: false, repo: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      parsed.help = true;
      continue;
    }
    if (argument === '--pretty') {
      parsed.pretty = true;
      continue;
    }
    if (argument === '--repo' || argument === '--pr' || argument === '--head') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      parsed[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }
  if (parsed.help) {
    return parsed;
  }
  if (!(parsed.repo && isAbsolute(parsed.repo))) {
    throw new Error('--repo must be an absolute path; repository discovery is disabled');
  }
  if (!(parsed.pr && /^[1-9]\d*$/u.test(parsed.pr))) {
    throw new Error('--pr must be a positive integer');
  }
  if (!(parsed.head && /^[0-9a-f]{40}$/iu.test(parsed.head))) {
    throw new Error('--head must be an exact full commit SHA');
  }
  return parsed;
}

function execute(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, {
      cause: error,
    });
  }
}

function git(repo, args) {
  return execute(
    'git',
    ['-C', repo, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    repo
  );
}

function isAncestor(repo, ancestor, descendant) {
  const result = spawnSync(
    'git',
    ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant],
    { cwd: repo, encoding: 'utf8' }
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(`Unable to inspect ancestry: ${result.stderr.trim()}`);
}

function collectReviewThreads(repo, prNumber) {
  const query = `
    query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          reviewThreads(first:100, after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { id isResolved }
          }
        }
      }
    }
  `;
  const threads = [];
  let cursor = null;
  do {
    const ghArgs = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-F',
      'owner=seandearnaley',
      '-F',
      'repo=brainstrike',
      '-F',
      `number=${prNumber}`,
    ];
    if (cursor !== null) {
      ghArgs.push('-F', `cursor=${cursor}`);
    }
    const payload = JSON.parse(execute('gh', ghArgs, repo));
    const connection = payload?.data?.repository?.pullRequest?.reviewThreads;
    if (!(connection && Array.isArray(connection.nodes) && connection.pageInfo)) {
      throw new Error('GitHub returned an unexpected review-thread response');
    }
    threads.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    if (connection.pageInfo.hasNextPage && !cursor) {
      throw new Error('GitHub review-thread pagination omitted its next cursor');
    }
  } while (cursor !== null);
  return threads;
}

function normalizeCheck(check) {
  const name = check?.name ?? check?.context ?? '<unnamed>';
  if (typeof check?.status === 'string' && check.status !== 'COMPLETED') {
    return { green: false, name, state: check.status };
  }
  if (typeof check?.conclusion === 'string') {
    return { green: GREEN_CONCLUSIONS.has(check.conclusion), name, state: check.conclusion };
  }
  if (typeof check?.state === 'string') {
    return { green: GREEN_CONCLUSIONS.has(check.state), name, state: check.state };
  }
  return { green: false, name, state: 'UNKNOWN' };
}

function collect(args) {
  const repo = realpathSync(args.repo);
  const localHead = git(repo, ['rev-parse', 'HEAD']).trim();
  const originMain = git(repo, ['rev-parse', 'origin/main']).trim();
  const originRemote = git(repo, ['remote', 'get-url', 'origin']).trim();
  const worktreeClean = git(repo, ['status', '--porcelain=v1']).trim() === '';
  const pullRequest = JSON.parse(
    execute(
      'gh',
      [
        'pr',
        'view',
        args.pr,
        '--repo',
        REPOSITORY,
        '--json',
        'number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,baseRefOid,mergeable,mergeStateStatus,statusCheckRollup',
      ],
      repo
    )
  );
  if (!Array.isArray(pullRequest.statusCheckRollup)) {
    throw new Error('GitHub returned an unexpected status-check response');
  }
  const checks = pullRequest.statusCheckRollup.map(normalizeCheck);
  const threads = collectReviewThreads(repo, Number.parseInt(args.pr, 10));
  const unresolvedThreadIds = threads
    .filter((thread) => thread?.isResolved !== true)
    .map((thread) => thread.id ?? '<missing-id>');

  const conditions = {
    allObservedChecksTerminalGreen: checks.length > 0 && checks.every((check) => check.green),
    baseBranchMain: pullRequest.baseRefName === 'main',
    baseMatchesFetchedMain: pullRequest.baseRefOid === originMain,
    boltBranch:
      typeof pullRequest.headRefName === 'string' &&
      pullRequest.headRefName.startsWith('night-shift/bolt/'),
    checksObserved: checks.length > 0,
    exactLocalHead: localHead === args.head,
    exactRemoteHead: pullRequest.headRefOid === args.head,
    headContainsFetchedMain: isAncestor(repo, originMain, args.head),
    mergeable: pullRequest.mergeable === 'MERGEABLE',
    mergeStateClean: pullRequest.mergeStateStatus === 'CLEAN',
    nonDraft: pullRequest.isDraft === false,
    open: pullRequest.state === 'OPEN',
    repositoryMatches: /(?:github\.com[:/])seandearnaley\/brainstrike(?:\.git)?$/u.test(
      originRemote
    ),
    worktreeClean,
    zeroUnresolvedThreads: unresolvedThreadIds.length === 0,
  };

  return {
    auditedAt: new Date().toISOString(),
    checks,
    conditions,
    expectedHead: args.head,
    localHead,
    mechanicalReady: Object.values(conditions).every(Boolean),
    note: 'Mechanical readiness does not prove benchmark evidence or fresh reviewer status; verify both on this exact SHA.',
    originMain,
    pullRequest: {
      baseRefName: pullRequest.baseRefName,
      baseRefOid: pullRequest.baseRefOid,
      headRefName: pullRequest.headRefName,
      headRefOid: pullRequest.headRefOid,
      mergeable: pullRequest.mergeable,
      mergeStateStatus: pullRequest.mergeStateStatus,
      number: pullRequest.number,
      state: pullRequest.state,
      title: pullRequest.title,
      url: pullRequest.url,
    },
    reviewThreadCount: threads.length,
    unresolvedThreadIds,
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const result = collect(args);
    process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
    return result.mechanicalReady ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`audit-bolt-readiness: ${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
