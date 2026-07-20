import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getDesktopDevDependencyBuildArgs,
  runDesktopDevDependencyBuild,
} from '../ensure-desktop-dev-deps.mjs';

test('targets the exact desktop development dependency graph', () => {
  assert.deepEqual(getDesktopDevDependencyBuildArgs(), [
    'turbo',
    'run',
    'build',
    '--filter=@brainstrike/build-utils',
    '--filter=@brainstrike/agent',
    '--filter=@brainstrike/ui',
  ]);
});

test('invokes the Turbo graph build even when a dependency output exists', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'brainstrike-dev-deps-'));
  const outputPath = path.join(repoRoot, 'packages/agent/dist/index.mjs');
  const invocations = [];

  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, 'existing output');

    const exitCode = runDesktopDevDependencyBuild({
      repoRoot,
      spawnSyncImpl(command, args, options) {
        invocations.push({ args, command, options });
        return { status: 0 };
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(invocations, [
      {
        args: getDesktopDevDependencyBuildArgs(),
        command: 'pnpm',
        options: {
          cwd: repoRoot,
          shell: process.platform === 'win32',
          stdio: 'inherit',
        },
      },
    ]);
  } finally {
    await rm(repoRoot, { force: true, recursive: true });
  }
});
