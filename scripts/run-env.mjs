#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const separatorIndex = process.argv.indexOf('--');

if (separatorIndex === -1 || separatorIndex === process.argv.length - 1) {
  console.error('Usage: node scripts/run-env.mjs KEY=value [...] -- <command> [args...]');
  process.exit(1);
}

const env = { ...process.env };

for (const assignment of process.argv.slice(2, separatorIndex)) {
  const equalsIndex = assignment.indexOf('=');

  if (equalsIndex === -1) {
    console.error(`Invalid environment assignment: ${assignment}`);
    process.exit(1);
  }

  const key = assignment.slice(0, equalsIndex);
  const value = assignment.slice(equalsIndex + 1);

  if (value === '') {
    delete env[key];
  } else {
    env[key] = value;
  }
}

let [command, ...args] = process.argv.slice(separatorIndex + 1);

if (process.platform === 'win32' && command === 'xvfb-maybe') {
  [command, ...args] = args;
}

const result = spawnSync(command, args, {
  env,
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
