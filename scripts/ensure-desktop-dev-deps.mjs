#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The same helper serves two lifecycle boundaries. Root `predev` runs it before
// the outer Turbo watcher graph starts; desktop `predev` reaches it from inside
// that graph and must skip because root preparation already completed. Outside
// Turbo (standalone desktop dev), the helper still builds the complete desktop
// dependency graph through the bounded wrapper and shared nested-run lock.
const desktopDevDependencyBuildArgs = [
  'scripts/run-turbo-command.mjs',
  '--skip-under-prepared-dev',
  '--',
  'run',
  'desktop-dev-dependencies',
  '--filter=@brainstrike/desktop',
];

export function getDesktopDevDependencyBuildArgs(platform = process.platform) {
  const args = [...desktopDevDependencyBuildArgs];
  if (platform === 'win32') {
    const separatorIndex = args.indexOf('--');
    if (separatorIndex === -1) {
      throw new Error('Desktop dependency build arguments must contain the wrapper separator.');
    }
    args.splice(separatorIndex, 0, '--windows-concurrency=1');
  }
  return args;
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
