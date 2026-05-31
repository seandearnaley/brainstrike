#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const separatorIndex = process.argv.indexOf('--');

if (separatorIndex === -1 || separatorIndex === process.argv.length - 1) {
  console.error(
    'Usage: node scripts/run-turbo-command.mjs [--windows-concurrency=N] -- <turbo args...>'
  );
  process.exit(1);
}

let windowsConcurrency;

for (const option of process.argv.slice(2, separatorIndex)) {
  if (option.startsWith('--windows-concurrency=')) {
    windowsConcurrency = option.slice('--windows-concurrency='.length);
    continue;
  }

  console.error(`Unknown option: ${option}`);
  process.exit(1);
}

const args = process.argv.slice(separatorIndex + 1);

if (process.platform === 'win32' && windowsConcurrency) {
  const concurrencyIndex = args.findIndex(
    (arg) => arg === '--concurrency' || arg.startsWith('--concurrency=')
  );

  if (concurrencyIndex === -1) {
    args.push(`--concurrency=${windowsConcurrency}`);
  } else if (args[concurrencyIndex] === '--concurrency') {
    args.splice(concurrencyIndex, 2, '--concurrency', windowsConcurrency);
  } else {
    args[concurrencyIndex] = `--concurrency=${windowsConcurrency}`;
  }
}

const result = spawnSync('turbo', args, {
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
