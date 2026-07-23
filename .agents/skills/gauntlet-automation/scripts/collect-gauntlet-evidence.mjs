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
        'Usage: node collect-gauntlet-evidence.mjs --repo <path> --watermark <full-sha> [--revision <revision>] [--pretty]\n'
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
  if (!/^[0-9a-f]{40}$/iu.test(options.watermark)) {
    fail('--watermark must be an exact 40-hex commit SHA');
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

function collectMergedAssistantPrs(repo, watermark) {
  const since = git(repo, ['show', '-s', '--format=%cI', watermark]).trim();
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
      'number,title,mergedAt',
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
        typeof value.mergedAt === 'string'
      )
    ) {
      fail(`gh pr list entry ${index} has an invalid shape`);
    }
    const detail = parseJson(
      execute('gh', ['pr', 'view', String(value.number), '--json', 'files'], repo),
      `gh pr view ${value.number}`
    );
    if (
      !detail ||
      typeof detail !== 'object' ||
      !Array.isArray(detail.files) ||
      !detail.files.every(
        (file) => file && typeof file === 'object' && typeof file.path === 'string'
      )
    ) {
      fail(`gh pr view ${value.number} files has an invalid shape`);
    }
    if (detail.files.some((file) => isAssistantTerritory(file.path))) {
      results.push({ mergedAt: value.mergedAt, number: value.number, title: value.title });
    }
  }
  return results.sort((left, right) => left.number - right.number);
}

function collect(options) {
  const repo = validateRepo(options.repo);
  git(repo, ['rev-parse', '--verify', `${options.watermark}^{commit}`]);
  const revision = git(repo, ['rev-parse', '--verify', `${options.revision}^{commit}`]).trim();
  assertAncestor(repo, options.watermark, revision);
  const spec = readRevisionFile(repo, revision, SPEC_PATH);
  const runner = readRevisionFile(repo, revision, RUNNER_PATH);
  const assistantDelta = parseNameStatus(
    git(repo, [
      'diff',
      '--name-status',
      `${options.watermark}..${revision}`,
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
    mergedAssistantPrs: collectMergedAssistantPrs(repo, options.watermark),
    revision,
    schema: 'collect-gauntlet-evidence/v1',
    watermark: options.watermark,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(collect(options), null, options.pretty ? 2 : 0)}\n`);
}

main();
