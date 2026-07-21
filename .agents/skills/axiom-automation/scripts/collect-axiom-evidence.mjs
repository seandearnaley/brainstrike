#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BUFFER = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const REQUIRED_PATHS = [
  'AGENTS.md',
  'package.json',
  '.night-shift/PROTOCOL.md',
  '.night-shift/charters/README.md',
  '.night-shift/charters/axiom.md',
  'docs/agents',
  'scripts',
];

function cleanEnvironment(overrides = {}) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  return { ...environment, ...overrides };
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: cleanEnvironment(options.env),
      maxBuffer: MAX_BUFFER,
      timeout: COMMAND_TIMEOUT_MS,
    }).trim();
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    const detail = stderr || error.message;
    throw new Error(`${command} ${args.join(' ')} failed: ${detail}`);
  }
}

function runStatus(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: cleanEnvironment(options.env),
    maxBuffer: MAX_BUFFER,
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function parseNullSeparated(value) {
  return value.split('\0').filter(Boolean);
}

function readGitFile(repo, reference, filePath) {
  return run('git', ['show', `${reference}:${filePath}`], { cwd: repo });
}

function listGitFiles(repo, reference, directory) {
  return parseNullSeparated(
    run('git', ['ls-tree', '-r', '--name-only', '-z', reference, '--', directory], {
      cwd: repo,
    })
  ).sort((left, right) => left.localeCompare(right));
}

function parseCharterMetadata(charter) {
  const metadata = {};
  for (const line of charter.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|([^#\s][^#]*?))(?:\s+#.*)?$/u);
    if (match) {
      metadata[match[1]] = (match[2] ?? match[3]).trim();
    }
  }
  return metadata;
}

export function extractInvariantStatements(sources) {
  const statements = [];
  for (const source of sources) {
    let insideFence = false;
    const lines = source.content.split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      if (line.trimStart().startsWith('```')) {
        insideFence = !insideFence;
        continue;
      }
      if (insideFence) {
        continue;
      }
      const keywords = [...line.matchAll(/\b(?:MUST|NEVER)\b/gu)].map((match) => match[0]);
      if (keywords.length === 0) {
        continue;
      }
      statements.push({
        file: source.path,
        keywords: [...new Set(keywords)],
        line: index + 1,
        text: line.trim(),
      });
    }
  }
  return statements;
}

function selectPackageScripts(packageJson) {
  const scripts = packageJson.scripts ?? {};
  return Object.fromEntries(
    Object.entries(scripts)
      .filter(([name]) => /(^lint(?:$|:)|test:scripts|guard|check|validate|scan)/iu.test(name))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

// Guard package scripts frequently chain through `pnpm run <name>` (e.g. lint:ci ->
// arch:domain-boundaries -> node scripts/...); expand that indirection so the wiring
// text contains the commands that actually execute scripts.
function expandWiring(allPackageScripts, selectedNames) {
  const reachable = new Set(selectedNames);
  const queue = [...reachable];
  while (queue.length > 0) {
    const name = queue.shift();
    const command = String(allPackageScripts[name] ?? '');
    for (const candidate of Object.keys(allPackageScripts)) {
      if (reachable.has(candidate)) {
        continue;
      }
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (new RegExp(`\\bpnpm\\s+(?:run\\s+)?${escaped}(?=$|[\\s'";&|])`, 'u').test(command)) {
        reachable.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return [...reachable].map((name) => String(allPackageScripts[name] ?? '')).join('\n');
}

function collectScriptInventory(allFiles, packageScripts, allPackageScripts) {
  const testFiles = allFiles.filter((filePath) =>
    /(?:^|\/)__tests__\/.*\.test\.[cm]?[jt]s$/u.test(filePath)
  );
  const executableFiles = allFiles.filter((filePath) => !testFiles.includes(filePath));
  const wiring = expandWiring(allPackageScripts, Object.keys(packageScripts));
  const isWired = (filePath) => {
    const withoutScriptsPrefix = filePath.replace(/^scripts\//u, '');
    return wiring.includes(filePath) || wiring.includes(withoutScriptsPrefix);
  };
  // Name signals align with Warden's guard-signal regex (verify-*/contract/enforce/forbid
  // guards are real), and wiring beats naming: any script executed by a guard-class
  // package script is a candidate regardless of what it is called. Missing a live guard
  // here means Axiom could file a duplicate guard for an already-guarded invariant.
  const guardCandidates = executableFiles.filter(
    (filePath) =>
      /(?:guard|contract|verify|check|enforce|scan|forbid|validate|lane)/iu.test(
        path.basename(filePath)
      ) || isWired(filePath)
  );
  const wiredGuardCandidates = guardCandidates.filter(isWired);

  return {
    allFiles,
    executableFiles,
    guardCandidates,
    testFiles,
    wiredGuardCandidates,
  };
}

function parseGitHubSlug(remoteUrl) {
  const match = remoteUrl.match(/github\.com(?::|\/)([^/\s]+\/[^/\s]+?)(?:\.git)?$/u);
  if (!match) {
    throw new Error(`origin is not a supported GitHub remote: ${remoteUrl}`);
  }
  return match[1];
}

function collectOpenPullRequests(repo, loopName) {
  const remoteUrl = run('git', ['remote', 'get-url', 'origin'], { cwd: repo });
  const repository = parseGitHubSlug(remoteUrl);
  const raw = run(
    'gh',
    [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--limit',
      '500',
      '--json',
      'number,title,url,isDraft,headRefName,headRefOid,baseRefName',
    ],
    { cwd: repo }
  );
  const pullRequests = JSON.parse(raw || '[]');
  if (!Array.isArray(pullRequests)) {
    throw new Error('GitHub returned a non-array PR response');
  }
  if (pullRequests.length >= 500) {
    throw new Error('GitHub PR collection reached its 500-item completeness limit');
  }
  const prefix = `night-shift/${loopName.toLowerCase()}/`;
  return pullRequests.filter((pullRequest) =>
    String(pullRequest.headRefName ?? '').startsWith(prefix)
  );
}

function resolveRepository(repoInput) {
  const repo = fs.realpathSync(repoInput);
  const root = fs.realpathSync(run('git', ['rev-parse', '--show-toplevel'], { cwd: repo }));
  if (repo !== root) {
    throw new Error(`--repo must be the repository root: ${root}`);
  }
  return repo;
}

function assertRequiredPaths(repo, reference) {
  for (const requiredPath of REQUIRED_PATHS) {
    const result = runStatus('git', ['cat-file', '-e', `${reference}:${requiredPath}`], {
      cwd: repo,
    });
    if (result.status !== 0) {
      throw new Error(`required repository path is missing at ${reference}: ${requiredPath}`);
    }
  }
}

function resolveDelta(repo, { watermark, fullSweep }) {
  const originMainSha = run('git', ['rev-parse', 'origin/main^{commit}'], { cwd: repo });
  if (fullSweep) {
    return {
      commits: [],
      files: parseNullSeparated(
        run('git', ['ls-tree', '-r', '--name-only', '-z', originMainSha], { cwd: repo })
      ),
      mode: 'full-sweep',
      originMainSha,
      watermark: null,
    };
  }

  const resolvedWatermark = run('git', ['rev-parse', `${watermark}^{commit}`], { cwd: repo });
  const ancestry = runStatus(
    'git',
    ['merge-base', '--is-ancestor', resolvedWatermark, originMainSha],
    { cwd: repo }
  );
  if (ancestry.status !== 0) {
    throw new Error(
      `watermark ${resolvedWatermark} is not an ancestor of origin/main ${originMainSha}`
    );
  }

  return {
    commits: run(
      'git',
      ['rev-list', '--first-parent', '--reverse', `${resolvedWatermark}..${originMainSha}`],
      { cwd: repo }
    )
      .split(/\r?\n/u)
      .filter(Boolean),
    files: parseNullSeparated(
      run('git', ['diff', '--name-only', '-z', `${resolvedWatermark}..${originMainSha}`], {
        cwd: repo,
      })
    ),
    mode: 'main-diff',
    originMainSha,
    watermark: resolvedWatermark,
  };
}

export function collectAxiomEvidence({ repo: repoInput, watermark, fullSweep = false }) {
  if (Boolean(watermark) === Boolean(fullSweep)) {
    throw new Error('provide exactly one of --watermark or --full-sweep');
  }

  const repo = resolveRepository(repoInput);
  const delta = resolveDelta(repo, { fullSweep, watermark });
  const sourceReference = delta.originMainSha;
  assertRequiredPaths(repo, sourceReference);
  const charterMetadata = parseCharterMetadata(
    readGitFile(repo, sourceReference, '.night-shift/charters/axiom.md')
  );
  if (charterMetadata.NAME !== 'Axiom') {
    throw new Error(`unexpected Axiom charter identity: ${charterMetadata.NAME ?? 'missing'}`);
  }
  if (!charterMetadata.CHARTER_VERSION) {
    throw new Error('Axiom charter is missing CHARTER_VERSION');
  }

  const docFiles = listGitFiles(repo, sourceReference, 'docs/agents')
    .filter(
      (filePath) => filePath.endsWith('.md') && path.posix.dirname(filePath) === 'docs/agents'
    )
    .sort((left, right) => left.localeCompare(right));
  const invariantSourcePaths = ['AGENTS.md', ...docFiles];
  const invariantSources = invariantSourcePaths.map((filePath) => ({
    content: readGitFile(repo, sourceReference, filePath),
    path: filePath,
  }));
  const packageJson = JSON.parse(readGitFile(repo, sourceReference, 'package.json'));
  const packageScripts = selectPackageScripts(packageJson);
  const openPullRequests = collectOpenPullRequests(repo, charterMetadata.NAME);
  const protocolViolations = [];
  if (openPullRequests.length > 1) {
    protocolViolations.push({
      code: 'multiple-open-axiom-prs',
      message: `found ${openPullRequests.length} open Axiom PRs; protocol permits one`,
      pullRequests: openPullRequests.map((pullRequest) => pullRequest.number),
    });
  }

  const learningFiles = listGitFiles(repo, sourceReference, '.night-shift')
    .filter(
      (filePath) => filePath.endsWith('.md') && path.posix.dirname(filePath) === '.night-shift'
    )
    .sort((left, right) => left.localeCompare(right));
  const invariantStatements = extractInvariantStatements(invariantSources);
  if (invariantStatements.length === 0) {
    throw new Error('no uppercase MUST or NEVER invariant statements were found');
  }
  const scriptInventory = collectScriptInventory(
    listGitFiles(repo, sourceReference, 'scripts'),
    packageScripts,
    packageJson.scripts ?? {}
  );

  const evidence = {
    charter: {
      learningsFile: charterMetadata.LEARNINGS_FILE ?? null,
      name: charterMetadata.NAME,
      path: '.night-shift/charters/axiom.md',
      role: charterMetadata.ROLE ?? null,
      stateIssue: charterMetadata.STATE_ISSUE ?? null,
      version: charterMetadata.CHARTER_VERSION,
    },
    collectedAt: new Date().toISOString(),
    delta,
    invariantStatements,
    openPullRequests,
    packageScripts,
    protocolViolations,
    repository: repo,
    requiredReading: {
      charterReadme: '.night-shift/charters/README.md',
      instructions: 'AGENTS.md',
      invariantSources: invariantSourcePaths,
      learningFiles,
      protocol: '.night-shift/PROTOCOL.md',
    },
    schemaVersion: 1,
    scriptInventory,
    sourceReference,
    summary: {
      changedFileCount: delta.files.length,
      firstParentCommitCount: delta.commits.length,
      guardCandidateCount: scriptInventory.guardCandidates.length,
      invariantStatementCount: invariantStatements.length,
      openAxiomPullRequestCount: openPullRequests.length,
    },
  };

  return evidence;
}

export function parseArguments(argv) {
  const options = { fullSweep: false, pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo' || argument === '--watermark') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
    } else if (argument === '--full-sweep') {
      options.fullSweep = true;
    } else if (argument === '--pretty') {
      options.pretty = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.repo) {
    throw new Error('--repo is required');
  }
  if (Boolean(options.watermark) === options.fullSweep) {
    throw new Error('provide exactly one of --watermark or --full-sweep');
  }
  return options;
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const evidence = collectAxiomEvidence(options);
    process.stdout.write(`${JSON.stringify(evidence, null, options.pretty ? 2 : 0)}\n`);
    if (evidence.protocolViolations.length > 0) {
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
