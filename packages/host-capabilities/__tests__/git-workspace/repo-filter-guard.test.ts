/**
 * BST-2454: a repository's own filter commands stay off in a folder the person
 * has not trusted, for the Changes listing, stage and revert, while filters
 * from their own config, and every filter in a trusted folder, still run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeHostWorkspaceTrust } from '@brainstrike/agent-host/workspace-trust';
import type { Changeset, ChangesetView } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import { createChangesetDiffService } from '../../src/git-workspace/changeset-diff-service.ts';
import { execFileGitRunner } from '../../src/git-workspace/git-methods.ts';
import type { GitCommandRunner } from '../../src/git-workspace/git-service.ts';
import {
  createTrustedFolderCheck,
  guardRepositoryFilters,
} from '../../src/git-workspace/repo-filter-guard.ts';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

function git(cwd: string, args: readonly string[], home: string): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home } }
  );
}

/** A filter command that leaves a mark in `.git` when git runs it. */
const marking = (mark: string) => `touch .git/${mark} && cat`;

/**
 * A committed repository whose `.gitattributes` sends `file.txt` through
 * `driver`, then that driver's clean command set in its own `.git/config`, and
 * `file.txt` edited so the unstaged view lists it.
 */
async function repoWithOwnFilter(home: string, driver = 'repo'): Promise<string> {
  const dir = await tempDir('bs-filter-guard-repo-');
  git(dir, ['init', '-q'], home);
  git(dir, ['config', 'core.autocrlf', 'false'], home);
  await writeFile(path.join(dir, '.gitattributes'), `file.txt filter=${driver}\n`);
  await writeFile(path.join(dir, 'file.txt'), 'one\n');
  git(dir, ['add', '-A'], home);
  git(dir, ['commit', '-q', '-m', 'base'], home);
  git(dir, ['config', `filter.${driver}.clean`, marking('repo-filter-ran')], home);
  git(dir, ['config', `filter.${driver}.smudge`, marking('repo-filter-ran')], home);
  git(dir, ['config', `filter.${driver}.required`, 'true'], home);
  await writeFile(path.join(dir, 'file.txt'), 'two, longer\n');
  return dir;
}

function settingsStore() {
  const settings = new Map<string, string>();
  return {
    deleteSetting: async (key: string) => settings.delete(key),
    getSetting: async (key: string) => settings.get(key),
    setSetting: async (key: string, value: string) => {
      settings.set(key, value);
    },
    // No folder here is a managed worktree, so each answers for itself.
    worktreeLedger: async () => ({ rows: [] }),
  };
}

/** The Changes service over `dir` as a mounted root, with git reading only `home`'s config. */
async function changesIn(dir: string, home: string, trust: 'trusted' | 'undecided') {
  const store = settingsStore();
  if (trust === 'trusted') {
    await writeHostWorkspaceTrust(store, dir, 'trusted');
  }
  const ownConfigOnly: GitCommandRunner = (params) =>
    execFileGitRunner({ ...params, env: { ...params.env, HOME: home, XDG_CONFIG_HOME: home } });
  const run = guardRepositoryFilters({
    isTrusted: createTrustedFolderCheck(store, {
      listRoots: async () => [{ displayName: 'repo', path: dir, rootId: 'root' }],
    }),
    run: ownConfigOnly,
  });
  const service = createChangesetDiffService({
    resolveRootCwd: async () => ({ ok: true, value: dir }) as const,
    run,
  });
  const unstaged: Changeset = {
    kind: 'git-scope',
    repositoryRoot: dir,
    scope: { kind: 'unstaged' },
    worktreePath: dir,
  };
  const view = async (): Promise<ChangesetView> => {
    const result = await service.resolveView('root', unstaged);
    if (!result.ok) {
      throw new Error(result.error.message);
    }
    return result.value;
  };
  const staged: Changeset = { ...unstaged, scope: { kind: 'staged' } };
  const apply = async (action: 'revert' | 'stage' | 'unstage') => {
    const changeset = action === 'unstage' ? staged : unstaged;
    const drawn = await service.resolveView('root', changeset);
    const file = drawn.ok
      ? drawn.value.files.find((entry) => entry.path === 'file.txt')
      : undefined;
    return await service.apply({
      action,
      changeset,
      rootId: 'root',
      target: { files: [{ path: 'file.txt', revision: file?.revision ?? '' }], kind: 'files' },
    });
  };
  return { apply, run, view };
}

