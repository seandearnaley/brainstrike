#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const REQUIRED_FILES = [
  'AGENTS.md',
  '.night-shift/PROTOCOL.md',
  '.night-shift/charters/magnify.md',
];

function usage() {
  return 'Usage: collect-magnify-evidence.mjs --repo /absolute/path/to/brainstrike [--pretty]';
}

function parseArgs(argv) {
  let pretty = false;
  let repo;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pretty') {
      pretty = true;
      continue;
    }
    if (argument === '--repo') {
      repo = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }

  if (!repo) {
    throw new Error('--repo is required');
  }

  return { pretty, repo };
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: pinnedGitEnvironment(),
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const detail = stderr ? `: ${stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`);
  }
}

function runJson(command, args, cwd) {
  const output = run(command, args, cwd).trim();
  if (!output) {
    throw new Error(`${command} ${args.join(' ')} returned no JSON`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${command} ${args.join(' ')} returned invalid JSON`);
  }
}

function pinnedGitEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      delete environment[key];
    }
  }
  environment.GIT_LITERAL_PATHSPECS = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

export function configuredHookDisables(repo) {
  const result = spawnSync(
    'git',
    ['config', '--null', '--name-only', '--get-regexp', '^hook\\..*\\.command$'],
    {
      cwd: repo,
      encoding: 'utf8',
      env: pinnedGitEnvironment(),
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  if (result.error) {
    throw new Error(`git config hook enumeration failed: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git config hook enumeration failed: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '')
    .split('\0')
    .filter(Boolean)
    .flatMap((key) => ['-c', `${key.slice(0, -'.command'.length)}.enabled=false`]);
}

export function git(repo, args) {
  const safetyConfig = [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    ...configuredHookDisables(repo),
  ];
  try {
    return execFileSync('git', [...safetyConfig, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: pinnedGitEnvironment(),
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    const detail = stderr ? `: ${stderr}` : '';
    throw new Error(`git ${args.join(' ')} failed${detail}`);
  }
}

function assertRepository(repoInput) {
  const candidate = resolve(repoInput);
  if (!existsSync(candidate)) {
    throw new Error(`Repository does not exist: ${candidate}`);
  }
  const repo = realpathSync(candidate);
  const topLevel = realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim());
  if (topLevel !== repo) {
    throw new Error(`--repo must be the repository root; resolved ${topLevel}`);
  }
  for (const relativePath of REQUIRED_FILES) {
    if (!existsSync(join(repo, relativePath))) {
      throw new Error(`Required file is missing: ${relativePath}`);
    }
  }
  return repo;
}

function assignment(charter, name) {
  const match = charter.match(new RegExp(`^${name}=(?:"([^"]+)"|([^#\\n]+))`, 'm'));
  if (!match) {
    throw new Error(`Magnify charter is missing ${name}`);
  }
  return (match[1] ?? match[2]).trim();
}

export function deriveCharter(charter) {
  const version = assignment(charter, 'CHARTER_VERSION');
  const labels = [...new Set(charter.match(/review\/risk-[34]-[a-z0-9-]+/g) ?? [])];
  const risk3Label = labels.find((label) => label.includes('risk-3-'));
  const risk4Label = labels.find((label) => label.includes('risk-4-'));
  const maximumMatch = charter.match(/Max\s+(\d+)\s+PRs per run/i);
  const markerTemplate = `<!-- magnify:v${version} <pr>:<head-sha> -->`;

  if (!(risk3Label && risk4Label)) {
    throw new Error('Could not derive both elevated-risk labels from Magnify charter');
  }
  if (!maximumMatch) {
    throw new Error('Could not derive the per-run PR limit from Magnify charter');
  }
  if (!charter.includes(markerTemplate)) {
    throw new Error(`Magnify charter is missing marker template ${markerTemplate}`);
  }
  if (!/risk-4 first,\s*then oldest/i.test(charter)) {
    throw new Error('Magnify charter selection ordering is not recognized');
  }

  return {
    markerTemplate,
    maximumPullRequests: Number.parseInt(maximumMatch[1], 10),
    name: assignment(charter, 'NAME'),
    risk3Label,
    risk4Label,
    stateIssue: assignment(charter, 'STATE_ISSUE'),
    version,
    wallClockBudget: assignment(charter, 'WALL_CLOCK_BUDGET'),
  };
}

function apiAllPages(repo, endpoint) {
  const pages = runJson(
    'gh',
    ['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github+json', endpoint],
    repo
  );
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`GitHub pagination returned an unexpected shape for ${endpoint}`);
  }
  return pages.flat();
}

