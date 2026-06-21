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
import {
  createGitService,
  GIT_MAX_OUTPUT_BYTES,
  type GitCommandRun,
  type GitCommandRunner,
  parsePorcelainV2,
} from '../../assistant-server/git-service';
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

  it('CONTAINMENT: when the opened root is a subdir, status omits sibling changes', async () => {
    // repo/  (worktree root)
    //   opened/   ← the workspace root the user opened
    //   sibling/  ← outside the opened root
    const repo = await makeRepo();
    await fsPromises.mkdir(path.join(repo, 'opened'), { recursive: true });
    await fsPromises.mkdir(path.join(repo, 'sibling'), { recursive: true });
    await writeFile(repo, 'opened/inside.txt', 'a\n');
    await writeFile(repo, 'sibling/outside.txt', 'b\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    // Dirty BOTH a file inside the opened root and a sibling outside it.
    await writeFile(repo, 'opened/inside.txt', 'a-changed\n');
    await writeFile(repo, 'sibling/outside.txt', 'b-changed\n');

    const result = await serviceFor(path.join(repo, 'opened')).status();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.isRepository).toBe(true);
    // Only the in-root change is reported; the sibling change (which git would
    // otherwise surface as "../sibling/outside.txt") is excluded.
    expect(result.value.files.map((f) => f.path)).toEqual(['inside.txt']);
    expect(result.value.files.some((f) => f.path.includes('..'))).toBe(false);
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

  it('OVERSIZED DIFF: a diff past the buffer is a bounded truncated SUCCESS, not a failure', async () => {
    const repo = await makeRepo();
    // Commit a large file, then rewrite EVERY line so the diff is ~2× the file.
    // The file is sized so the resulting diff exceeds GIT_MAX_BUFFER_BYTES (4×
    // the soft bound), forcing the execFile maxBuffer overflow path.
    const lineCount = 260_000;
    const original = `${Array.from({ length: lineCount }, (_, i) => `original-line-${i}`).join('\n')}\n`;
    await writeFile(repo, 'big.txt', original);
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    const rewritten = `${Array.from({ length: lineCount }, (_, i) => `changed-line-${i}`).join('\n')}\n`;
    await writeFile(repo, 'big.txt', rewritten);

    // Whole-tree diff (no path) — the contract is that it does not fail.
    const result = await serviceFor(repo).diff({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.truncated).toBe(true);
    // Bounded to ~the soft ceiling (boundOutput trims to GIT_MAX_OUTPUT_BYTES
    // plus a short marker), NOT the full multi-MB diff.
    expect(result.value.unifiedDiff.length).toBeLessThanOrEqual(GIT_MAX_OUTPUT_BYTES + 64);
    // It is still a real diff prefix, not an error dump.
    expect(result.value.unifiedDiff).toContain('diff --git');
  }, 30_000);

  it('maps an injected maxBuffer overflow to a truncated success (unit, no large repo)', async () => {
    // Drive the service with a fake runner that simulates the overflow: a partial
    // (oversized) stdout prefix + failureReason 'maxBuffer'. The service must
    // bound it and report truncated:true, ok:true.
    const oversized = `diff --git a/x b/x\n${'+'.repeat(GIT_MAX_OUTPUT_BYTES + 5000)}`;
    const overflowRunner: GitCommandRunner = () =>
      Promise.resolve({
        exitCode: null,
        stdout: oversized,
        stderr: '',
        timedOut: false,
        failureReason: 'maxBuffer',
      } satisfies GitCommandRun);
    const service = createGitService({ cwd: '/tmp/whatever', run: overflowRunner });
    const result = await service.diff({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.truncated).toBe(true);
    expect(result.value.unifiedDiff.length).toBeLessThanOrEqual(GIT_MAX_OUTPUT_BYTES + 64);
  });

  it('CONTAINMENT: rejects an absolute or ".."-escaping path without running git', async () => {
    let calls = 0;
    const spyRunner: GitCommandRunner = (params) => {
      calls += 1;
      return execFileGitRunner(params);
    };
    const service = createGitService({ cwd: '/tmp/whatever', run: spyRunner });

    const abs = await service.diff({ path: '/etc/passwd' });
    expect(abs.ok).toBe(false);
    if (!abs.ok) {
      expect(abs.error).toMatch(/relative to the opened folder/);
    }
    const escaping = await service.diff({ path: '../../sibling/file' });
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) {
      expect(escaping.error).toMatch(/escapes the opened folder/);
    }
    // Neither rejected path ever reached git.
    expect(calls).toBe(0);
  });

  it('UNTRACKED: shows whole-file additions via --no-index (not an empty diff)', async () => {
    const repo = await makeRepo();
    // A new, untracked file: a plain `git diff` reports nothing for it.
    await writeFile(repo, 'fresh.txt', 'alpha\nbeta\n');

    const plain = await serviceFor(repo).diff({ path: 'fresh.txt' });
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.value.unifiedDiff).toBe('');
    }

    const untracked = await serviceFor(repo).diff({ path: 'fresh.txt', untracked: true });
    expect(untracked.ok).toBe(true);
    if (untracked.ok) {
      // --no-index renders the file content as additions; exit 1 is success here.
      expect(untracked.value.unifiedDiff).toContain('+alpha');
      expect(untracked.value.unifiedDiff).toContain('+beta');
    }
  });

  it('UNTRACKED: REFUSES a path through a symlinked ANCESTOR directory (content escape)', async () => {
    const repo = await makeRepo();
    // A secret file OUTSIDE the opened folder.
    const outside = await makeNonRepoDir();
    await fsPromises.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUT-OF-ROOT', 'utf8');
    // A symlinked DIRECTORY inside the repo pointing at the outside folder.
    // `git diff --no-index -- /dev/null evil-dir/secret.txt` resolves THROUGH the
    // symlink and would render the out-of-root file's CONTENT (mode 100644).
    await fsPromises.symlink(outside, path.join(repo, 'evil-dir'));

    const result = await serviceFor(repo).diff({ path: 'evil-dir/secret.txt', untracked: true });

    // Refused with a containment error — the out-of-root content never reaches git.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/opened folder/i);
    }
  });

  it('UNTRACKED: ALLOWS a leaf symlink under a contained parent (git renders 120000 link text, not target content)', async () => {
    const repo = await makeRepo();
    // A secret file OUTSIDE the opened folder.
    const outside = await makeNonRepoDir();
    const secret = path.join(outside, 'secret.txt');
    await fsPromises.writeFile(secret, 'TOP-SECRET-OUT-OF-ROOT', 'utf8');
    // A leaf symlink directly in the repo. git renders this as a `120000`
    // addition whose body is the link TEXT — it never reads the target content —
    // so it is a legitimate untracked symlink the Git panel should be able to
    // review. The containment check must NOT dereference the leaf.
    await fsPromises.symlink(secret, path.join(repo, 'leaf-link'));

    const result = await serviceFor(repo).diff({ path: 'leaf-link', untracked: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The diff shows the symlink (mode 120000 / link text), NEVER the secret.
      expect(result.value.unifiedDiff).not.toContain('TOP-SECRET');
    }
  });
});

