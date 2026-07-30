#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Nested turbo must go through run-turbo-command.mjs so it resolves the same
// cache directory as every other turbo invocation in the repo; a direct
// `pnpm turbo` resolves the repo-local .turbo cache and can execute the same
// task hash concurrently with the wrapper-routed nested builds under
// root `pnpm dev` (the rimraf-under-a-live-reader race from PR #2132).
const desktopDevDependencyBuildArgs = [
  'scripts/run-turbo-command.mjs',
  '--',
  'run',
  'desktop-dev-dependencies',
  '--filter=@brainstrike/desktop',
];

export function getDesktopDevDependencyBuildArgs() {
  return [...desktopDevDependencyBuildArgs];
}

export function runDesktopDevDependencyBuild({
  repoRoot = path.resolve(import.meta.dirname, '..'),
  spawnSyncImpl = spawnSync,
} = {}) {
  const result = spawnSyncImpl(process.execPath, getDesktopDevDependencyBuildArgs(), {
    cwd: repoRoot,
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