function pullRequestDetails(repo, repository, number) {
  return runJson(
    'gh',
    [
      'pr',
      'view',
      String(number),
      '--repo',
      repository,
      '--json',
      [
        'number',
        'state',
        'isDraft',
        'title',
        'url',
        'body',
        'author',
        'createdAt',
        'updatedAt',
        'baseRefName',
        'baseRefOid',
        'headRefName',
        'headRefOid',
        'labels',
        'mergeable',
        'reviewDecision',
        'statusCheckRollup',
      ].join(','),
    ],
    repo
  );
}

function normalizeComment(comment) {
  return {
    association: comment.author_association ?? null,
    author: comment.user?.login ?? null,
    body: comment.body ?? '',
    createdAt: comment.created_at,
    id: comment.id,
    reactions: comment.reactions ?? null,
    updatedAt: comment.updated_at,
    url: comment.html_url,
  };
}

export function parseReport(comment) {
  const match = comment.body.match(/<!--\s*magnify:v(\d+)\s+(\d+):([0-9a-f]{40})\s*-->/i);
  if (!match) {
    return null;
  }
  return {
    comment,
    headSha: match[3].toLowerCase(),
    pullRequest: Number.parseInt(match[2], 10),
    version: match[1],
  };
}

export function partitionReports(comments, pullRequestNumber) {
  const parsedReports = comments.map(parseReport).filter((report) => report !== null);
  return {
    foreignMarkerComments: parsedReports
      .filter((report) => report.pullRequest !== pullRequestNumber)
      .map((report) => report.comment),
    reports: parsedReports.filter((report) => report.pullRequest === pullRequestNumber),
  };
}

function assertStableOpenHead(before, after) {
  if (before.state !== 'OPEN' || after.state !== 'OPEN') {
    throw new Error(`PR #${before.number} closed during evidence collection`);
  }
  if (before.headRefOid !== after.headRefOid) {
    throw new Error(`PR #${before.number} moved head during evidence collection; rerun`);
  }
}

function labelsOf(pullRequest) {
  return new Set((pullRequest.labels ?? []).map((label) => label.name));
}

function riskRank(pullRequest, charter) {
  const labels = labelsOf(pullRequest);
  if (labels.has(charter.risk4Label)) {
    return 0;
  }
  if (labels.has(charter.risk3Label)) {
    return 1;
  }
  return 2;
}

function basicEvidence(repo, repository, pullRequest, charter) {
  const number = pullRequest.number;
  const comments = apiAllPages(
    repo,
    `/repos/${repository}/issues/${number}/comments?per_page=100`
  ).map(normalizeComment);
  const details = pullRequestDetails(repo, repository, number);
  assertStableOpenHead(pullRequest, details);

  const { reports, foreignMarkerComments } = partitionReports(comments, number);
  const expectedMarker = `<!-- magnify:v${charter.version} ${number}:${pullRequest.headRefOid} -->`;
  const currentHeadReports = reports.filter(
    (report) =>
      report.version === charter.version &&
      report.pullRequest === number &&
      report.headSha === pullRequest.headRefOid.toLowerCase()
  );
  if (currentHeadReports.length > 1) {
    throw new Error(`PR #${number} has duplicate current-head Magnify reports`);
  }

  const previousReports = reports
    .filter((report) => report.headSha !== pullRequest.headRefOid.toLowerCase())
    .sort((left, right) => left.comment.createdAt.localeCompare(right.comment.createdAt));
  const latestPrior = previousReports.at(-1) ?? null;

  return {
    createdAt: pullRequest.createdAt,
    currentHeadCovered: currentHeadReports.length === 1,
    currentHeadReport: currentHeadReports[0]?.comment ?? null,
    discussionAfterLatestPriorReport: latestPrior
      ? comments.filter(
          (comment) => comment.createdAt > latestPrior.comment.createdAt && !parseReport(comment)
        )
      : [],
    expectedMarker,
    foreignMarkerComments,
    headRefName: pullRequest.headRefName,
    headRefOid: pullRequest.headRefOid,
    labels: [...labelsOf(pullRequest)].sort(),
    number,
    previousReports,
    riskRank: riskRank(pullRequest, charter),
    title: pullRequest.title,
    url: pullRequest.url,
  };
}

