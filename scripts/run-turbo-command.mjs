#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';

export function runTurboCommand(argv = process.argv, platform = process.platform) {
  const separatorIndex = argv.indexOf('--');

  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    console.error(
      'Usage: node scripts/run-turbo-command.mjs [--windows-concurrency=N] -- <turbo args...>'
    );
    return 1;
  }

  let windowsConcurrency;

  for (const option of argv.slice(2, separatorIndex)) {
    if (option.startsWith('--windows-concurrency=')) {
      windowsConcurrency = option.slice('--windows-concurrency='.length);
      continue;
    }

    console.error(`Unknown option: ${option}`);
    return 1;
  }

  const args = argv.slice(separatorIndex + 1);

  if (platform === 'win32' && windowsConcurrency) {
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

  const invocation = createSpawnInvocation('turbo', args, platform);
  const result = spawnSync(invocation.command, invocation.args, {
    shell: invocation.shell,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(runTurboCommand());
}
