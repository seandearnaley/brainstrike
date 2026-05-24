import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative } from 'node:path';
import { promisify } from 'node:util';

import { normalizePath } from './ci-risk-rules.mjs';
import {
  CI_DIFF_FILTER,
  collectGitSelection,
  renderSelectionJson,
} from './ci-select.mjs';
import { splitLines } from './ci-script-utils.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_OPTIONS = {
  base: 'origin/main',
  head: 'HEAD',
  labels: '',
  proof: '.ci/proof/latest.json',
};

function isGitSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

function readExpectedPackageManager() {
  // Manifest validation is synchronous so tests and pure validation callers can
  // get deterministic failures without wiring async I/O through the API.
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  );
  if (typeof packageJson.packageManager !== 'string') {
    throw new Error('package.json packageManager must be a string');
  }
  return packageJson.packageManager;
}

function parsePnpmVersion(packageManager) {
  const match = /^pnpm@(.+)$/.exec(packageManager);
  if (!match) {
    throw new Error('package.json packageManager must use pnpm');
  }
  return match[1];
}

export async function defaultRunner(command, args = [], options = {}) {
  if (options.shell === true) {
    if (args.length > 0) {
      throw new Error('args must be empty when shell is true');
    }
    await new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: '/bin/sh',
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('close', (exitCode) => {
        if (exitCode === 0) {
          resolve();
          return;
        }
        reject(new Error(`command failed with exit code ${exitCode}: ${command}`));
      });
    });
    return '';
  }

  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
  });
  return stdout;
}

function parseMode(args, invokedName) {
  const [mode, ...rest] = args;
  if (['prove', 'verify-proof'].includes(mode)) {
    return { mode, rest };
  }
  if (invokedName.endsWith('ci-prove.mjs')) {
    return { mode: 'prove', rest: args };
  }
  if (invokedName.endsWith('ci-verify-proof.mjs')) {
    return { mode: 'verify-proof', rest: args };
  }
  throw new Error('mode must be prove or verify-proof');
}

