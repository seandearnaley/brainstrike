/**
 * Hermetic coverage for the desktop `git` IPC domain's pure service core.
 *
 * Every test runs against a REAL temp git repository (git init + a local user),
 * exercised through the production `execFile`-backed runner — there is no
 * network and no mocking of git itself. The injection test proves that shell
 * metacharacters in a commit message / path are inert (passed as execFile args,
 * never shell-interpreted): the repo is unharmed and the literal string is the
 * commit message.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitService, parsePorcelainV2 } from '../../assistant-server/git-service';
import { execFileGitRunner } from '../../git-ipc-handlers';

const execFileAsync = promisify(execFile);

const createdRoots: string[] = [];

async function makeRepo(prefix = 'brainstrike-git-unit-'): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  // realpath so the macOS /var → /private/var symlink does not trip containment.
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  await execFileAsync('git', ['init', '-q'], { cwd: real });
  await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: real });
  await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: real });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: real });
  return real;
}

async function makeNonRepoDir(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-norepo-'));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

async function writeFile(repo: string, name: string, content: string): Promise<void> {
  await fsPromises.writeFile(path.join(repo, name), content, 'utf8');
}

function serviceFor(cwd: string) {
  return createGitService({ cwd, run: execFileGitRunner });
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  }
});

describe('parsePorcelainV2', () => {
  it('parses the branch header + ahead/behind', () => {
    const parsed = parsePorcelainV2(
      [
        '# branch.oid abc123',
        '# branch.head feature/x',
        '# branch.upstream origin/feature/x',
        '# branch.ab +2 -3',
      ].join('\n')
    );
    expect(parsed.branch).toBe('feature/x');
    expect(parsed.upstream).toBe('origin/feature/x');
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(3);
    expect(parsed.clean).toBe(true);
  });

  it('parses staged, unstaged, untracked, and renamed entries', () => {
    const parsed = parsePorcelainV2(
      [
        '# branch.head main',
        '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 abc staged.txt',
        '1 .M N... 100644 100644 100644 abc def unstaged.txt',
        '2 R. N... 100644 100644 100644 aaa bbb R100 renamed.txt\toriginal.txt',
        '? untracked.txt',
      ].join('\n')
    );
    const byPath = new Map(parsed.files.map((f) => [f.path, f]));
    expect(byPath.get('staged.txt')).toMatchObject({ staged: true, unstaged: false, status: 'A' });
    expect(byPath.get('unstaged.txt')).toMatchObject({
      staged: false,
      unstaged: true,
      status: 'M',
    });
    expect(byPath.get('renamed.txt')).toMatchObject({
      staged: true,
      originalPath: 'original.txt',
      status: 'R',
    });
    expect(byPath.get('untracked.txt')).toMatchObject({ untracked: true, status: '?' });
    expect(parsed.clean).toBe(false);
  });

  it('treats a missing branch.ab as null ahead/behind (no upstream)', () => {
    const parsed = parsePorcelainV2(['# branch.head main'].join('\n'));
    expect(parsed.ahead).toBeNull();
    expect(parsed.behind).toBeNull();
    expect(parsed.upstream).toBeNull();
  });
});

describe('git service — status', () => {
  it('reports a clean repo after an initial commit', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'hello\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

    const result = await serviceFor(repo).status();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.isRepository).toBe(true);
    expect(result.value.clean).toBe(true);
    expect(result.value.files).toHaveLength(0);
    expect(result.value.branch).toBeTruthy();
  });

  it('classifies staged, unstaged, and untracked changes', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'tracked.txt', 'v1\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

    // unstaged modification to the tracked file
    await writeFile(repo, 'tracked.txt', 'v2\n');
    // staged new file
    await writeFile(repo, 'staged.txt', 's\n');
    await execFileAsync('git', ['add', 'staged.txt'], { cwd: repo });
    // untracked file
    await writeFile(repo, 'untracked.txt', 'u\n');

    const result = await serviceFor(repo).status();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const byPath = new Map(result.value.files.map((f) => [f.path, f]));
    expect(byPath.get('tracked.txt')).toMatchObject({ unstaged: true });
    expect(byPath.get('staged.txt')).toMatchObject({ staged: true });
    expect(byPath.get('untracked.txt')).toMatchObject({ untracked: true });
    expect(result.value.clean).toBe(false);
  });

  it('returns a clean non-repository status (not an error) for a non-git dir', async () => {
    const dir = await makeNonRepoDir();
    const result = await serviceFor(dir).status();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.isRepository).toBe(false);
    expect(result.value.clean).toBe(true);
    expect(result.value.files).toHaveLength(0);
  });
});

describe('git service — diff', () => {
  it('returns the unified diff for a modified file', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'file.txt', 'line1\nline2\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'file.txt', 'line1\nCHANGED\n');

    const result = await serviceFor(repo).diff({ path: 'file.txt' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.path).toBe('file.txt');
    expect(result.value.staged).toBe(false);
    expect(result.value.unifiedDiff).toContain('-line2');
    expect(result.value.unifiedDiff).toContain('+CHANGED');
  });

  it('returns the staged (--cached) diff', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'file.txt', 'base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'file.txt', 'staged-change\n');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: repo });

    const result = await serviceFor(repo).diff({ path: 'file.txt', staged: true });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.staged).toBe(true);
    expect(result.value.unifiedDiff).toContain('+staged-change');
  });
});

describe('git service — stage / unstage round-trip', () => {
  it('stages then unstages a path', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'init.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'new.txt', 'n\n');

    const service = serviceFor(repo);
    const staged = await service.stage({ path: 'new.txt' });
    expect(staged.ok).toBe(true);
    let status = await service.status();
    expect(status.ok && status.value.files.find((f) => f.path === 'new.txt')?.staged).toBe(true);

    const unstaged = await service.unstage({ path: 'new.txt' });
    expect(unstaged.ok).toBe(true);
    status = await service.status();
    // After unstage the path is untracked again (no longer staged).
    expect(status.ok && status.value.files.find((f) => f.path === 'new.txt')?.staged).toBe(false);
  });
});

describe('git service — commit', () => {
  it('commits staged changes and returns the short hash + branch', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'committed.txt', 'data\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });

    const result = await serviceFor(repo).commit({ message: 'a normal message with spaces' });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.commit).toMatch(/^[0-9a-f]{7,}$/);
    const log = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: repo });
    expect(log.stdout.trim()).toBe('a normal message with spaces');
  });

  it('returns a structured error (not a throw) when nothing is staged', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'init.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

    const result = await serviceFor(repo).commit({ message: 'nothing to commit' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/nothing to commit|no changes added/i);
  });

  it('rejects an empty commit message without invoking git', async () => {
    const repo = await makeRepo();
    const result = await serviceFor(repo).commit({ message: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/non-empty/);
  });

  it('SECURITY: shell metacharacters in a commit message are inert (no injection)', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'safe.txt', 'safe\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });

    // If this string were ever passed through a shell, `rm -rf` would delete the
    // file (and `$(...)` / backticks would execute). With execFile args it is the
    // literal commit subject and the file survives.
    const evil = 'subject; rm -rf safe.txt; $(touch HACKED) `touch ALSO_HACKED`';
    const result = await serviceFor(repo).commit({ message: evil });
    expect(result.ok).toBe(true);

    // The repo is unharmed: the "deleted" file still exists, and no injected
    // side-effect file was created.
    await expect(fsPromises.access(path.join(repo, 'safe.txt'))).resolves.toBeUndefined();
    await expect(fsPromises.access(path.join(repo, 'HACKED'))).rejects.toThrow();
    await expect(fsPromises.access(path.join(repo, 'ALSO_HACKED'))).rejects.toThrow();

    // The literal string is the commit subject.
    const log = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: repo });
    expect(log.stdout.trim()).toBe(evil);
  });

  it('SECURITY: a path containing metacharacters is treated as a literal path', async () => {
    const repo = await makeRepo();
    // A filename that, under a shell, would look like an injection.
    const weirdName = 'weird;name.txt';
    await writeFile(repo, weirdName, 'x\n');

    const service = serviceFor(repo);
    const staged = await service.stage({ path: weirdName });
    expect(staged.ok).toBe(true);
    // No SENTINEL file was created by an injected command, and the literal file
    // is now staged.
    await expect(fsPromises.access(path.join(repo, 'SENTINEL'))).rejects.toThrow();
    const status = await service.status();
    expect(status.ok && status.value.files.some((f) => f.path.includes('weird;name.txt'))).toBe(
      true
    );
  });
});

describe('git service — aheadBehind', () => {
  it('reports no upstream cleanly when none is configured', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

    const result = await serviceFor(repo).aheadBehind();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.hasUpstream).toBe(false);
    expect(result.value.ahead).toBeNull();
    expect(result.value.behind).toBeNull();
    expect(result.value.upstream).toBeNull();
  });

  it('computes ahead/behind against a local "remote" upstream', async () => {
    // A bare repo acts as the remote; clone, commit locally → ahead by 1.
    const remote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-remote-'));
    const remoteReal = await fsPromises.realpath(remote);
    createdRoots.push(remoteReal);
    await execFileAsync('git', ['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteReal], { cwd: repo });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: repo });

    // Now make a local commit that is NOT pushed → ahead by 1.
    await writeFile(repo, 'b.txt', 'y\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'second'], { cwd: repo });

    const result = await serviceFor(repo).aheadBehind();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.hasUpstream).toBe(true);
    expect(result.value.ahead).toBe(1);
    expect(result.value.behind).toBe(0);
    expect(result.value.upstream).toContain('origin/');
  });
});
