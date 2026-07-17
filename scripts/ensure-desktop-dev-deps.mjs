#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const requiredOutputPaths = [
  'packages/build-utils/dist/index.mjs',
  'packages/agent/dist/index.mjs',
  'packages/ui/dist/index.d.ts',
];

export function getRequiredOutputPaths(repoRoot = path.resolve(import.meta.dirname, '..')) {
  return requiredOutputPaths.map((outputPath) => path.join(repoRoot, outputPath));
}

export function shouldBuildDesktopDevDeps(repoRoot = path.resolve(import.meta.dirname, '..')) {
  return !getRequiredOutputPaths(repoRoot).every((outputPath) => existsSync(outputPath));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!shouldBuildDesktopDevDeps()) {
    process.exit(0);
  }

  const result = spawnSync(
    'pnpm',
    [
      'turbo',
      'build',
      '--filter=@brainstrike/build-utils',
      '--filter=@brainstrike/agent',
      '--filter=@brainstrike/ui',
    ],
    {
      shell: process.platform === 'win32',
      stdio: 'inherit',
    }
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
