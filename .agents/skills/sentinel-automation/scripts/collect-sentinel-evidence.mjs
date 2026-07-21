#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const MAIN_REF = 'origin/main';

const REQUIRED_FILES = [
  'AGENTS.md',
  '.night-shift/PROTOCOL.md',
  '.night-shift/charters/sentinel.md',
  '.night-shift/sentinel.md',
  'docs/agents/platform-contracts.md',
  'docs/agents/assistant-providers.md',
  'scripts/secret-scan.mjs',
  'secret-scan.config.json',
];

const CANDIDATE_RULES = [
  {
    gitPattern: 'Math[.]random[[:space:]]*[(]',
    id: 'weak-randomness',
    javascriptPattern: /Math\.random\s*\(/i,
    lens: 'hardening-drift',
  },
  {
    gitPattern: 'timingSafeEqual|secret|token|signature|digest|hmac',
    id: 'timing-sensitive-comparison',
    javascriptPattern: /timingSafeEqual|secret|token|signature|digest|hmac/i,
    lens: 'hardening-drift',
  },
  {
    gitPattern:
      'safeStorage|isEncryptionAvailable|encryptString|decryptString|credential|api[_-]?key',
    id: 'secret-storage',
    javascriptPattern:
      /safeStorage|isEncryptionAvailable|encryptString|decryptString|credential|api[_-]?key/i,
    lens: 'hardening-drift',
  },
  {
    gitPattern:
      'Access-Control-Allow-Origin|cors|setWindowOpenHandler|window[.]open|BrowserWindow|origin',
    id: 'origin-or-window-trust',
    javascriptPattern:
      /Access-Control-Allow-Origin|cors|setWindowOpenHandler|window\.open|BrowserWindow|origin/i,
    lens: 'hardening-drift',
  },
  {
    gitPattern: 'logger[.](debug|info|warn|error)|redact|authorization|credential|api[_-]?key',
    id: 'redaction-or-credential-logging',
    javascriptPattern:
      /logger\.(debug|info|warn|error)|redact|authorization|credential|api[_-]?key/i,
    lens: 'secrets',
  },
  {
    gitPattern: 'localStorage|sessionStorage|indexedDB|persist|factoryReset|approval|credential',
    id: 'credential-or-approval-persistence',
    javascriptPattern:
      /localStorage|sessionStorage|indexedDB|persist|factoryReset|approval|credential/i,
    lens: 'secrets',
  },
  {
    gitPattern:
      'ipcMain[.](handle|on)|ipcRenderer[.](invoke|send|on)|contextBridge[.]exposeInMainWorld|preload|capability|permission',
    id: 'ipc-preload-or-capability-surface',
    javascriptPattern:
      /ipcMain\.(handle|on)|ipcRenderer\.(invoke|send|on)|contextBridge\.exposeInMainWorld|preload|capability|permission/i,
    lens: 'boundary-changes',
  },
];

function usage() {
  return [
    'Usage: collect-sentinel-evidence.mjs --repo <absolute-path> --watermark <sha> [--pretty]',
    '',
    'Collects read-only Sentinel evidence for <watermark>..origin/main.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { pretty: false, repo: null, watermark: null };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pretty') {
      parsed.pretty = true;
      continue;
    }
    if (argument === '--help') {
      return { ...parsed, help: true };
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

  if (!parsed.repo) {
    throw new Error('--repo is required; repository discovery is intentionally disabled');
  }
  if (!parsed.watermark) {
    throw new Error('--watermark is required; watermark guessing is intentionally disabled');
  }
  if (!isAbsolute(parsed.repo)) {
    throw new Error('--repo must be an absolute path');
  }
  if (!/^[0-9a-f]{40}$/iu.test(parsed.watermark)) {
    throw new Error('--watermark must be an exact full commit SHA; guessing is disabled');
  }
  return parsed;
}

function execute(command, args, cwd, encoding = 'utf8') {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding,
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
    const detail = stderr ? `: ${stderr}` : '';
    throw new Error(`${command} ${args.join(' ')} failed${detail}`, { cause: error });
  }
}

function git(repo, args, encoding = 'utf8') {
  return execute('git', ['-C', repo, ...args], repo, encoding);
}

function splitNullDelimited(value) {
  return value.split('\0').filter(Boolean);
}

function readCharterAssignment(charter, name) {
  const match = charter.match(new RegExp(`^${name}=(?:"([^"]*)"|([^\\s#]+))`, 'm'));
  const value = match?.[1] ?? match?.[2];
  if (!value) {
    throw new Error(`Sentinel charter is missing ${name}`);
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
  const head = requireObject(pullRequest.head, `GitHub pull request ${index}.head`);
  const user = requireObject(pullRequest.user, `GitHub pull request ${index}.user`);
  if (!Number.isInteger(pullRequest.number)) {
    throw new Error(`GitHub pull request ${index}.number must be an integer`);
  }
  if (typeof pullRequest.draft !== 'boolean') {
    throw new Error(`GitHub pull request ${index}.draft must be a boolean`);
  }
  return {
    author: { login: requireString(user.login, `GitHub pull request ${index}.user.login`) },
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

function assertRequiredFiles(repo) {
  const missing = REQUIRED_FILES.filter((file) => !existsSync(join(repo, file)));
  if (missing.length > 0) {
    throw new Error(`Repository is missing required Sentinel files: ${missing.join(', ')}`);
  }
}

function assertOriginRemote(repo) {
  const remote = git(repo, ['remote', 'get-url', 'origin']).trim();
  if (!/(?:github\.com[:/])seandearnaley\/brainstrike(?:\.git)?$/u.test(remote)) {
    throw new Error(`Unexpected origin remote for Sentinel: ${remote}`);
  }
}

function assertRequiredFilesAtHead(repo, head) {
  const tracked = new Set(
    splitNullDelimited(git(repo, ['ls-tree', '-r', '-z', '--name-only', head]))
  );
  const missing = REQUIRED_FILES.filter((file) => !tracked.has(file));
  if (missing.length > 0) {
    throw new Error(
      `Pinned ${MAIN_REF} head ${head} is missing required Sentinel files: ${missing.join(', ')}`
    );
  }
}

function assertScannerMatchesHead(repo, head) {
  const headBlobId = git(repo, ['rev-parse', `${head}:scripts/secret-scan.mjs`]).trim();
  const worktreeBlobId = git(repo, [
    'hash-object',
    '--',
    join(repo, 'scripts/secret-scan.mjs'),
  ]).trim();
  if (headBlobId !== worktreeBlobId) {
    throw new Error(
      `scripts/secret-scan.mjs in the working tree differs from the pinned ${MAIN_REF} head ${head}; ` +
        'the collector imports the working-tree scanner, so a local edit could silently change scan behavior. ' +
        'Restore scripts/secret-scan.mjs to the origin/main version before collecting.'
    );
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
  const raw = git(repo, ['log', '--first-parent', '--format=%H%x00%aI%x00%s%x00', range, '--']);
  const fields = raw.split('\0');
  while (fields.length > 0 && fields.at(-1).trim() === '') {
    fields.pop();
  }
  const normalizedFields = fields.map((field) => field.replace(/^\n/, ''));
  if (normalizedFields.length % 3 !== 0) {
    throw new Error('Unexpected git log record shape');
  }
  const commits = [];
  for (let index = 0; index < normalizedFields.length; index += 3) {
    commits.push({
      authoredAt: normalizedFields[index + 1].trim(),
      sha: normalizedFields[index].trim(),
      subject: normalizedFields[index + 2].trim(),
    });
  }
  return commits;
}

function parseChangedFiles(repo, range) {
  const fields = splitNullDelimited(
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

function matchingAddedLineNumbers(diff, pattern) {
  let newLine = null;
  const matches = [];
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (newLine === null || line.startsWith('+++')) {
      continue;
    }
    if (line.startsWith('+')) {
      if (pattern.test(line.slice(1))) {
        matches.push(newLine);
      }
      newLine += 1;
      continue;
    }
    if (!(line.startsWith('-') || line.startsWith('\\ No newline'))) {
      newLine += 1;
    }
  }
  return [...new Set(matches)];
}

function collectCandidates(repo, range) {
  const diffCache = new Map();
  return CANDIDATE_RULES.map((rule) => {
    const paths = splitNullDelimited(
      git(repo, [
        'diff',
        '--name-only',
        '-z',
        '--diff-filter=ACMR',
        '--regexp-ignore-case',
        `-G${rule.gitPattern}`,
        range,
        '--',
      ])
    );
    const matches = paths
      .map((path) => {
        let diff = diffCache.get(path);
        if (diff === undefined) {
          diff = git(repo, [
            'diff',
            '--unified=0',
            '--no-ext-diff',
            '--no-color',
            range,
            '--',
            path,
          ]);
          diffCache.set(path, diff);
        }
        return {
          addedLineNumbers: matchingAddedLineNumbers(diff, rule.javascriptPattern),
          path,
        };
      })
      .filter((match) => match.addedLineNumbers.length > 0);
    return { id: rule.id, lens: rule.lens, matches };
  });
}

function readMainBlob(repo, ref, path) {
  const blob = git(repo, ['cat-file', 'blob', `${ref}:${path}`], null);
  if (blob.includes(0)) {
    return null;
  }
  return blob.toString('utf8');
}

function loadConfigFromHeadBlob(repo, head, scanner) {
  const configBlob = readMainBlob(repo, head, 'secret-scan.config.json');
  if (configBlob === null) {
    throw new Error(`secret-scan.config.json at ${head} is not valid UTF-8 text`);
  }
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'sentinel-secret-scan-'));
  try {
    const configPath = join(temporaryDirectory, 'secret-scan.config.json');
    writeFileSync(configPath, configBlob);
    return scanner.loadConfig(configPath);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

async function scanChangedFiles(repo, head, changedFiles) {
  assertScannerMatchesHead(repo, head);
  const scannerPath = join(repo, 'scripts/secret-scan.mjs');
  const scanner = await import(pathToFileURL(scannerPath).href);
  if (typeof scanner.loadConfig !== 'function' || typeof scanner.scanFileList !== 'function') {
    throw new Error('Repository secret scanner does not expose the expected API');
  }
  const files = changedFiles
    .filter((file) => !file.status.startsWith('D'))
    .map((file) => file.path);
  const config = loadConfigFromHeadBlob(repo, head, scanner);
  const findings = scanner.scanFileList({
    config,
    files,
    readFile: (path) => readMainBlob(repo, head, path),
  });
  return {
    checkedFileCount: files.length,
    configSource: `${head}:secret-scan.config.json`,
    findings: findings.map(({ column, filePath, line, ruleId, secretHash }) => ({
      column,
      filePath,
      line,
      ruleId,
      secretHash,
    })),
    passed: findings.length === 0,
    scanner: 'scripts/secret-scan.mjs',
  };
}

function githubContext(repo) {
  const repository = JSON.parse(
    execute('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], repo)
  );
  const actor = execute('gh', ['api', 'user', '--jq', '.login'], repo).trim();
  const openPullRequests = parseOpenPullRequestPages(
    execute(
      'gh',
      [
        'api',
        '--paginate',
        '--slurp',
        `repos/${repository.nameWithOwner}/pulls?state=open&per_page=100`,
      ],
      repo
    ),
    'night-shift/sentinel/'
  );
  if (openPullRequests.length > 1) {
    throw new Error(`Protocol violation: found ${openPullRequests.length} open Sentinel PRs`);
  }
  return { actor, openPullRequest: openPullRequests[0] ?? null, repository };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const requestedRepo = realpathSync(resolve(args.repo));
  const repo = realpathSync(git(requestedRepo, ['rev-parse', '--show-toplevel']).trim());
  if (repo !== requestedRepo) {
    throw new Error(`--repo must be the repository root: ${repo}`);
  }
  assertRequiredFiles(repo);
  assertOriginRemote(repo);

  const head = git(repo, ['rev-parse', '--verify', `${MAIN_REF}^{commit}`]).trim();
  const watermark = git(repo, ['rev-parse', '--verify', `${args.watermark}^{commit}`]).trim();
  assertRequiredFilesAtHead(repo, head);
  assertAncestor(repo, watermark, head);
  const range = `${watermark}..${head}`;

  const charterPath = join(repo, '.night-shift/charters/sentinel.md');
  const charter = readFileSync(charterPath, 'utf8');
  const learningsFile = readCharterAssignment(charter, 'LEARNINGS_FILE');
  const changedFiles = parseChangedFiles(repo, range);
  const commits = parseCommits(repo, range);
  const github = githubContext(repo);
  const secretScan = await scanChangedFiles(repo, head, changedFiles);
  const learningHeadings = readFileSync(join(repo, learningsFile), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());
  const nightShiftFiles = readdirSync(join(repo, '.night-shift'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `.night-shift/${entry.name}`)
    .sort();

  const result = {
    charter: {
      charterVersion: readCharterAssignment(charter, 'CHARTER_VERSION'),
      learningsFile,
      name: readCharterAssignment(charter, 'NAME'),
      stateIssue: readCharterAssignment(charter, 'STATE_ISSUE'),
    },
    evidence: {
      candidateRules: collectCandidates(repo, range),
      learningHeadings,
      nightShiftFiles,
      secretScan,
    },
    generatedAt: new Date().toISOString(),
    loopState: {
      openPullRequest: github.openPullRequest,
      requiredExternalChecks: [
        'Read the latest append-only checkpoint on the charter state issue.',
        'Resolve any reopened Sentinel-owned ticket before declaring NOOP.',
      ],
    },
    notes: [
      'Candidate matches are triage leads, not security findings.',
      'Candidate line numbers refer to the origin/main version.',
      'No secret contents are included in this output.',
      'The collector performs no GitHub, Linear, branch, or working-tree writes.',
    ],
    repository: {
      actor: github.actor,
      nameWithOwner: github.repository.nameWithOwner,
      root: repo,
      url: github.repository.url,
    },
    schemaVersion: 1,
    scope: {
      changedFiles,
      commits,
      diffStat: git(repo, ['diff', '--shortstat', range, '--']).trim(),
      empty: changedFiles.length === 0,
      head,
      range,
      watermark,
    },
  };

  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
