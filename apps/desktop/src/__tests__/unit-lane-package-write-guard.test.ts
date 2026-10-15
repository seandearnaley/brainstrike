import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestProject } from 'vitest/node';
import setupPackageWriteGuard, {
  newUntrackedFiles,
  repositoryDiscoveryEnvironment,
} from './helpers/unit-lane-package-write-guard';

function projectAt(root: string, watch = false): TestProject {
  return { config: { dir: root, root, watch } } as unknown as TestProject;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], { cwd, env: repositoryDiscoveryEnvironment(), stdio: 'ignore' });
}

describe('unit-lane package write guard bookkeeping (BST-546)', () => {
  it('reports only files that appeared during the run', () => {
    expect(newUntrackedFiles(['already.txt'], ['already.txt', 'stray.json'])).toEqual([
      'stray.json',
    ]);
  });

  it('stays out of watch mode, where the developer edits the tree', () => {
    expect(setupPackageWriteGuard(projectAt('/unused', true))).toBeUndefined();
  });
});

describe('unit-lane package write guard against a real repository (BST-546)', () => {
  let repository: string;

  beforeEach(async () => {
    repository = await mkdtemp(path.join(os.tmpdir(), 'desktop-write-guard-'));
    git(repository, ['init', '--quiet']);
    await writeFile(path.join(repository, 'tracked.txt'), 'original\n');
    await writeFile(path.join(repository, '.gitignore'), 'ignored/\n');
    git(repository, ['add', '-A']);
    git(repository, [
      '-c',
      'user.email=test@brainstrike.dev',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'init',
    ]);
  });

  afterEach(async () => {
    await rm(repository, { force: true, recursive: true });
  });

  it('fails the run naming a file a test left in the package', async () => {
    const teardown = setupPackageWriteGuard(projectAt(repository));
    await mkdir(path.join(repository, 'nested'));
    await writeFile(path.join(repository, 'nested', 'stray-fixture.json'), '{}');

    expect(teardown).toBeTypeOf('function');
    expect(() => teardown?.()).toThrow(
      /1 new untracked file\(s\)[\s\S]*nested\/stray-fixture\.json/
    );
  });

  it('passes for files that predate the run, ignored output and edits or staging of tracked files', async () => {
    await writeFile(path.join(repository, 'already-untracked.txt'), 'before the run');
    const teardown = setupPackageWriteGuard(projectAt(repository));
    await mkdir(path.join(repository, 'ignored'));
    await writeFile(path.join(repository, 'ignored', 'cache.json'), '{}');
    await writeFile(path.join(repository, 'already-untracked.txt'), 'rewritten during the run');
    await writeFile(path.join(repository, 'tracked.txt'), 'edited during the run\n');
    git(repository, ['add', 'tracked.txt']);

    expect(teardown).toBeTypeOf('function');
    expect(() => teardown?.()).not.toThrow();
  });
});