function deepEvidence(repo, repository, basic) {
  const before = pullRequestDetails(repo, repository, basic.number);
  if (before.headRefOid !== basic.headRefOid) {
    throw new Error(`PR #${basic.number} moved head before deep collection; rerun`);
  }

  const files = apiAllPages(
    repo,
    `/repos/${repository}/pulls/${basic.number}/files?per_page=100`
  ).map((file) => ({
    additions: file.additions,
    blobUrl: file.blob_url,
    changes: file.changes,
    deletions: file.deletions,
    patch: file.patch ?? null,
    path: file.filename,
    rawUrl: file.raw_url,
    status: file.status,
  }));
  const diff = run(
    'gh',
    ['pr', 'diff', String(basic.number), '--repo', repository, '--patch', '--color=never'],
    repo
  );
  const reviews = apiAllPages(
    repo,
    `/repos/${repository}/pulls/${basic.number}/reviews?per_page=100`
  ).map((review) => ({
    association: review.author_association ?? null,
    author: review.user?.login ?? null,
    body: review.body ?? '',
    id: review.id,
    state: review.state,
    submittedAt: review.submitted_at,
    url: review.html_url,
  }));
  const reviewComments = apiAllPages(
    repo,
    `/repos/${repository}/pulls/${basic.number}/comments?per_page=100`
  ).map((comment) => ({
    ...normalizeComment(comment),
    commitId: comment.commit_id,
    inReplyToId: comment.in_reply_to_id ?? null,
    line: comment.line,
    path: comment.path,
    side: comment.side,
    startLine: comment.start_line,
  }));

  const after = pullRequestDetails(repo, repository, basic.number);
  assertStableOpenHead(before, after);

  return {
    ...basic,
    details: after,
    diff,
    files,
    isNightShiftAuthored: after.headRefName.startsWith('night-shift/'),
    reviewComments,
    reviews,
  };
}

function listMarkdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort();
}

function listInstructionFiles(repo) {
  return git(repo, ['ls-files'])
    .split('\n')
    .filter((path) => path === 'AGENTS.md' || path.endsWith('/AGENTS.md'))
    .sort();
}

function main() {
  const { pretty, repo: repoInput } = parseArgs(process.argv.slice(2));
  const repo = assertRepository(repoInput);
  const charterPath = join(repo, '.night-shift/charters/magnify.md');
  const charter = deriveCharter(readFileSync(charterPath, 'utf8'));
  const repository = runJson('gh', ['repo', 'view', '--json', 'nameWithOwner'], repo).nameWithOwner;
  if (typeof repository !== 'string' || !repository.includes('/')) {
    throw new Error('Could not resolve GitHub repository identity');
  }

  const openPullRequests = apiAllPages(
    repo,
    `/repos/${repository}/pulls?state=open&per_page=100`
  ).map((pullRequest) => ({
    createdAt: pullRequest.created_at,
    headRefName: pullRequest.head?.ref,
    headRefOid: pullRequest.head?.sha,
    isDraft: pullRequest.draft,
    labels: pullRequest.labels ?? [],
    number: pullRequest.number,
    state: pullRequest.state?.toUpperCase(),
    title: pullRequest.title,
    url: pullRequest.html_url,
  }));

  const elevated = openPullRequests
    .filter((pullRequest) => {
      const labels = labelsOf(pullRequest);
      return labels.has(charter.risk4Label) || labels.has(charter.risk3Label);
    })
    .sort((left, right) => {
      const rankDifference = riskRank(left, charter) - riskRank(right, charter);
      return rankDifference || left.createdAt.localeCompare(right.createdAt);
    });

  const eligible = elevated.map((pullRequest) =>
    basicEvidence(repo, repository, pullRequest, charter)
  );
  const selectedBasics = eligible
    .filter((pullRequest) => !pullRequest.currentHeadCovered)
    .slice(0, charter.maximumPullRequests);
  const selected = selectedBasics.map((pullRequest) => deepEvidence(repo, repository, pullRequest));
  const watchedSet = eligible.map((pullRequest) => ({
    covered: pullRequest.currentHeadCovered,
    headSha: pullRequest.headRefOid,
    pullRequest: pullRequest.number,
  }));

  const evidence = {
    charter,
    collectedAt: new Date().toISOString(),
    covered: eligible.filter((pullRequest) => pullRequest.currentHeadCovered),
    deferredByRunLimit: eligible
      .filter((pullRequest) => !pullRequest.currentHeadCovered)
      .slice(charter.maximumPullRequests)
      .map((pullRequest) => ({
        headRefOid: pullRequest.headRefOid,
        number: pullRequest.number,
        riskRank: pullRequest.riskRank,
        url: pullRequest.url,
      })),
    noop: selected.length === 0,
    repo,
    repository,
    requiredReads: {
      charter: '.night-shift/charters/magnify.md',
      contractInventory: listMarkdownFiles(join(repo, 'docs/agents')).map(
        (name) => `docs/agents/${name}`
      ),
      instructions: listInstructionFiles(repo),
      learnings: listMarkdownFiles(join(repo, '.night-shift')).map(
        (name) => `.night-shift/${name}`
      ),
      protocol: '.night-shift/PROTOCOL.md',
    },
    safety: {
      dismissalInferencePerformed: false,
      externalWrites: false,
      repositoryWrites: false,
    },
    selected,
    watchedSet,
    workingTreeStatusAtCollection: git(repo, ['status', '--short']),
  };

  process.stdout.write(`${JSON.stringify(evidence, null, pretty ? 2 : 0)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`collect-magnify-evidence: ${message}\n`);
    process.exitCode = 1;
  }
}
