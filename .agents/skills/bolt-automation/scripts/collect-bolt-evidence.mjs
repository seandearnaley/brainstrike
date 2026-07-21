#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const MAIN_REF = 'origin/main';
const REPOSITORY = 'seandearnaley/brainstrike';
const REQUIRED_FILES = [
  'AGENTS.md',
  '.night-shift/PROTOCOL.md',
  '.night-shift/charters/bolt.md',
  '.night-shift/bolt.md',
];

const EVIDENCE_RULES = [
  ['benchmarks', /(?:^|\/)(?:benchmarks?|perf)(?:\/|\.|$)/iu],
  ['vitest-hotspots', /(?:vitest|\.test\.|\.spec\.)/iu],
  ['pglite-query-io', /(?:pglite|postgres|packages\/db|query|repository)/iu],
  ['react-render-commit', /(?:\.tsx$|react|component|render)/iu],
  ['queue-worker-watcher', /(?:queue|worker|watcher|watch)/iu],
  ['index-retrieval', /(?:index|retriev|search|embedding|rag)/iu],
  ['bundle-token-memory', /(?:bundle|build|token|memory|buffer|cache)/iu],
];

function usage() {
  return [
    'Usage: collect-bolt-evidence.mjs --repo <absolute-path> --watermark <full-sha> [--pretty]',
    '',
    'Collect read-only Bolt evidence for <watermark>..origin/main.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { help: false, pretty: false, repo: null, watermark: null };
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
    if (argument === '--repo' || argument === '--watermark') {
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
  if (!(parsed.watermark && /^[0-9a-f]{40}$/iu.test(parsed.watermark))) {
    throw new Error('--watermark must be an exact full commit SHA; guessing is disabled');
  }
  return parsed;
}

function execute(command, args, cwd, encoding = 'utf8') {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding,
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

function git(repo, args, encoding = 'utf8') {
  return execute(
    'git',
    ['-C', repo, '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', ...args],
    repo,
    encoding
  );
}

function splitNull(value) {
  return value.split('\0').filter(Boolean);
}

function readAssignment(charter, name) {
  const match = charter.match(new RegExp(`^${name}=(?:"([^"]*)"|([^#\\n]+))`, 'm'));
  const value = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!value) {
    throw new Error(`Bolt charter is missing ${name}`);
  }
  return value;
}

function requireObject(value, context) {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error(`${context} must be an object`);
  }
  return value;
}

function requireString(value, context) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
}

function normalizeOpenPullRequest(value, index) {
  const pullRequest = requireObject(value, `GitHub pull request ${index}`);
  const base = requireObject(pullRequest.base, `GitHub pull request ${index}.base`);
  const head = requireObject(pullRequest.head, `GitHub pull request ${index}.head`);
  if (!Number.isInteger(pullRequest.number)) {
    throw new Error(`GitHub pull request ${index}.number must be an integer`);
  }
  if (typeof pullRequest.draft !== 'boolean') {
    throw new Error(`GitHub pull request ${index}.draft must be a boolean`);
  }
  return {
    baseRefName: requireString(base.ref, `GitHub pull request ${index}.base.ref`),
    headRefName: requireString(head.ref, `GitHub pull request ${index}.head.ref`),
    headRefOid: requireString(head.sha, `GitHub pull request ${index}.head.sha`),
    isDraft: pullRequest.draft,
    number: pullRequest.number,
    title: requireString(pullRequest.title, `GitHub pull request ${index}.title`),
    updatedAt: requireString(pullRequest.updated_at, `GitHub pull request ${index}.updated_at`),
    url: requireString(pullRequest.html_url, `GitHub pull request ${index}.html_url`),
  };
}

function parseOpenPullRequestPages(raw, branchPrefix) {
  const pages = JSON.parse(raw);
  if (!(Array.isArray(pages) && pages.every(Array.isArray))) {
    throw new Error('GitHub paginated pull request response must be an array of pages');
  }
  return pages
    .flat()
    .filter(
      (pullRequest) =>
        typeof pullRequest?.head?.ref === 'string' && pullRequest.head.ref.startsWith(branchPrefix)
    )
    .map(normalizeOpenPullRequest);
}

function assertRepository(repo) {
  const missing = REQUIRED_FILES.filter((path) => !existsSync(join(repo, path)));
  if (missing.length > 0) {
    throw new Error(`Repository is missing required Bolt files: ${missing.join(', ')}`);
  }
  const topLevel = realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim());
  if (topLevel !== repo) {
    throw new Error(`--repo must be the Git top-level: received ${repo}, resolved ${topLevel}`);
  }
  const remote = git(repo, ['remote', 'get-url', 'origin']).trim();
  if (!/(?:github\.com[:/])seandearnaley\/brainstrike(?:\.git)?$/u.test(remote)) {
    throw new Error(`Unexpected origin remote for Bolt: ${remote}`);
  }
}

function assertAncestor(repo, ancestor, descendant) {
  const result = spawnSync(
    'git',
    ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant],
    { cwd: repo, encoding: 'utf8' }
  );
  if (result.status === 0) {
    return;
  }
  if (result.status === 1) {
    throw new Error(`Watermark ${ancestor} is not an ancestor of ${descendant}`);
  }
  throw new Error(`Unable to validate watermark ancestry: ${result.stderr.trim()}`);
}