const ran = (dir: string, mark: string) => existsSync(path.join(dir, '.git', mark));

describe('a repository filter in a folder the person has not trusted', () => {
  it('never runs while the Changes tab lists, stages or reverts the file', async () => {
    const home = await tempDir('bs-filter-guard-home-');
    const dir = await repoWithOwnFilter(home);
    const changes = await changesIn(dir, home, 'undecided');

    expect((await changes.view()).files.map((file) => file.path)).toContain('file.txt');
    expect((await changes.apply('stage')).ok).toBe(true);
    expect((await changes.apply('unstage')).ok).toBe(true);
    expect((await changes.apply('revert')).ok).toBe(true);

    expect(ran(dir, 'repo-filter-ran')).toBe(false);
  });

  it('stays off when its driver name holds "=", which a -c override would split', async () => {
    const home = await tempDir('bs-filter-guard-home-');
    const dir = await repoWithOwnFilter(home, 'a=b');
    const changes = await changesIn(dir, home, 'undecided');

    expect((await changes.view()).files.map((file) => file.path)).toContain('file.txt');
    expect(ran(dir, 'repo-filter-ran')).toBe(false);
  });

  it('fails the command, never runs it, when its driver name is not UTF-8', async () => {
    const home = await tempDir('bs-filter-guard-home-');
    const dir = await repoWithOwnFilter(home);
    // A driver name holding byte 0xFF, which no UTF-8 override can name.
    const driver = Buffer.from([0x62, 0x61, 0x64, 0xff]);
    await appendFile(
      path.join(dir, '.git', 'config'),
      Buffer.concat([
        Buffer.from('[filter "'),
        driver,
        Buffer.from(`"]\n\tclean = ${marking('bad-filter-ran')}\n\trequired = true\n`),
      ])
    );
    await writeFile(
      path.join(dir, '.gitattributes'),
      Buffer.concat([Buffer.from('file.txt filter='), driver, Buffer.from('\n')])
    );
    const changes = await changesIn(dir, home, 'undecided');

    await expect(changes.view()).rejects.toThrow();
    expect(ran(dir, 'bad-filter-ran')).toBe(false);
    expect(ran(dir, 'repo-filter-ran')).toBe(false);
  });

  it("leaves a filter from the person's own config running, as Git LFS is", async () => {
    const home = await tempDir('bs-filter-guard-home-');
    await writeFile(
      path.join(home, '.gitconfig'),
      `[filter "mine"]\n\tclean = ${marking('own-filter-ran')}\n\tsmudge = cat\n`
    );
    const dir = await tempDir('bs-filter-guard-repo-');
    git(dir, ['init', '-q'], home);
    await writeFile(path.join(dir, '.gitattributes'), 'file.txt filter=mine\n');
    await writeFile(path.join(dir, 'file.txt'), 'one\n');
    git(dir, ['add', '-A'], home);
    git(dir, ['commit', '-q', '-m', 'base'], home);
    await rm(path.join(dir, '.git', 'own-filter-ran'), { force: true });
    await writeFile(path.join(dir, 'file.txt'), 'two, longer\n');

    await (await changesIn(dir, home, 'undecided')).view();

    expect(ran(dir, 'own-filter-ran')).toBe(true);
  });
});

/** A filter command that leaves a mark in the repository's own working tree. */
const markingTree = 'touch nested-filter-ran && cat';

/**
 * A committed superproject holding one checked-out repository at `inner`,
 * added as a submodule or cloned in and staged as a bare gitlink, whose own
 * config sends `file.txt` through a filter that marks its tree, then
 * `inner/file.txt` edited without changing its size.
 */
