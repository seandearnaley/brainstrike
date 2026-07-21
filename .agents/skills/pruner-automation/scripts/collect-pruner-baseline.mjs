#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// Read-only Git hardening, matching the Bolt collectors: never let a status
// or rev-parse opportunistically rewrite .git/index or spawn fsmonitor.
const GIT_READONLY_ENV = { GIT_OPTIONAL_LOCKS: '0' };
const GIT_READONLY_CONFIG = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
];

const fail = (message) => {
  process.stderr.write(`collect-pruner-baseline: ${message}\n`);
  process.exit(2);
};

const parseArgs = (argv) => {
  const options = { pretty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--pretty') {
      options.pretty = true;
      continue;
    }
    if (argument === '--repo' || argument === '--logs-dir') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        fail(`${argument} requires a value`);
      }
      options[argument === '--repo' ? 'repo' : 'logsDir'] = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${argument}`);
  }
  if (!options.repo) {
    fail('--repo is required');
  }
  if (!options.logsDir) {
    fail('--logs-dir is required');
  }
  return options;
};

const stripAnsi = (value) =>
  value.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape parser
    /(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    ''
  );

const run = (command, args, cwd, extraEnv = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    maxBuffer: MAX_BUFFER_BYTES,
    shell: false,
  });
  if (result.error) {
    fail(`${command} ${args.join(' ')} could not start: ${result.error.message}`);
  }
  if (result.signal) {
    fail(`${command} ${args.join(' ')} terminated by ${result.signal}`);
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    exitCode: result.status,
    output: `${stdout}${stderr}`,
    stderr,
    stdout,
  };
};

const git = (repoRoot, args) => {
  const result = run('git', [...GIT_READONLY_CONFIG, ...args], repoRoot, GIT_READONLY_ENV);
  if (result.exitCode !== 0) {
    fail(`git ${args.join(' ')} failed with exit code ${result.exitCode}`);
  }
  return result.output.trim();
};

export const parseKnip = (rawOutput, exitCode) => {
  const output = stripAnsi(rawOutput);
  const categories = {};
  const headingPattern = /^([^\n]+?) \((\d+)\)\s*$/gm;
  for (const match of output.matchAll(headingPattern)) {
    categories[match[1].trim()] = Number.parseInt(match[2], 10);
  }
  const findingsTotal = Object.values(categories).reduce((total, count) => total + count, 0);
  let outcome = 'failed';
  if (exitCode === 0) {
    outcome = 'clean';
  } else if (exitCode === 1 && findingsTotal > 0) {
    outcome = 'findings';
  }
  if (outcome === 'failed') {
    throw new Error(`pnpm knip failed operationally with exit code ${exitCode}`);
  }
  return { categories, exitCode, findingsTotal, outcome };
};

// React Doctor is parsed from its structured `--json` report, not scraped
// CLI copy: the report is a stable contract (ok/summary/projects) while the
// human-readable summary strings change between releases. A completed scan
// that surfaces error-severity diagnostics is a FINDINGS outcome (the
// burndown Pruner acts on), never an operational failure — only ok:false is
// operational. Skipped checks mean incomplete results and are surfaced, not
// silently treated as a clean bill.
export const parseDoctor = (stdoutText, exitCode) => {
  const trimmed = stdoutText.trim();
  let report;
  try {
    report = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `pnpm doctor --json did not emit a parseable JSON report (exit code ${exitCode})`
    );
  }
  if (
    report === null ||
    typeof report !== 'object' ||
    typeof report.ok !== 'boolean' ||
    report.summary === null ||
    typeof report.summary !== 'object'
  ) {
    throw new Error('pnpm doctor --json report is missing the expected ok/summary shape');
  }
  if (report.ok !== true) {
    const detail = report.error?.message ? `: ${report.error.message}` : '';
    throw new Error(`pnpm doctor failed operationally${detail}`);
  }
  const summary = report.summary;
  if (typeof summary.errorCount !== 'number' || typeof summary.warningCount !== 'number') {
    throw new Error('pnpm doctor --json summary is missing diagnostic counts');
  }
  const skippedChecks = Array.isArray(report.projects)
    ? report.projects.reduce(
        (total, project) =>
          total + (Array.isArray(project.skippedChecks) ? project.skippedChecks.length : 0),
        0
      )
    : 0;
  return {
    affectedFileCount: summary.affectedFileCount ?? null,
    errorCount: summary.errorCount,
    exitCode,
    incompleteResults: skippedChecks > 0,
    outcome: summary.errorCount > 0 ? 'findings' : 'passed',
    score: summary.score ?? null,
    scoreLabel: summary.scoreLabel ?? null,
    skippedChecks,
    totalDiagnosticCount: summary.totalDiagnosticCount ?? summary.errorCount + summary.warningCount,
    warnings: summary.warningCount,
  };
};

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!isAbsolute(options.logsDir)) {
    fail('--logs-dir must be an absolute path');
  }
  if (!existsSync(options.logsDir)) {
    fail(`--logs-dir does not exist: ${options.logsDir}`);
  }

  const requestedRepo = resolve(options.repo);
  if (!existsSync(requestedRepo)) {
    fail(`repository does not exist: ${requestedRepo}`);
  }
  const repoRoot = realpathSync(requestedRepo);
  const logsDir = realpathSync(options.logsDir);
  const logsPathFromRepo = relative(repoRoot, logsDir);
  if (
    logsPathFromRepo === '' ||
    !(logsPathFromRepo.startsWith('..') || isAbsolute(logsPathFromRepo))
  ) {
    fail('--logs-dir must be outside the repository');
  }
  const knipLog = join(logsDir, 'knip.log');
  const doctorLog = join(logsDir, 'doctor.log');
  for (const logPath of [knipLog, doctorLog]) {
    if (existsSync(logPath)) {
      fail(`refusing to overwrite existing log: ${logPath}`);
    }
  }
  for (const requiredPath of [
    'package.json',
    'pnpm-workspace.yaml',
    '.night-shift/PROTOCOL.md',
    '.night-shift/charters/pruner.md',
  ]) {
    if (!existsSync(join(repoRoot, requiredPath))) {
      fail(`required Brainstrike file is missing: ${requiredPath}`);
    }
  }
  if (git(repoRoot, ['rev-parse', '--show-toplevel']) !== repoRoot) {
    fail(`--repo is not the Git worktree root: ${repoRoot}`);
  }

  const knipRun = run('pnpm', ['knip'], repoRoot);
  // `--` forwards --json to react-doctor unambiguously; --json suppresses the
  // human-readable render and emits a single JSON report on stdout.
  const doctorRun = run('pnpm', ['run', 'doctor', '--', '--json'], repoRoot, {
    REACT_DOCTOR_NO_TELEMETRY: '1',
  });
  writeFileSync(knipLog, knipRun.output, { flag: 'wx' });
  writeFileSync(doctorLog, doctorRun.output, { flag: 'wx' });

  const result = {
    doctor: {
      ...parseDoctor(doctorRun.stdout, doctorRun.exitCode),
      logPath: doctorLog,
    },
    generatedAt: new Date().toISOString(),
    git: {
      branch: git(repoRoot, ['branch', '--show-current']),
      head: git(repoRoot, ['rev-parse', 'HEAD']),
      originMain: git(repoRoot, ['rev-parse', 'origin/main']),
      worktreeStatus: git(repoRoot, ['status', '--short']),
    },
    knip: {
      ...parseKnip(knipRun.output, knipRun.exitCode),
      logPath: knipLog,
    },
    repoRoot,
    schemaVersion: 2,
  };

  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
