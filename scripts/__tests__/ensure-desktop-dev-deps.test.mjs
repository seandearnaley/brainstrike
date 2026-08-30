import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getDesktopDevDependencyBuildArgs,
  runDesktopDevDependencyBuild,
} from '../ensure-desktop-dev-deps.mjs';

test('derives the desktop development dependency graph through the bounded turbo wrapper', () => {
  const args = getDesktopDevDependencyBuildArgs('linux');

  assert.deepEqual(args, [
    'scripts/run-turbo-command.mjs',
    '--skip-under-prepared-dev',
    '--',
    'run',
    'desktop-dev-dependencies',
    '--filter=@brainstrike/desktop',
  ]);
  assert.equal(
    args.some((argument) => argument.includes('^')),
    false
  );
});

test('serializes the desktop dependency graph on Windows so native MSVC links cannot overlap', () => {
  assert.deepEqual(getDesktopDevDependencyBuildArgs('win32'), [
    'scripts/run-turbo-command.mjs',
    '--skip-under-prepared-dev',
    '--windows-concurrency=1',
    '--',
    'run',
    'desktop-dev-dependencies',
    '--filter=@brainstrike/desktop',
  ]);
});

test('spawns the wrapper entrypoint that exists at the repository root', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const [wrapperPath] = getDesktopDevDependencyBuildArgs();

  assert.ok(existsSync(path.resolve(repoRoot, wrapperPath)));
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
        command: process.execPath,
        options: {
          cwd: repoRoot,
          stdio: 'inherit',
        },
      },
    ]);
  } finally {
    await rm(repoRoot, { force: true, recursive: true });
  }
});
