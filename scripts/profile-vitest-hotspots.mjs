#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_HOTSPOT_PACKAGES = [
  '@brainstrike/file-explorer-ui',
  '@brainstrike/app-shell',
  '@brainstrike/desktop',
  '@brainstrike/db-explorer',
  '@brainstrike/web',
];

export function parseArgs(args = process.argv.slice(2)) {
  const packages = [];
  let coverage = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      continue;
    }
    if (arg === '--package') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--package requires a package name');
      }
      packages.push(value);
      index++;
      continue;
    }
    if (arg === '--no-coverage') {
      coverage = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    coverage,
    packages: packages.length > 0 ? packages : DEFAULT_HOTSPOT_PACKAGES,
  };
}

export function buildProfileCommand(packageName, options) {
  const scriptName = options.coverage ? 'test:coverage' : 'test';
  return [
    'pnpm',
    [
      '--filter',
      packageName,
      'run',
      scriptName,
      '--experimental.importDurations.print',
    ],
  ];
}

function runCommand(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    });

    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`Failed to spawn ${command}: ${error.message}`);
      resolve(1);
    });
  });
}

function createProfileEnv(options) {
  const env = {
    ...process.env,
    TURBO_TEST_MODE: options.coverage ? 'coverage-profile' : 'unit-profile',
  };

  if (options.coverage) {
    env.COVERAGE = 'true';
    env.DEBUG = 'vitest:coverage';
  }

  return env;
}

export async function runCli(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }

  const env = createProfileEnv(options);

  for (const packageName of options.packages) {
    const [command, commandArgs] = buildProfileCommand(packageName, options);
    console.log(`\n## Profiling ${packageName}`);
    console.log(`${command} ${commandArgs.join(' ')}`);
    const exitCode = await runCommand(command, commandArgs, env);
    if (exitCode !== 0) {
      return exitCode;
    }
  }

  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