describe('git service — git not installed', () => {
  it('reports a clear "git is not installed" error for an ENOENT runner', async () => {
    const enoentRunner: GitCommandRunner = () =>
      Promise.resolve({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        failureReason: 'notFound',
      } satisfies GitCommandRun);
    const service = createGitService({ cwd: '/tmp/whatever', run: enoentRunner });
    const result = await service.status();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/git is not installed or not on PATH/);
    }
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

describe('git service — push', () => {
  it('sets the upstream on the first push of a branch with no upstream', async () => {
    const remote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-remote-'));
    const remoteReal = await fsPromises.realpath(remote);
    createdRoots.push(remoteReal);
    await execFileAsync('git', ['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    // origin exists but the branch has NO upstream yet → a bare `git push` would
    // fail; the service must fall back to `push -u origin HEAD`.
    await execFileAsync('git', ['remote', 'add', 'origin', remoteReal], { cwd: repo });

    const before = await serviceFor(repo).aheadBehind();
    expect(before.ok && before.value.hasUpstream).toBe(false);

    const pushed = await serviceFor(repo).push();
    expect(pushed.ok).toBe(true);

    // The upstream is now configured → ahead/behind resolves against it.
    const after = await serviceFor(repo).aheadBehind();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.hasUpstream).toBe(true);
      expect(after.value.upstream).toContain('origin/');
    }
  });

  it('pushes normally when an upstream already exists', async () => {
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

    // A second local commit, then push through the service with the upstream set.
    await writeFile(repo, 'b.txt', 'y\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'second'], { cwd: repo });

    const pushed = await serviceFor(repo).push();
    expect(pushed.ok).toBe(true);

    const after = await serviceFor(repo).aheadBehind();
    expect(after.ok && after.value.ahead).toBe(0);
  });
});
