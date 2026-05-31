#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSpawnInvocation } from './spawn-command.mjs';

export function runEnv(argv = process.argv, platform = process.platform) {
  const separatorIndex = argv.indexOf('--');

  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    console.error('Usage: node scripts/run-env.mjs KEY=value [...] -- <command> [args...]');
    return 1;
  }

  const env = { ...process.env };

  for (const assignment of argv.slice(2, separatorIndex)) {
    const equalsIndex = assignment.indexOf('=');

    if (equalsIndex === -1) {
      console.error(`Invalid environment assignment: ${assignment}`);
      return 1;
    }

    const key = assignment.slice(0, equalsIndex);
    const value = assignment.slice(equalsIndex + 1);

    if (value === '') {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  let [command, ...args] = argv.slice(separatorIndex + 1);

  if (platform === 'win32' && command === 'xvfb-maybe') {
    [command, ...args] = args;
  }

  const invocation = createSpawnInvocation(command, args, platform);
  const result = spawnSync(invocation.command, invocation.args, {
    env,
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
  process.exit(runEnv());
}