function parseFlags(args, mode) {
  const options = { ...DEFAULT_OPTIONS, mode };
  const allowedFlags =
    mode === 'prove'
      ? new Set(['--base', '--head', '--proof'])
      : new Set(['--base', '--head', '--proof', '--labels', '--github-output']);
  const seen = new Set();

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowedFlags.has(flag)) {
      throw new Error(`unknown flag ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`${flag} can only be provided once`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--') || (value === '' && flag !== '--labels')) {
      throw new Error(`${flag} requires a value`);
    }
    seen.add(flag);
    options[flag.slice(2)] = value;
  }

  return options;
}

export function parseProofArgs(
  args = process.argv.slice(2),
  invokedName = process.argv[1] ?? ''
) {
  const { mode, rest } = parseMode(args, invokedName);
  return parseFlags(rest, mode);
}

export function buildProofManifest(input) {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    repository: input.repository,
    packageManager: input.packageManager,
    pnpmVersion: input.pnpmVersion,
    nodeVersion: input.nodeVersion,
    baseRef: input.baseRef ?? input.selection.base,
    headRef: input.headRef ?? input.selection.head,
    testedHeadSha: input.testedHeadSha,
    selection: input.selection,
    commandResults: input.commandResults,
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArray(value, name, failures) {
  if (!Array.isArray(value)) {
    failures.push(`${name} must be an array`);
    return [];
  }
  return value;
}

export function validateProofManifest(manifest) {
  const failures = [];
  if (!isObject(manifest)) {
    return ['proof manifest must be an object'];
  }
  if (manifest.schemaVersion !== 1) {
    failures.push('schemaVersion must be 1');
  }
  if (typeof manifest.generatedAt !== 'string') {
    failures.push('generatedAt must be a string');
  }
  if (typeof manifest.repository !== 'string') {
    failures.push('repository must be a string');
  }
  const expectedPackageManager = readExpectedPackageManager();
  const expectedPnpmVersion = parsePnpmVersion(expectedPackageManager);
  if (manifest.packageManager !== expectedPackageManager) {
    failures.push(`packageManager must be ${expectedPackageManager}`);
  }
  if (manifest.pnpmVersion !== expectedPnpmVersion) {
    failures.push(`pnpmVersion must be ${expectedPnpmVersion}`);
  }
  if (!isGitSha(manifest.testedHeadSha)) {
    failures.push('testedHeadSha must be a 40-character hex SHA');
  }
  if (!isObject(manifest.selection)) {
    failures.push('selection must be an object');
  } else {
    if (!isObject(manifest.selection.riskProfile)) {
      failures.push('selection.riskProfile must be an object');
    }
    if (!isObject(manifest.selection.budget)) {
      failures.push('selection.budget must be an object');
    }
    validateArray(manifest.selection.labels, 'selection.labels', failures);
    validateArray(manifest.selection.commands, 'selection.commands', failures);
  }

  const commandResults = validateArray(
    manifest.commandResults,
    'commandResults',
    failures
  );
  for (const result of commandResults) {
    if (!isObject(result)) {
      failures.push('command result must be an object');
      continue;
    }
    if (typeof result.name !== 'string') {
      failures.push('command result name must be a string');
    }
    if (typeof result.command !== 'string') {
      failures.push(`command ${result.name ?? '<unknown>'} is missing command`);
    }
    if (result.exitCode !== 0) {
      failures.push(`command ${result.name ?? '<unknown>'} failed`);
    }
    if (typeof result.durationMs !== 'number') {
      failures.push(`command ${result.name ?? '<unknown>'} is missing durationMs`);
    }
    if (typeof result.owner !== 'string') {
      failures.push(`command ${result.name ?? '<unknown>'} is missing owner`);
    }
    if (typeof result.budgetMs !== 'number') {
      failures.push(`command ${result.name ?? '<unknown>'} is missing budgetMs`);
    }
    if (!['ok', 'over-budget'].includes(result.budgetStatus)) {
      failures.push(`command ${result.name ?? '<unknown>'} has invalid budgetStatus`);
    }
  }

  if (isObject(manifest.selection) && Array.isArray(manifest.selection.commands)) {
    const resultNames = new Set(
      commandResults
        .filter((result) => isObject(result) && typeof result.name === 'string')
        .map((result) => result.name)
    );
    for (const command of manifest.selection.commands) {
      if (
        isObject(command) &&
        typeof command.name === 'string' &&
        !resultNames.has(command.name)
      ) {
        failures.push(`selection command ${command.name} has no result`);
      }
    }
  }

  return failures;
}

export function verifyLabels(requiredLabels, actualLabels) {
  // Only non-ci labels are allowed to be extra. Extra ci:* labels over-select
  // cloud lanes and can turn a small change into an expensive proof path.
  const actual = new Set(actualLabels);
  const required = new Set(requiredLabels);
  const failures = requiredLabels
    .filter((label) => !actual.has(label))
    .map((label) => `missing required PR label ${label}`);
  for (const label of actualLabels) {
    if (label.startsWith('ci:') && !required.has(label)) {
      failures.push(
        `unexpected PR label ${label}; selected labels are ${
          requiredLabels.length > 0 ? requiredLabels.join(',') : '<none>'
        }`
      );
    }
  }
  return failures;
}

function proofPathCandidates(proofPath) {
  const candidates = new Set([normalizePath(proofPath)]);
  if (isAbsolute(proofPath)) {
    candidates.add(normalizePath(relative(process.cwd(), proofPath)));
  }
  return candidates;
}

export function verifyProofTipDiff(files, proofPath = DEFAULT_OPTIONS.proof) {
  const allowedProofPaths = proofPathCandidates(proofPath);
  return files
    .filter((filePath) => !allowedProofPaths.has(normalizePath(filePath)))
    .map((filePath) => `proof is stale: ${filePath} changed after testedHeadSha`);
}

function splitLabels(labels) {
  return labels
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

async function assertCleanWorktree(runner) {
  const status = splitLines(await runner('git', ['status', '--porcelain']));
  if (status.length > 0) {
    throw new Error(
      `pnpm ci:prove requires a clean worktree; dirty entries:\n${status.join('\n')}`
    );
  }
}

async function readPackageManager() {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  return packageJson.packageManager;
}

export function normalizeRepositoryIdentifier(remoteUrl) {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const sshMatch = /^git@github\.com:(?<repository>[^/]+\/[^/]+)$/.exec(trimmed);
  if (sshMatch?.groups?.repository) {
    return sshMatch.groups.repository;
  }

  const httpsMatch = /^https:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)$/.exec(
    trimmed
  );
  if (httpsMatch?.groups?.repository) {
    return httpsMatch.groups.repository;
  }

  return trimmed;
}

async function readRepositoryIdentifier(runner) {
  const remoteUrl = await runner('git', ['remote', 'get-url', 'origin']);
  return normalizeRepositoryIdentifier(remoteUrl);
}

async function runProofCommand(command, runner) {
  const startedAt = Date.now();
  try {
    // Shell commands must come from the repo-owned command registry in ci-select.
    await runner(command.command, [], { shell: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`proof command "${command.name}" (owner: ${command.owner}) failed: ${message}`);
  }
  const durationMs = Math.max(1, Date.now() - startedAt);
  return {
    name: command.name,
    command: command.command,
    owner: command.owner,
    budgetMs: command.budgetMs,
    budgetStatus: durationMs > command.budgetMs ? 'over-budget' : 'ok',
    exitCode: 0,
    durationMs,
  };
}

export async function prove(options, runner = defaultRunner) {
  await assertCleanWorktree(runner);
  const selection = await collectGitSelection(options, runner);
  const packageManager = await readPackageManager();
  const expectedPackageManager = readExpectedPackageManager();
  const expectedPnpmVersion = parsePnpmVersion(expectedPackageManager);
  if (packageManager !== expectedPackageManager) {
    throw new Error(`packageManager must be ${expectedPackageManager}`);
  }
  const pnpmVersion = (await runner('pnpm', ['--version'])).trim();
  if (pnpmVersion !== expectedPnpmVersion) {
    throw new Error(`pnpm --version must be ${expectedPnpmVersion}`);
  }
  const repository = await readRepositoryIdentifier(runner);

  const commandResults = [];
  for (const command of selection.commands) {
    commandResults.push(await runProofCommand(command, runner));
  }

  const manifest = buildProofManifest({
    commandResults,
    generatedAt: new Date().toISOString(),
    repository,
    packageManager,
    pnpmVersion,
    nodeVersion: process.version,
    baseRef: options.base,
    headRef: options.head,
    selection,
    testedHeadSha: selection.headSha,
  });

  const proofPath = options.proof ?? DEFAULT_OPTIONS.proof;
  await mkdir(dirname(proofPath), { recursive: true });
  await writeFile(proofPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function comparableSelection(selection) {
  return {
    files: selection.files,
    riskProfile: selection.riskProfile,
    budget: selection.budget,
    lanes: selection.lanes,
    expandedLanes: selection.expandedLanes,
    labels: selection.labels,
    commands: selection.commands.map((command) => ({
      name: command.name,
      command: command.command,
      owner: command.owner,
      budgetMs: command.budgetMs,
    })),
  };
}

function compareJsonObject(name, actual, expected) {
  if (!isObject(actual) || !isObject(expected)) {
    return [`${name} must be an object`];
  }
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    return [];
  }
  return [`${name} differs`];
}

function compareArrays(name, actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    return [`${name} must be an array`];
  }
  if (actual.length !== expected.length) {
    return [`${name} length differs`];
  }
  const failures = [];
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      failures.push(
        `${name}[${index}] differs: expected ${expected[index]}, got ${actual[index]}`
      );
    }
  }
  return failures;
}

function compareCommandEntries(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    return ['selection.commands must be an array'];
  }
  if (actual.length !== expected.length) {
    return ['selection.commands length differs'];
  }
  const failures = [];
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]?.name !== expected[index]?.name) {
      failures.push(
        `selection.commands[${index}].name differs: expected ${
          expected[index]?.name
        }, got ${actual[index]?.name}`
      );
    }
    if (actual[index]?.command !== expected[index]?.command) {
      failures.push(
        `selection.commands[${index}].command differs: expected ${
          expected[index]?.command
        }, got ${actual[index]?.command}`
      );
    }
    if (actual[index]?.owner !== expected[index]?.owner) {
      failures.push(
        `selection.commands[${index}].owner differs: expected ${
          expected[index]?.owner
        }, got ${actual[index]?.owner}`
      );
    }
    if (actual[index]?.budgetMs !== expected[index]?.budgetMs) {
      failures.push(
        `selection.commands[${index}].budgetMs differs: expected ${
          expected[index]?.budgetMs
        }, got ${actual[index]?.budgetMs}`
      );
    }
  }
  return failures;
}

function compareSelections(actual, expected) {
  const actualSelection = comparableSelection(actual);
  const expectedSelection = comparableSelection(expected);
  return [
    ...compareArrays('selection.files', actualSelection.files, expectedSelection.files),
    ...compareJsonObject(
      'selection.riskProfile',
      actualSelection.riskProfile,
      expectedSelection.riskProfile
    ),
    ...compareJsonObject(
      'selection.budget',
      actualSelection.budget,
      expectedSelection.budget
    ),
    ...compareArrays('selection.lanes', actualSelection.lanes, expectedSelection.lanes),
    ...compareArrays(
      'selection.expandedLanes',
      actualSelection.expandedLanes,
      expectedSelection.expandedLanes
    ),
    ...compareArrays(
      'selection.labels',
      actualSelection.labels,
      expectedSelection.labels
    ),
    ...compareCommandEntries(
      actualSelection.commands,
      expectedSelection.commands
    ),
  ];
}

async function appendGithubOutput(path, manifest) {
  if (!isGitSha(manifest.testedHeadSha)) {
    throw new Error('testedHeadSha must be a 40-character hex SHA');
  }
  const lines = [
    `required-labels=${manifest.selection.labels.join(',')}`,
    `expanded-lanes=${manifest.selection.expandedLanes.join(',')}`,
    `tested-head-sha=${manifest.testedHeadSha}`,
  ];
  await writeFile(path, `${lines.join('\n')}\n`, { flag: 'a' });
}

export async function verifyProof(options, runner = defaultRunner) {
  const proofPath = options.proof ?? DEFAULT_OPTIONS.proof;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(proofPath, 'utf8'));
  } catch (cause) {
    throw new Error(
      `could not read proof manifest at ${proofPath}; did you run "pnpm ci:prove"?`,
      { cause }
    );
  }
  const failures = validateProofManifest(manifest);

  if (failures.length === 0) {
    const recomputedSelection = await collectGitSelection(
      { base: options.base, head: manifest.testedHeadSha },
      runner
    );
    const selectionFailures = compareSelections(
      recomputedSelection,
      manifest.selection
    );
    if (selectionFailures.length > 0) {
      failures.push('proof selection does not match recomputed risk selection');
      failures.push(...selectionFailures);
    }
  }

  failures.push(
    ...verifyLabels(manifest.selection?.labels ?? [], splitLabels(options.labels ?? ''))
  );

  try {
    await runner('git', [
      'merge-base',
      '--is-ancestor',
      manifest.testedHeadSha,
      options.head,
    ]);
  } catch {
    failures.push('testedHeadSha is not an ancestor of head');
  }

  const changedAfterProof = splitLines(
    await runner('git', [
      'diff',
      '--name-only',
      `--diff-filter=${CI_DIFF_FILTER}`,
      manifest.testedHeadSha,
      options.head,
    ])
  );
  failures.push(...verifyProofTipDiff(changedAfterProof, proofPath));

  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }

  if (options['github-output']) {
    await appendGithubOutput(options['github-output'], manifest);
  }

  return manifest;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseProofArgs(args);
  if (options.mode === 'prove') {
    await prove(options);
  } else {
    await verifyProof(options);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
