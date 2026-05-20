#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { CI_DIFF_FILTER } from './ci-select.mjs';
import { splitLines } from './ci-script-utils.mjs';

const execFileAsync = promisify(execFile);

const UNIT_TEST_FILE_PATTERN =
  /(^|\/)(?!e2e\/).+\.(test|integration\.test)\.(ts|tsx|mts|mjs)$/;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePath(filePath) {
  return String(filePath).replaceAll('\\', '/').replace(/^\.\/+/, '');
}

export function isUnitTestFile(filePath) {
  const normalized = normalizePath(filePath);
  return (
    /^(apps|packages)\//.test(normalized) &&
    !normalized.includes('/e2e/') &&
    UNIT_TEST_FILE_PATTERN.test(normalized)
  );
}

async function defaultRunner(command, args, options = {}) {
  const { stderr, stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
  });
  return `${stdout}${stderr}`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function workspaceRootForFile(filePath) {
  const parts = normalizePath(filePath).split('/');
  if (parts.length < 3 || !['apps', 'packages'].includes(parts[0])) {
    throw new Error(`changed unit test is outside an app/package workspace: ${filePath}`);
  }
  return `${parts[0]}/${parts[1]}`;
}

async function resolveWorkspace(rootDir, workspaceRoot) {
  const packageJsonPath = path.join(rootDir, workspaceRoot, 'package.json');
  const packageJson = await readJson(packageJsonPath);
  if (!isObject(packageJson) || typeof packageJson.name !== 'string') {
    throw new Error(`${packageJsonPath} must define a package name`);
  }
  if (!isObject(packageJson.scripts) || typeof packageJson.scripts.test !== 'string') {
    throw new Error(`${packageJsonPath} must define a test script for changed unit tests`);
  }
  return {
    name: packageJson.name,
    root: workspaceRoot,
  };
}

export async function planChangedUnitTests(files, options = {}) {
  const rootDir = options.cwd ?? process.cwd();
  const unitTestFiles = files.map((filePath) => normalizePath(filePath)).filter(isUnitTestFile);
  const grouped = new Map();
  for (const filePath of unitTestFiles) {
    const workspaceRoot = workspaceRootForFile(filePath);
    const relativeFile = filePath.slice(`${workspaceRoot}/`.length);
    const existing = grouped.get(workspaceRoot) ?? [];
    existing.push(relativeFile);
    grouped.set(workspaceRoot, existing);
  }

  const commands = [];
  for (const [workspaceRoot, relativeFiles] of [...grouped].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const workspace = await resolveWorkspace(rootDir, workspaceRoot);
    commands.push({
      args: ['--filter', workspace.name, 'exec', 'vitest', 'run', ...relativeFiles.sort()],
      command: 'pnpm',
      files: [...relativeFiles].sort(),
      owner: workspace.name,
      workspaceRoot,
    });
  }
  return commands;
}

function readFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseChangedUnitTestArgs(args = process.argv.slice(2)) {
  const base = readFlagValue(args, '--base');
  const head = readFlagValue(args, '--head') ?? 'HEAD';
  const dryRun = args.includes('--dry-run');
  if (!base) {
    throw new Error('--base is required');
  }
  return { base, dryRun, head };
}

async function changedFiles({ base, head, runner }) {
  const stdout = await runner('git', [
    'diff',
    '--name-only',
    `--diff-filter=${CI_DIFF_FILTER}`,
    base,
    head,
    '--',
  ]);
  return splitLines(stdout);
}

export async function runChangedUnitTests(options) {
  const runner = options.runner ?? defaultRunner;
  const files = options.files ?? (await changedFiles({ ...options, runner }));
  const commands = await planChangedUnitTests(files, { cwd: options.cwd });
  if (commands.length === 0) {
    console.log('No changed unit test files selected.');
    return 0;
  }
  if (options.dryRun) {
    console.log(JSON.stringify({ commands }, null, 2));
    return 0;
  }
  for (const command of commands) {
    console.log(`Running ${command.owner}: ${command.files.join(', ')}`);
    await runner(command.command, command.args, { cwd: options.cwd });
  }
  return 0;
}

export async function runCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseChangedUnitTestArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  try {
    return await runChangedUnitTests(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
