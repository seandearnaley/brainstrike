#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
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
  return {
    exitCode: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
};

const git = (repoRoot, args) => {
  const result = run('git', args, repoRoot);
  if (result.exitCode !== 0) {
    fail(`git ${args.join(' ')} failed with exit code ${result.exitCode}`);
  }
  return result.output.trim();
};

const parseKnip = (rawOutput, exitCode) => {
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
    fail(`pnpm knip failed operationally with exit code ${exitCode}`);
  }
  return { categories, exitCode, findingsTotal, outcome };
};

const parseDoctor = (rawOutput, exitCode) => {
  const output = stripAnsi(rawOutput);
  if (exitCode !== 0) {
    fail(`pnpm doctor failed with exit code ${exitCode}`);
  }
  const warningMatch = output.match(/All checks passed with (\d+) warning\(s\)/);
  const cleanMatch = output.match(/All checks passed(?! with)/);
  if (!(warningMatch || cleanMatch)) {
    fail('pnpm doctor output did not contain a recognized pass summary');
  }
  return {
    exitCode,
    outcome: 'passed',
    warnings: warningMatch ? Number.parseInt(warningMatch[1], 10) : 0,
  };
};

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
const doctorRun = run('pnpm', ['doctor'], repoRoot, { REACT_DOCTOR_NO_TELEMETRY: '1' });
writeFileSync(knipLog, knipRun.output, { flag: 'wx' });
writeFileSync(doctorLog, doctorRun.output, { flag: 'wx' });

const result = {
  doctor: {
    ...parseDoctor(doctorRun.output, doctorRun.exitCode),
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
  schemaVersion: 1,
};

process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