async function superprojectWith(home: string, kind: 'embedded' | 'submodule'): Promise<string> {
  const source = await tempDir('bs-filter-guard-source-');
  git(source, ['init', '-q'], home);
  git(source, ['config', 'core.autocrlf', 'false'], home);
  await writeFile(path.join(source, '.gitattributes'), 'file.txt filter=nested\n');
  await writeFile(path.join(source, 'file.txt'), 'one\n');
  git(source, ['add', '-A'], home);
  git(source, ['commit', '-q', '-m', 'source'], home);

  const dir = await tempDir('bs-filter-guard-super-');
  git(dir, ['init', '-q'], home);
  await writeFile(path.join(dir, 'top.txt'), 'top\n');
  git(dir, ['add', '-A'], home);
  git(dir, ['commit', '-q', '-m', 'top'], home);
  if (kind === 'submodule') {
    git(dir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'inner'], home);
  } else {
    git(dir, ['clone', '-q', source, 'inner'], home);
    git(dir, ['add', 'inner'], home);
  }
  git(dir, ['commit', '-q', '-m', 'inner'], home);
  const inner = path.join(dir, 'inner');
  git(inner, ['config', 'filter.nested.clean', markingTree], home);
  git(inner, ['config', 'filter.nested.required', 'true'], home);
  // The same size, so git reads the file through the filter to tell.
  await writeFile(path.join(inner, 'file.txt'), 'two\n');
  return dir;
}

const nestedRan = (dir: string) => existsSync(path.join(dir, 'inner', 'nested-filter-ran'));

describe.each(['submodule', 'embedded'] as const)('a filter in a %s repository', (kind) => {
  it('stays off in a folder the person has not trusted', async () => {
    const home = await tempDir('bs-filter-guard-home-');
    const dir = await superprojectWith(home, kind);
    const changes = await changesIn(dir, home, 'undecided');

    await changes.view();
    for (const args of [
      ['status', '--porcelain=v2'],
      ['add', '--all'],
    ]) {
      expect((await changes.run({ args, cwd: dir, timeoutMs: 30_000 })).exitCode).toBe(0);
    }

    expect(nestedRan(dir)).toBe(false);
  });

  it('runs in a trusted folder', async () => {
    const home = await tempDir('bs-filter-guard-home-');
    const dir = await superprojectWith(home, kind);
    const changes = await changesIn(dir, home, 'trusted');

    await changes.run({ args: ['status', '--porcelain=v2'], cwd: dir, timeoutMs: 30_000 });

    expect(nestedRan(dir)).toBe(true);
  });
});

describe('a repository filter in a trusted folder', () => {
  it('runs as git runs it', async () => {
    const home = await tempDir('bs-filter-guard-home-');
    const dir = await repoWithOwnFilter(home);

    await (await changesIn(dir, home, 'trusted')).view();

    expect(ran(dir, 'repo-filter-ran')).toBe(true);
  });
});

describe('which folder decides', () => {
  it('lets a mounted folder kept restricted inside a trusted one stay restricted', async () => {
    const parent = await tempDir('bs-filter-guard-parent-');
    const restricted = path.join(parent, 'kept');
    const undecided = path.join(parent, 'open');
    await mkdir(restricted);
    await mkdir(undecided);
    const store = settingsStore();
    await writeHostWorkspaceTrust(store, parent, 'trusted');
    await writeHostWorkspaceTrust(store, restricted, 'restricted');
    const isTrusted = createTrustedFolderCheck(store, {
      listRoots: async () => [
        { displayName: 'parent', path: parent, rootId: 'parent' },
        { displayName: 'kept', path: restricted, rootId: 'kept' },
        { displayName: 'open', path: undecided, rootId: 'open' },
      ],
    });

    expect(await isTrusted(parent)).toBe(true);
    expect(await isTrusted(restricted)).toBe(false);
    expect(await isTrusted(undecided)).toBe(true);
  });
});
