import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { collectGitSelection } from './ci-select.mjs';
import { verifyLabels } from './ci-proof.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_OPTIONS = {
  base: 'origin/main',
  format: 'text',
  head: 'HEAD',
  labels: '',
};

function splitLabels(labels) {
  return labels
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

async function defaultRunner(command, args) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
  });
  return stdout;
}

function parseFlag(args, index, seen, options) {
  const flag = args[index];
  if (!['--base', '--head', '--labels', '--format'].includes(flag)) {
    throw new Error(`unknown flag ${flag}`);
  }
  if (seen.has(flag)) {
    throw new Error(`${flag} can only be provided once`);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  seen.add(flag);
  options[flag.slice(2)] = value;
  return index + 2;
}

export function parseDoctorArgs(args = process.argv.slice(2)) {
  const options = { ...DEFAULT_OPTIONS };
  const seen = new Set();
  let index = 0;
  while (index < args.length) {
    index = parseFlag(args, index, seen, options);
  }

  if (!['text', 'json'].includes(options.format)) {
    throw new Error('--format must be text or json');
  }

  return options;
}

export function validateDoctorLabels(selection, labels) {
  if (!labels) {
    return [];
  }
  return verifyLabels(selection.labels, splitLabels(labels));
}

export function validateCleanWorktree(statusOutput) {
  const status = statusOutput.trimEnd();
  if (!status) {
    return [];
  }
  return [
    `ci:doctor only evaluates committed changes; commit or stash dirty files first:\n${status}`,
  ];
}

function formatDuration(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function buildDoctorReport(selection, labelFailures = []) {
  const lines = [
    'Brainstrike CI proof doctor',
    '',
    `Risk category: ${selection.riskProfile?.category ?? '<unknown>'}`,
    `Changed files: ${selection.files.length}`,
    '',
    'Selected PR labels:',
    ...(selection.labels.length > 0
      ? selection.labels.map((label) => `  ${label}`)
      : ['  <none>']),
    '',
    'Allowed local proof commands:',
    ...selection.commands.map(
      (command) =>
        `  ${command.name} (${command.owner}, budget ${formatDuration(
          command.budgetMs
        )})`
    ),
    '',
    `Total local proof budget: ${formatDuration(selection.budget.totalMs)} / ${formatDuration(
      selection.budget.targetMs
    )} (${selection.budget.status})`,
    '',
    'Do not run broad E2E or add broad ci labels unless they appear above.',
    'Do not run ci:prove again after a failure until the failing selected command is fixed.',
    'Commit .ci/proof/latest.json last, by itself.',
  ];

  if (labelFailures.length > 0) {
    lines.splice(2, 0, 'Label problems:', ...labelFailures.map((failure) => `  ${failure}`), '');
  }

  return `${lines.join('\n')}\n`;
}

export function buildDoctorJson(selection, labelFailures = []) {
  return `${JSON.stringify(
    {
      labelFailures,
      labels: selection.labels,
      commands: selection.commands.map((command) => ({
        name: command.name,
        command: command.command,
        owner: command.owner,
        budgetMs: command.budgetMs,
      })),
      budget: selection.budget,
      riskProfile: selection.riskProfile,
      files: selection.files,
    },
    null,
    2
  )}\n`;
}

export async function doctor(options, runner = defaultRunner) {
  const worktreeFailures = validateCleanWorktree(
    await runner('git', ['status', '--porcelain'])
  );
  if (worktreeFailures.length > 0) {
    throw new Error(worktreeFailures.join('\n'));
  }

  const selection = await collectGitSelection(options, runner);
  const labelFailures = validateDoctorLabels(selection, options.labels);
  const output =
    options.format === 'json'
      ? buildDoctorJson(selection, labelFailures)
      : buildDoctorReport(selection, labelFailures);
  return {
    labelFailures,
    output,
    selection,
  };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseDoctorArgs(args);
  const result = await doctor(options);
  process.stdout.write(result.output);
  if (result.labelFailures.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
