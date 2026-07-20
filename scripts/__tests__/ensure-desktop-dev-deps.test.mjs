import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
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

test('delegates stale output detection to Turbo when dependency source is newer', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'brainstrike-dev-deps-'));
  const outputPath = path.join(repoRoot, 'packages/agent/dist/index.mjs');
  const sourcePath = path.join(repoRoot, 'packages/agent/src/index.ts');
  const invocations = [];

  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(outputPath, 'stale output');
    await writeFile(sourcePath, 'export const current = true;');
    const now = Date.now();
    await utimes(outputPath, new Date(now - 60_000), new Date(now - 60_000));
    await utimes(sourcePath, new Date(now), new Date(now));

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
