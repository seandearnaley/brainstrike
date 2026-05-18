import { exec, execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { collectGitSelection, renderSelectionJson } from './ci-select.mjs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const DEFAULT_OPTIONS = {
  base: 'origin/main',
  head: 'HEAD',
  labels: '',
  proof: '.ci/proof/latest.json',
};

const EXPECTED_PACKAGE_MANAGER = 'pnpm@10.33.0';
const EXPECTED_PNPM_VERSION = '10.33.0';
const PROOF_PATH = '.ci/proof/latest.json';

async function defaultRunner(command, args = [], options = {}) {
  if (options.shell === true) {
    const { stdout } = await execAsync(command, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 200,
      shell: '/bin/bash',
    });
    return stdout;
  }

  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
  });
  return stdout;
}

function parseMode(args) {
  const invokedName = process.argv[1] ?? '';
  if (invokedName.endsWith('ci-prove.mjs')) {
    return { mode: 'prove', rest: args };
  }
  if (invokedName.endsWith('ci-verify-proof.mjs')) {
    return { mode: 'verify-proof', rest: args };
  }
  const [mode, ...rest] = args;
  if (!['prove', 'verify-proof'].includes(mode)) {
    throw new Error('mode must be prove or verify-proof');
  }
  return { mode, rest };
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
    if (!value || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    seen.add(flag);
    options[flag.slice(2)] = value;
  }

  return options;
}

export function parseProofArgs(args = process.argv.slice(2)) {
  const { mode, rest } = parseMode(args);
  return parseFlags(rest, mode);
}

export function buildProofManifest(input) {
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    repository: input.repository ?? 'seandearnaley/brainstrike',
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
  if (manifest.packageManager !== EXPECTED_PACKAGE_MANAGER) {
    failures.push(`packageManager must be ${EXPECTED_PACKAGE_MANAGER}`);
  }
  if (manifest.pnpmVersion !== EXPECTED_PNPM_VERSION) {
    failures.push(`pnpmVersion must be ${EXPECTED_PNPM_VERSION}`);
  }
  if (typeof manifest.testedHeadSha !== 'string') {
    failures.push('testedHeadSha must be a string');
  }
  if (!isObject(manifest.selection)) {
    failures.push('selection must be an object');
  } else {
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
  const actual = new Set(actualLabels);
  return requiredLabels
    .filter((label) => !actual.has(label))
    .map((label) => `missing required PR label ${label}`);
}

export function verifyProofTipDiff(files) {
  return files
    .filter((filePath) => filePath !== PROOF_PATH)
    .map((filePath) => `proof is stale: ${filePath} changed after testedHeadSha`);
}

function splitLines(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
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

async function runProofCommand(command, runner) {
  const startedAt = Date.now();
  await runner(command.command, [], { shell: true });
  return {
    name: command.name,
    command: command.command,
    exitCode: 0,
    durationMs: Math.max(1, Date.now() - startedAt),
  };
}

export async function prove(options, runner = defaultRunner) {
  await assertCleanWorktree(runner);
  const selection = await collectGitSelection(options, runner);
  const packageManager = await readPackageManager();
  if (packageManager !== EXPECTED_PACKAGE_MANAGER) {
    throw new Error(`packageManager must be ${EXPECTED_PACKAGE_MANAGER}`);
  }
  const pnpmVersion = (await runner('pnpm', ['--version'])).trim();
  if (pnpmVersion !== EXPECTED_PNPM_VERSION) {
    throw new Error(`pnpm --version must be ${EXPECTED_PNPM_VERSION}`);
  }

  const commandResults = [];
  for (const command of selection.commands) {
    commandResults.push(await runProofCommand(command, runner));
  }

  const manifest = buildProofManifest({
    commandResults,
    generatedAt: new Date().toISOString(),
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
    lanes: selection.lanes,
    expandedLanes: selection.expandedLanes,
    labels: selection.labels,
    commandNames: selection.commands.map((command) => command.name),
  };
}

function appendGithubOutput(path, manifest) {
  const lines = [
    `required-labels=${manifest.selection.labels.join(',')}`,
    `expanded-lanes=${manifest.selection.expandedLanes.join(',')}`,
    `tested-head-sha=${manifest.testedHeadSha}`,
  ];
  return writeFile(path, `${lines.join('\n')}\n`, { flag: 'a' });
}

export async function verifyProof(options, runner = defaultRunner) {
  const proofPath = options.proof ?? DEFAULT_OPTIONS.proof;
  const manifest = JSON.parse(await readFile(proofPath, 'utf8'));
  const failures = validateProofManifest(manifest);

  if (failures.length === 0) {
    const recomputedSelection = await collectGitSelection(
      { base: options.base, head: manifest.testedHeadSha },
      runner
    );
    if (
      JSON.stringify(comparableSelection(recomputedSelection)) !==
      JSON.stringify(comparableSelection(manifest.selection))
    ) {
      failures.push('proof selection does not match recomputed risk selection');
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
      '--diff-filter=ACMRTUXB',
      manifest.testedHeadSha,
      options.head,
    ])
  );
  failures.push(...verifyProofTipDiff(changedAfterProof));

  if (options['github-output']) {
    await appendGithubOutput(options['github-output'], manifest);
  }

  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
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
