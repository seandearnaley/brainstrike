#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRIPT_NAME = 'collect-gauntlet-evidence';
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SPEC_PATH = 'packages/agent/src/__tests__/agent-behavior-eval.spec.ts';
const RUNNER_PATH = 'packages/agent/src/evaluation/agent-behavior-eval-runner.ts';
const ASSISTANT_PREFIXES = [
  'packages/agent/',
  'packages/assistant-contract/',
  'packages/assistant/',
];

function fail(message) {
  process.stderr.write(`${SCRIPT_NAME}: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { pretty: false, revision: 'origin/main' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      process.stdout.write(
        'Usage: node collect-gauntlet-evidence.mjs --repo <path> --watermark <full-sha|none> [--revision <revision>] [--pretty]\n'
      );
      process.exit(0);
    }
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (!['--repo', '--revision', '--watermark'].includes(argument)) {
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
  if (!options.watermark) {
    fail('--watermark is required');
  }
  if (options.watermark !== 'none' && !/^[0-9a-f]{40}$/iu.test(options.watermark)) {
    fail("--watermark must be 'none' (first run only) or an exact 40-hex commit SHA");
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
    fail(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function git(repo, args) {
  return execute('git', ['-C', repo, ...args], repo);
}

function validateRepo(repoArgument) {
  let repo;
  try {
    repo = realpathSync(resolve(repoArgument));
  } catch (error) {
    fail(`cannot resolve --repo: ${error instanceof Error ? error.message : String(error)}`);
  }
  const topLevel = git(repo, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(topLevel) !== repo) {
    fail(`--repo must name the git work-tree root: ${topLevel}`);
  }
  if (!existsSync(resolve(repo, '.night-shift/PROTOCOL.md'))) {
    fail(`${repo} does not contain .night-shift/PROTOCOL.md`);
  }
  return repo;
}

function readRevisionFile(repo, revision, path) {
  return execute('git', ['-C', repo, 'show', `${revision}:${path}`], repo);
}

function assertAncestor(repo, watermark, revision) {
  const result = spawnSync(
    'git',
    ['-C', repo, 'merge-base', '--is-ancestor', watermark, revision],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (result.status === 0) {
    return;
  }
  if (result.status === 1) {
    fail(`watermark ${watermark} is not an ancestor of ${revision}`);
  }
  fail(`unable to validate watermark ancestry: ${result.stderr.trim()}`);
}

function parseNameStatus(raw) {
  if (!raw.trim()) {
    return [];
  }
  return raw
    .trimEnd()
    .split('\n')
    .map((line) => {
      const fields = line.split('\t');
      if (!fields[0]) {
        fail(`unparseable git diff entry: ${line}`);
      }
      if (fields[0].startsWith('R') || fields[0].startsWith('C')) {
        if (fields.length !== 3) {
          fail(`unparseable rename/copy entry: ${line}`);
        }
        return { oldPath: fields[1], path: fields[2], status: fields[0] };
      }
      if (fields.length !== 2) {
        fail(`unparseable git diff entry: ${line}`);
      }
      return { path: fields[1], status: fields[0] };
    });
}

function extractTitles(text) {
  return [...text.matchAll(/\bit\s*\(\s*(['"])(.*?)\1/gu)].map((match) => match[2]);
}

function extractFlowNames(text) {
  return [...text.matchAll(/\bname\s*:\s*(['"])(.*?)\1/gu)].map((match) => match[2]);
}

function parseJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(
      `${context} returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function isAssistantTerritory(path) {
  return ASSISTANT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function resolveRepository(repo) {
  const payload = parseJson(
    execute('gh', ['repo', 'view', '--json', 'nameWithOwner'], repo),
    'gh repo view'
  );
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.nameWithOwner !== 'string' ||
    !/^[^/\s]+\/[^/\s]+$/u.test(payload.nameWithOwner)
  ) {
    fail('gh repo view returned an invalid nameWithOwner');
  }
  return payload.nameWithOwner;
}

// gh's `files` JSON field is a single non-paginated GraphQL page (first 100):
// a PR whose assistant edits sit past file #100 would silently classify as
// non-assistant. `changedFiles` carries the true count, so truncation is
// detectable — complete the listing via the paginated REST endpoint and fail
// closed when even that cannot be proven complete.
function completePrFiles(repo, repository, number, listedFiles, changedFiles) {
  if (listedFiles.length === changedFiles) {
    return listedFiles.map((file) => file.path);
  }
  const raw = execute(
    'gh',
    [
      'api',
      `repos/${repository}/pulls/${number}/files`,
      '--paginate',
      '--slurp',
      '--jq',
      '[.[][].filename]',
    ],
    repo
  );
  const paths = parseJson(raw, `gh api pulls/${number}/files`);
  if (!(Array.isArray(paths) && paths.every((path) => typeof path === 'string'))) {
    fail(`gh api pulls/${number}/files returned an invalid shape`);
  }
  if (paths.length !== changedFiles) {
    fail(
      `PR #${number} file listing is incomplete: ${paths.length} of ${changedFiles} — coverage cannot be proven`
    );
  }
  return paths;
}

function collectMergedAssistantPrs(repo, watermark) {
  const since = git(repo, ['show', '-s', '--format=%cI', watermark]).trim();
  const repository = resolveRepository(repo);
  // One list call carries files (first page) + the true changedFiles count;
  // the per-PR REST completion below runs only for >100-file PRs.
  const raw = execute(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      '200',
      '--search',
      `merged:>=${since}`,
      '--json',
      'number,title,mergedAt,changedFiles,files',
    ],
    repo
  );
  const pullRequests = parseJson(raw, 'gh pr list');
  if (!Array.isArray(pullRequests)) {
    fail('gh pr list result must be an array');
  }
  if (pullRequests.length >= 200) {
    fail('gh pr list reached its 200-result limit; complete pagination cannot be proven');
  }
  const results = [];
  for (const [index, value] of pullRequests.entries()) {
    if (
      !(
        value &&
        typeof value === 'object' &&
        Number.isInteger(value.number) &&
        typeof value.title === 'string' &&
        typeof value.mergedAt === 'string' &&
        Number.isInteger(value.changedFiles) &&
        Array.isArray(value.files) &&
        value.files.every(
          (file) => file && typeof file === 'object' && typeof file.path === 'string'
        )
      )
    ) {
      fail(`gh pr list entry ${index} has an invalid shape`);
    }
    const paths = completePrFiles(repo, repository, value.number, value.files, value.changedFiles);
    if (paths.some((path) => isAssistantTerritory(path))) {
      results.push({ mergedAt: value.mergedAt, number: value.number, title: value.title });
    }
  }
  return results.sort((left, right) => left.number - right.number);
}

// First-run baseline (BST-722): a `none` watermark resolves to the oldest
// commit that introduced the Gauntlet charter — deterministic and reviewable,
// never an invented SHA. Fail closed when that history cannot be proven.
const CHARTER_PATH = '.night-shift/charters/gauntlet.md';

function deriveBootstrapWatermark(repo, revision) {
  // A truncated clone's oldest reachable commit touching the charter is the
  // graft boundary, not the introducing commit — indistinguishable from the
  // real thing once returned, so refuse rather than derive a plausible lie.
  // (Promisor/partial clones keep the full commit graph; only shallowness
  // truncates rev-list.)
  if (git(repo, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    fail('cannot bootstrap --watermark none in a shallow clone; run git fetch --unshallow first');
  }
  // Rule: oldest commit introducing the charter AT ITS CURRENT PATH. A rename
  // restarts that history on purpose — the new path's introduction becomes the
  // new reviewable baseline, never a silently followed pre-rename commit.
  const history = git(repo, ['rev-list', '--reverse', revision, '--', CHARTER_PATH]).trim();
  if (!history) {
    fail(
      `cannot bootstrap --watermark none: ${CHARTER_PATH} charter has no history at ${revision}`
    );
  }
  return history.split('\n')[0];
}

function collect(options) {
  const repo = validateRepo(options.repo);
  const revision = git(repo, ['rev-parse', '--verify', `${options.revision}^{commit}`]).trim();
  const watermarkBootstrapped = options.watermark === 'none';
  const watermark = watermarkBootstrapped
    ? deriveBootstrapWatermark(repo, revision)
    : options.watermark;
  git(repo, ['rev-parse', '--verify', `${watermark}^{commit}`]);
  assertAncestor(repo, watermark, revision);
  const spec = readRevisionFile(repo, revision, SPEC_PATH);
  const runner = readRevisionFile(repo, revision, RUNNER_PATH);
  const assistantDelta = parseNameStatus(
    git(repo, [
      'diff',
      '--name-status',
      `${watermark}..${revision}`,
      '--',
      'packages/agent',
      'packages/assistant-contract',
      'packages/assistant',
    ])
  );
  return {
    assistantDelta,
    evalSuite: {
      flowNames: [...new Set([...extractFlowNames(spec), ...extractFlowNames(runner)])].sort(),
      specTitles: extractTitles(spec),
      suiteHash: createHash('sha256')
        .update(spec + runner)
        .digest('hex'),
    },
    generatedAt: new Date().toISOString(),
    mergedAssistantPrs: collectMergedAssistantPrs(repo, watermark),
    revision,
    schema: 'collect-gauntlet-evidence/v1',
    watermark,
    watermarkBootstrapped,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(collect(options), null, options.pretty ? 2 : 0)}\n`);
}

main();