function parseCommits(repo, range) {
  const fields = splitNull(
    git(repo, ['log', '--first-parent', '--format=%H%x00%aI%x00%s%x00', range, '--'])
  ).map((field) => field.replace(/^\n/u, '').trim());
  if (fields.length % 3 !== 0) {
    throw new Error('Unexpected first-parent log record shape');
  }
  const commits = [];
  for (let index = 0; index < fields.length; index += 3) {
    commits.push({ authoredAt: fields[index + 1], sha: fields[index], subject: fields[index + 2] });
  }
  return commits;
}

function parseChangedFiles(repo, range) {
  const fields = splitNull(
    git(repo, ['diff', '--name-status', '-z', '--find-renames', range, '--'])
  );
  const files = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    index += 1;
    if (!status) {
      throw new Error('Unexpected empty git diff status');
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index];
      const path = fields[index + 1];
      if (!(previousPath && path)) {
        throw new Error(`Unexpected git diff record for ${status}`);
      }
      files.push({ path, previousPath, status });
      index += 2;
      continue;
    }
    const path = fields[index];
    if (!path) {
      throw new Error(`Unexpected git diff record for ${status}`);
    }
    files.push({ path, status });
    index += 1;
  }
  return files;
}

function blobIdAtMain(repo, file) {
  if (file.status.startsWith('D')) {
    return null;
  }
  return git(repo, ['rev-parse', `${MAIN_REF}:${file.path}`]).trim();
}

export function collectOpenPullRequests(repo, run = execute) {
  const raw = run(
    'gh',
    ['api', '--paginate', '--slurp', `repos/${REPOSITORY}/pulls?state=open&per_page=100`],
    repo
  );
  const boltPullRequests = parseOpenPullRequestPages(raw, 'night-shift/bolt/');
  if (boltPullRequests.length > 1) {
    throw new Error(`Protocol violation: ${boltPullRequests.length} open Bolt pull requests`);
  }
  return boltPullRequests;
}

function collectLearningFiles(repo) {
  return readdirSync(join(repo, '.night-shift'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `.night-shift/${entry.name}`)
    .sort();
}

function collectEvidenceLeads(files) {
  return Object.fromEntries(
    EVIDENCE_RULES.map(([name, pattern]) => [
      name,
      files.filter((file) => pattern.test(file.path)).map((file) => file.path),
    ])
  );
}

function collect(args) {
  const repo = realpathSync(args.repo);
  assertRepository(repo);
  git(repo, ['cat-file', '-e', `${args.watermark}^{commit}`]);
  git(repo, ['cat-file', '-e', `${MAIN_REF}^{commit}`]);
  assertAncestor(repo, args.watermark, MAIN_REF);

  const charterPath = join(repo, '.night-shift/charters/bolt.md');
  const charter = readFileSync(charterPath, 'utf8');
  const charterValues = Object.fromEntries(
    [
      'NAME',
      'ROLE',
      'AUTONOMY',
      'CHARTER_VERSION',
      'STATE_ISSUE',
      'LEARNINGS_FILE',
      'WALL_CLOCK_BUDGET',
    ].map((name) => [name, readAssignment(charter, name)])
  );
  if (!existsSync(join(repo, charterValues.LEARNINGS_FILE))) {
    throw new Error(`Live Bolt learning file does not exist: ${charterValues.LEARNINGS_FILE}`);
  }

  const originMainSha = git(repo, ['rev-parse', MAIN_REF]).trim();
  const remoteMainFields = git(repo, ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'])
    .trim()
    .split(/\s+/u);
  if (remoteMainFields.length !== 2 || !/^[0-9a-f]{40}$/iu.test(remoteMainFields[0])) {
    throw new Error('Unable to resolve an exact remote main SHA');
  }
  const remoteMainSha = remoteMainFields[0];
  if (originMainSha !== remoteMainSha) {
    throw new Error(
      `Local ${MAIN_REF} is stale (${originMainSha}); fetch remote main ${remoteMainSha} before continuing`
    );
  }
  const range = `${args.watermark}..${originMainSha}`;
  const commits = parseCommits(repo, range);
  const changedFiles = parseChangedFiles(repo, range).map((file) => ({
    ...file,
    originMainBlobId: blobIdAtMain(repo, file),
  }));
  const worktreeEntries = splitNull(git(repo, ['status', '--porcelain=v1', '-z']));

  return {
    advisoryOnly:
      'Evidence leads route inspection only; they do not establish a bottleneck, candidate, or finding.',
    charter: charterValues,
    collectedAt: new Date().toISOString(),
    delta: {
      changedFiles,
      commitCount: commits.length,
      commits,
      empty: changedFiles.length === 0,
      evidenceLeads: collectEvidenceLeads(changedFiles),
    },
    git: {
      branch: git(repo, ['branch', '--show-current']).trim(),
      head: git(repo, ['rev-parse', 'HEAD']).trim(),
      originMain: originMainSha,
      remoteMain: remoteMainSha,
      watermark: args.watermark,
      watermarkRange: range,
      worktreeEntries,
    },
    learningFiles: collectLearningFiles(repo),
    openBoltPullRequests: collectOpenPullRequests(repo),
    repoRoot: repo,
    repository: REPOSITORY,
  };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify(collect(args), null, args.pretty ? 2 : 0)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`collect-bolt-evidence: ${message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
