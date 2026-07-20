#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const desktopDevDependencyBuildArgs = [
  'turbo',
  'run',
  'build',
  '--filter=@brainstrike/build-utils',
  '--filter=@brainstrike/agent',
  '--filter=@brainstrike/ui',
];

export function getDesktopDevDependencyBuildArgs() {
  return [...desktopDevDependencyBuildArgs];
}

export function runDesktopDevDependencyBuild({
  repoRoot = path.resolve(import.meta.dirname, '..'),
  spawnSyncImpl = spawnSync,
} = {}) {
  const result = spawnSyncImpl('pnpm', getDesktopDevDependencyBuildArgs(), {
    cwd: repoRoot,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = runDesktopDevDependencyBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
