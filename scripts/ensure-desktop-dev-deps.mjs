#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const requiredOutputs = [
  'packages/build-utils/dist/index.mjs',
  'packages/agent/dist/index.mjs',
  'packages/ui/dist/index.d.ts',
];

if (requiredOutputs.every((outputPath) => existsSync(outputPath))) {
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
