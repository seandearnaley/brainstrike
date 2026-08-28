#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/u;

function runTsc(args) {
  const invocation = createSpawnInvocation('pnpm', ['exec', 'tsc', ...args]);
  return spawnSync(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: invocation.shell,
  });
}

function commandOutput(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

export function verifyTestTsconfigProgram({
  checkTypes = true,
  cwd,
  minTestFiles,
  project,
  runTscCommand = runTsc,
}) {
  if (!(typeof cwd === 'string' && path.isAbsolute(cwd))) {
    throw new Error('verify-test-tsconfig-program: cwd must be an absolute path');
  }
  if (!(Number.isInteger(minTestFiles) && minTestFiles > 0)) {
    throw new Error('verify-test-tsconfig-program: minTestFiles must be a positive integer');
  }
  if (!(typeof project === 'string' && project.length > 0)) {
    throw new Error('verify-test-tsconfig-program: project is required');
  }

  const projectPath = path.resolve(cwd, project);
  const listed = runTscCommand(['--listFilesOnly', '--project', projectPath]);
  if (listed.error) {
    return {
      message: `Unable to run tsc for ${projectPath}: ${listed.error.message}`,
      ok: false,
      testFiles: [],
    };
  }
  if (listed.status !== 0) {
    return {
      message: `Unable to inspect the TypeScript program for ${projectPath}:\n${commandOutput(listed)}`,
      ok: false,
      testFiles: [],
    };
  }

  const testFiles = (listed.stdout ?? '')
    .split(/\r?\n/u)
    .map((file) => file.trim())
    .filter(Boolean)
    .map((file) => (path.isAbsolute(file) ? file : path.resolve(cwd, file)))
    .filter((file) => {
      const relative = path.relative(cwd, file);
      return (
        relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      );
    })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => TEST_FILE_PATTERN.test(file));
  if (testFiles.length < minTestFiles) {
    return {
      message: `${projectPath} selected ${testFiles.length} test files; expected at least ${minTestFiles}`,
      ok: false,
      testFiles,
    };
  }

  if (!checkTypes) {
    return {
      message: `${projectPath} selected ${testFiles.length} test files`,
      ok: true,
      testFiles,
    };
  }

  const checked = runTscCommand(['--noEmit', '--project', projectPath]);
  if (checked.error) {
    return {
      message: `Unable to run tsc for ${projectPath}: ${checked.error.message}`,
      ok: false,
      testFiles,
    };
  }
  if (checked.status !== 0) {
    return {
      message: `TypeScript rejected ${projectPath} after selecting ${testFiles.length} test files:\n${commandOutput(checked)}`,
      ok: false,
      testFiles,
    };
  }

  return {
    message: `${projectPath} selected and type-checked ${testFiles.length} test files`,
    ok: true,
    testFiles,
  };
}

function parseCliArgs(argv) {
  let minTestFiles;
  let project;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      project = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--min-test-files') {
      minTestFiles = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`verify-test-tsconfig-program: unsupported argument ${String(arg)}`);
  }

  return { minTestFiles, project };
}

export function main(options = {}) {
  const cliOptions = parseCliArgs(process.argv.slice(2));
  const result = verifyTestTsconfigProgram({
    cwd: options.repoRoot ?? process.cwd(),
    ...cliOptions,
  });
  if (!result.ok) {
    console.error(result.message);
    process.exitCode = 1;
    return;
  }
  console.log(result.message);
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main();
}
