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
  type GitDiffParams,
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
      await fsPromises.rm(root, { force: true, recursive: true });
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
    expect(byPath.get('staged.txt')).toMatchObject({ staged: true, status: 'A', unstaged: false });
    expect(byPath.get('unstaged.txt')).toMatchObject({
      staged: false,
      status: 'M',
      unstaged: true,
    });
    expect(byPath.get('renamed.txt')).toMatchObject({
      originalPath: 'original.txt',
      staged: true,
      status: 'R',
    });
    expect(byPath.get('untracked.txt')).toMatchObject({ status: '?', untracked: true });
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
  it.skipIf(process.platform === 'win32')(
    'SECURITY: status does not execute a configured filesystem monitor',
    async () => {
      const repo = await makeRepo();
      const marker = path.join(repo, 'FSMONITOR_EXECUTED');
      const fsmonitor = path.join(repo, 'fsmonitor.sh');
      await fsPromises.writeFile(fsmonitor, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
      await execFileAsync('git', ['config', 'core.fsmonitor', fsmonitor], { cwd: repo });

      expect((await serviceFor(repo).status()).ok).toBe(true);
      await expect(fsPromises.access(marker)).rejects.toThrow();
    }
  );

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

  it('enumerates nested untracked files individually so each diff is inspectable', async () => {
    const repo = await makeRepo('brainstrike-git-untracked-tree-');
    await fsPromises.mkdir(path.join(repo, 'nested', 'deep'), { recursive: true });
    await writeFile(repo, 'nested/deep/new-file.txt', 'nested content\n');

    const service = serviceFor(repo);
    const status = await service.status();

    expect(status.ok).toBe(true);
    if (!status.ok) {
      return;
    }
    expect(status.value.files).toContainEqual(
      expect.objectContaining({ path: 'nested/deep/new-file.txt', untracked: true })
    );
    expect(status.value.files.some((file) => file.path === 'nested/')).toBe(false);

    const diff = await service.diff({ mode: 'untracked', path: 'nested/deep/new-file.txt' });
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.value.unifiedDiff).toContain('+nested content');
    }
  });

  it('preserves whitespace in the opened-subfolder prefix returned by Git', async () => {
    const repo = await makeRepo('brainstrike-git-prefix-space-');
    const scopedFolder = '  scoped folder  ';
    await fsPromises.mkdir(path.join(repo, scopedFolder));
    await writeFile(repo, `${scopedFolder}/inside.txt`, 'inside\n');

    const status = await serviceFor(path.join(repo, scopedFolder)).status();

    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.files).toEqual([
        expect.objectContaining({ path: 'inside.txt', untracked: true }),
      ]);
    }
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

  it('preserves tabs and newlines in status paths via NUL-delimited porcelain', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'initial.txt', 'initial\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    const unusualPath = 'line\nbreak\tname.txt';
    await writeFile(repo, unusualPath, 'unusual\n');

    const result = await serviceFor(repo).status();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.files).toEqual([
        expect.objectContaining({ path: unusualPath, untracked: true }),
      ]);
    }
  });
});

describe('git service — diff', () => {
  it.skipIf(process.platform === 'win32')(
    'SECURITY: working diff does not execute configured index hooks while refreshing stat data',
    async () => {
      const repo = await makeRepo();
      const file = path.join(repo, 'tracked.txt');
      const fsmonitorMarker = path.join(repo, 'FSMONITOR_EXECUTED');
      const fsmonitor = path.join(repo, 'fsmonitor.sh');
      await writeFile(repo, 'tracked.txt', 'base\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: repo });
      const marker = path.join(repo, 'DIFF_HOOK_EXECUTED');
      await execFileAsync('git', ['config', 'hook.sentinel-diff.command', `touch "${marker}"`], {
        cwd: repo,
      });
      await execFileAsync(
        'git',
        ['config', '--add', 'hook.sentinel-diff.event', 'post-index-change'],
        { cwd: repo }
      );
      await fsPromises.writeFile(fsmonitor, `#!/bin/sh\ntouch "${fsmonitorMarker}"\n`, {
        mode: 0o755,
      });
      await execFileAsync('git', ['config', 'core.fsmonitor', fsmonitor], { cwd: repo });
      const stat = await fsPromises.stat(file);
      await fsPromises.utimes(file, stat.atime, new Date(stat.mtimeMs + 2000));

      expect((await serviceFor(repo).diff({ mode: 'working' })).ok).toBe(true);
      await expect(fsPromises.access(marker)).rejects.toThrow();
      await expect(fsPromises.access(fsmonitorMarker)).rejects.toThrow();
    }
  );

  it('rejects contradictory and incomplete diff modes instead of guessing', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'file.txt', 'content\n');

    const contradictory = await serviceFor(repo).diff({
      path: 'file.txt',
      staged: true,
      untracked: true,
    } as unknown as GitDiffParams);
    expect(contradictory).toEqual({
      error: expect.stringMatching(/diff mode/i),
      ok: false,
    });

    const untrackedWithoutPath = await serviceFor(repo).diff({
      mode: 'untracked',
    } as unknown as GitDiffParams);
    expect(untrackedWithoutPath).toEqual({
      error: expect.stringMatching(/untracked diff.*path/i),
      ok: false,
    });
  });

  it('returns the unified diff for a modified file', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'file.txt', 'line1\nline2\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'file.txt', 'line1\nCHANGED\n');

    const result = await serviceFor(repo).diff({ mode: 'working', path: 'file.txt' });
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

    const result = await serviceFor(repo).diff({ mode: 'staged', path: 'file.txt' });
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
    const result = await serviceFor(repo).diff({ mode: 'working' });
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
        failureReason: 'maxBuffer',
        stderr: '',
        stdout: oversized,
        timedOut: false,
      } satisfies GitCommandRun);
    const service = createGitService({ cwd: '/tmp/whatever', run: overflowRunner });
    const result = await service.diff({ mode: 'working' });
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

    const abs = await service.diff({ mode: 'working', path: '/etc/passwd' });
    expect(abs.ok).toBe(false);
    if (!abs.ok) {
      expect(abs.error).toMatch(/relative to the opened folder/);
    }
    const escaping = await service.diff({ mode: 'working', path: '../../sibling/file' });
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) {
      expect(escaping.error).toMatch(/escapes the opened folder/);
    }
    // Neither rejected path ever reached git.
    expect(calls).toBe(0);
  });

  it('CONTAINMENT: treats pathspec magic as a literal working-tree path', async () => {
    const repo = await makeRepo('brainstrike-git-literal-diff-');
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'opened/inside.txt', 'inside\n');
    await writeFile(repo, 'sibling/outside.txt', 'secret-before\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    await writeFile(repo, 'sibling/outside.txt', 'secret-after\n');

    const result = await serviceFor(path.join(repo, 'opened')).diff({
      mode: 'working',
      path: ':(top)sibling/outside.txt',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unifiedDiff).toBe('');
    }
  });

  it('UNTRACKED: shows whole-file additions via --no-index (not an empty diff)', async () => {
    const repo = await makeRepo();
    // A new, untracked file: a plain `git diff` reports nothing for it.
    await writeFile(repo, 'fresh.txt', 'alpha\nbeta\n');

    const plain = await serviceFor(repo).diff({ mode: 'working', path: 'fresh.txt' });
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.value.unifiedDiff).toBe('');
    }

    const untracked = await serviceFor(repo).diff({ mode: 'untracked', path: 'fresh.txt' });
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

    const result = await serviceFor(repo).diff({
      mode: 'untracked',
      path: 'evil-dir/secret.txt',
    });

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

    const result = await serviceFor(repo).diff({ mode: 'untracked', path: 'leaf-link' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The diff shows the symlink (mode 120000 / link text), NEVER the secret.
      expect(result.value.unifiedDiff).not.toContain('TOP-SECRET');
    }
  });

  it('UNTRACKED: surfaces a leaf symlink-to-directory diff failure instead of returning empty', async () => {
    const repo = await makeRepo();
    // A leaf symlink whose target is a DIRECTORY (vs the file case above, which
    // renders a 120000 link-text addition). git lstat's the leaf, so
    // `--no-index -- /dev/null dir-link` errors ("Could not access
    // 'dir-link/null'") and produces no stdout. Containment allows the leaf
    // (its parent is contained), but the Git failure must remain visible rather
    // than being mislabeled as a successful empty diff.
    const outside = await makeNonRepoDir();
    await fsPromises.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUT-OF-ROOT', 'utf8');
    await fsPromises.symlink(outside, path.join(repo, 'dir-link'));

    const result = await serviceFor(repo).diff({ mode: 'untracked', path: 'dir-link' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/could not access|no diff/i);
      expect(result.error).not.toContain('TOP-SECRET');
    }
  });
});

describe('git service — git not installed', () => {
  it('reports a clear "git is not installed" error for an ENOENT runner', async () => {
    const enoentRunner: GitCommandRunner = () =>
      Promise.resolve({
        exitCode: null,
        failureReason: 'notFound',
        stderr: '',
        stdout: '',
        timedOut: false,
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
  it('CONTAINMENT: treats pathspec magic literally when staging and unstaging', async () => {
    const repo = await makeRepo('brainstrike-git-literal-index-');
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'opened/inside.txt', 'inside\n');
    await writeFile(repo, 'sibling/outside.txt', 'before\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    await writeFile(repo, 'sibling/outside.txt', 'after\n');
    const service = serviceFor(path.join(repo, 'opened'));
    const magicPath = ':(top)sibling/outside.txt';

    const staged = await service.stage({ path: magicPath });
    expect(staged.ok).toBe(false);
    expect(
      (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repo })).stdout
    ).toBe('');

    await execFileAsync('git', ['add', 'sibling/outside.txt'], { cwd: repo });
    const unstaged = await service.unstage({ path: magicPath });
    expect(unstaged.ok).toBe(false);
    expect(
      (await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: repo })).stdout
    ).toBe('sibling/outside.txt\n');
  });

  it('stages and unstages an exact all-whitespace path without widening to the opened root', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'base.txt', 'base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: repo });
    await writeFile(repo, '   ', 'spaces\n');
    await writeFile(repo, 'other.txt', 'other\n');
    const service = serviceFor(repo);

    const staged = await service.stage({ path: '   ' });

    expect(staged.ok).toBe(true);
    expect(
      (await execFileAsync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: repo })).stdout
    ).toBe('   \0');

    await execFileAsync('git', ['add', '.'], { cwd: repo });
    const unstaged = await service.unstage({ path: '   ' });

    expect(unstaged.ok).toBe(true);
    expect(
      (await execFileAsync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: repo })).stdout
    ).toBe('other.txt\0');
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a literal backslash in a POSIX filename',
    async () => {
      const repo = await makeRepo();
      await writeFile(repo, 'literal\\name.txt', 'backslash\n');
      await writeFile(repo, 'other.txt', 'other\n');

      const result = await serviceFor(repo).stage({ path: 'literal\\name.txt' });

      expect(result.ok).toBe(true);
      expect(
        (await execFileAsync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: repo }))
          .stdout
      ).toBe('literal\\name.txt\0');
    }
  );

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

  it.skipIf(process.platform === 'win32')(
    'SECURITY: stage and unstage do not execute configured index hooks',
    async () => {
      const repo = await makeRepo();
      await writeFile(repo, 'tracked.txt', 'base\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: repo });
      const marker = path.join(repo, 'INDEX_HOOK_EXECUTED');
      await execFileAsync('git', ['config', 'hook.sentinel-index.command', `touch "${marker}"`], {
        cwd: repo,
      });
      await execFileAsync(
        'git',
        ['config', '--add', 'hook.sentinel-index.event', 'post-index-change'],
        {
          cwd: repo,
        }
      );
      await writeFile(repo, 'tracked.txt', 'changed\n');
      const service = serviceFor(repo);

      expect((await service.stage({ path: 'tracked.txt' })).ok).toBe(true);
      await expect(fsPromises.access(marker)).rejects.toThrow();
      expect((await service.unstage({ path: 'tracked.txt' })).ok).toBe(true);
      await expect(fsPromises.access(marker)).rejects.toThrow();
    }
  );
});

describe('git service — commit', () => {
  it('commits staged changes and returns the short hash + branch', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'committed.txt', 'data\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });

    const result = await serviceFor(repo).commit({
      description: 'A detailed body.\n\nWith a second paragraph.',
      summary: 'a normal message with spaces',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.commit).toMatch(/^[0-9a-f]{7,}$/);
    const log = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: repo });
    expect(log.stdout.trim()).toBe('a normal message with spaces');
    const body = await execFileAsync('git', ['log', '-1', '--pretty=%b'], { cwd: repo });
    expect(body.stdout.trim()).toBe('A detailed body.\n\nWith a second paragraph.');
  });

  it.skipIf(process.platform === 'win32')(
    'SECURITY: commits do not execute repository-controlled hooks',
    async () => {
      const repo = await makeRepo();
      const hooks = path.join(repo, '.git', 'hooks');
      const preCommitMarker = path.join(repo, 'PRE_COMMIT_EXECUTED');
      const postCommitMarker = path.join(repo, 'POST_COMMIT_EXECUTED');
      const configuredHookMarker = path.join(repo, 'CONFIGURED_HOOK_EXECUTED');
      await fsPromises.writeFile(
        path.join(hooks, 'pre-commit'),
        `#!/bin/sh\ntouch "${preCommitMarker}"\n`,
        { mode: 0o755 }
      );
      await fsPromises.writeFile(
        path.join(hooks, 'post-commit'),
        `#!/bin/sh\ntouch "${postCommitMarker}"\n`,
        { mode: 0o755 }
      );
      await execFileAsync(
        'git',
        ['config', '--local', 'hook.sentinel.command', `touch "${configuredHookMarker}"`],
        { cwd: repo }
      );
      await execFileAsync(
        'git',
        ['config', '--local', '--add', 'hook.sentinel.event', 'pre-commit'],
        { cwd: repo }
      );
      await writeFile(repo, 'safe.txt', 'safe\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });

      const result = await serviceFor(repo).commit({ summary: 'safe commit' });

      expect(result.ok).toBe(true);
      await expect(fsPromises.access(preCommitMarker)).rejects.toThrow();
      await expect(fsPromises.access(postCommitMarker)).rejects.toThrow();
      await expect(fsPromises.access(configuredHookMarker)).rejects.toThrow();
    }
  );

  it('returns a structured error (not a throw) when nothing is staged', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'init.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });

    const result = await serviceFor(repo).commit({ summary: 'nothing to commit' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/nothing to commit|no changes added/i);
  });

  it('rejects an empty commit message without invoking git', async () => {
    const repo = await makeRepo();
    const result = await serviceFor(repo).commit({ summary: '   ' });
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
    const result = await serviceFor(repo).commit({ summary: evil });
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

  it('REFUSES to commit staged paths outside an opened subdirectory root', async () => {
    const repo = await makeRepo();
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'opened/inside.txt', 'inside\n');
    await writeFile(repo, 'sibling/outside.txt', 'outside\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });

    const result = await serviceFor(path.join(repo, 'opened')).commit({
      description: '',
      summary: 'must stay scoped',
    });

    expect(result).toEqual({
      error: expect.stringMatching(/outside the opened folder/i),
      ok: false,
    });
    await expect(
      execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo })
    ).rejects.toThrow();
  });

  it('REFUSES a staged rename that crosses into an opened subdirectory root', async () => {
    const repo = await makeRepo();
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'sibling/outside.txt', 'outside\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    await execFileAsync('git', ['mv', 'sibling/outside.txt', 'opened/moved.txt'], { cwd: repo });

    const result = await serviceFor(path.join(repo, 'opened')).commit({
      summary: 'must not move a sibling through a scoped commit',
    });

    expect(result).toEqual({
      error: expect.stringMatching(/outside the opened folder/i),
      ok: false,
    });
    expect(
      (await execFileAsync('git', ['status', '--short'], { cwd: repo })).stdout.trim()
    ).toContain('sibling/outside.txt -> opened/moved.txt');
  });
});

describe('git service — repository browser', () => {
  it('surfaces the Git 2.36 minimum required for NUL-safe worktree inventory', async () => {
    const repo = await makeRepo('brainstrike-git-old-version-');
    const oldGitRunner: GitCommandRunner = (params) => {
      if (params.args[0] === 'version') {
        return Promise.resolve({
          exitCode: 0,
          stderr: '',
          stdout: 'git version 2.35.8\n',
          timedOut: false,
        });
      }
      return execFileGitRunner(params);
    };

    const result = await createGitService({ cwd: repo, run: oldGitRunner }).repository();

    expect(result).toEqual({
      error: 'Git 2.36 or newer is required for repository and worktree browsing; found 2.35.8',
      ok: false,
    });
  });

  it('preserves trailing whitespace in the worktree root returned by Git', async () => {
    const parent = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'brainstrike-git-space-parent-')
    );
    const parentReal = await fsPromises.realpath(parent);
    createdRoots.push(parentReal);
    const repo = path.join(parentReal, 'repository ');
    await fsPromises.mkdir(repo);
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: repo });

    const result = await serviceFor(repo).repository();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repositoryRoot).toBe(repo);
      expect(result.value.openedRoot).toBe(repo);
    }
  });

  it('returns repository, linked-worktree, branch, and remote identity', async () => {
    const repo = await makeRepo('brainstrike-git-repository-');
    await writeFile(repo, 'README.md', '# repository\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });

    const linked = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-worktree-'));
    const linkedReal = await fsPromises.realpath(linked);
    createdRoots.push(linkedReal);
    await execFileAsync('git', ['worktree', 'add', '-q', '-b', 'feature/worktree', linkedReal], {
      cwd: repo,
    });

    const invokedArgs: string[][] = [];
    const recordingRunner: GitCommandRunner = (params) => {
      invokedArgs.push([...params.args]);
      return execFileGitRunner(params);
    };
    const result = await createGitService({ cwd: repo, run: recordingRunner }).repository();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.name).toBe(path.basename(repo));
    expect(result.value.repositoryRoot).toBe(repo);
    expect(result.value.currentWorktree.path).toBe(repo);
    expect(result.value.currentWorktree.current).toBe(true);
    expect(result.value.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch: 'feature/worktree', path: linkedReal }),
      ])
    );
    expect(result.value.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'feature/worktree', worktreePath: linkedReal }),
      ])
    );
    expect(result.value.remotes).toEqual([]);
    expect(result.value.defaultRemote).toBeNull();
    expect(invokedArgs.flat().some((arg) => arg.includes('%(worktreepath)'))).toBe(false);
  });

  it('paginates NUL-safe commit history with full metadata', async () => {
    const repo = await makeRepo('brainstrike-git-history-');
    await writeFile(repo, 'first.txt', 'first\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'first commit'], { cwd: repo });
    await writeFile(repo, 'second.txt', 'second\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-q', '-m', 'second commit', '-m', 'Detailed body.'], {
      cwd: repo,
    });

    const firstPage = await serviceFor(repo).history({ limit: 1, offset: 0 });

    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) {
      return;
    }
    expect(firstPage.value.hasMore).toBe(true);
    expect(firstPage.value.commits).toHaveLength(1);
    expect(firstPage.value.commits[0]).toMatchObject({
      authorEmail: 'test@brainstrike.dev',
      authorName: 'Brainstrike Test',
      body: 'Detailed body.',
      summary: 'second commit',
    });
    expect(firstPage.value.commits[0]?.id).toMatch(/^[0-9a-f]{40,64}$/);
    expect(firstPage.value.commits[0]?.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('ignores an inherited graft file that would rewrite repository history', async () => {
    const repo = await makeRepo('brainstrike-git-graft-env-');
    await writeFile(repo, 'first.txt', 'first\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'first'], { cwd: repo });
    await writeFile(repo, 'second.txt', 'second\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'second'], { cwd: repo });
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.replace(
      /\r?\n$/,
      ''
    );
    const graftFile = path.join(repo, 'external-grafts');
    await fsPromises.writeFile(graftFile, `${head}\n`, 'utf8');
    const previous = process.env.GIT_GRAFT_FILE;
    process.env.GIT_GRAFT_FILE = graftFile;
    try {
      const result = await serviceFor(repo).history({ limit: 10, offset: 0 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.commits.map((commit) => commit.summary)).toEqual(['second', 'first']);
      }
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, 'GIT_GRAFT_FILE');
      } else {
        process.env.GIT_GRAFT_FILE = previous;
      }
    }
  });

  it('includes empty and merge commits and renders first-parent merge details', async () => {
    const repo = await makeRepo('brainstrike-git-merge-history-');
    await writeFile(repo, 'base.txt', 'base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'base'], { cwd: repo });
    const initialBranch = (
      await execFileAsync('git', ['branch', '--show-current'], { cwd: repo })
    ).stdout.trim();

    await execFileAsync('git', ['switch', '-qc', 'feature/history'], { cwd: repo });
    await writeFile(repo, 'feature.txt', 'feature\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'feature commit'], { cwd: repo });

    await execFileAsync('git', ['switch', '-q', initialBranch], { cwd: repo });
    await writeFile(repo, 'main.txt', 'main\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'main commit'], { cwd: repo });
    await execFileAsync('git', ['merge', '--no-ff', '-qm', 'merge feature', 'feature/history'], {
      cwd: repo,
    });
    const mergeId = (
      await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })
    ).stdout.trim();
    await execFileAsync('git', ['commit', '--allow-empty', '-qm', 'empty checkpoint'], {
      cwd: repo,
    });

    const service = serviceFor(repo);
    const history = await service.history({ limit: 20, offset: 0 });
    const files = await service.commitFiles({ commit: mergeId });
    const diff = await service.commitDiff({ commit: mergeId, path: 'feature.txt' });

    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.value.commits.map((commit) => commit.summary)).toEqual(
        expect.arrayContaining(['empty checkpoint', 'merge feature'])
      );
    }
    expect(files).toEqual({ ok: true, value: [{ path: 'feature.txt', status: 'A' }] });
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.value.unifiedDiff).toContain('+feature');
    }
  });

  it('returns changed files and a bounded historical file diff for a commit', async () => {
    const repo = await makeRepo('brainstrike-git-commit-detail-');
    await writeFile(repo, 'before.txt', 'shared line one\nshared line two\nbefore\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    await execFileAsync('git', ['mv', 'before.txt', 'after.txt'], { cwd: repo });
    await writeFile(repo, 'after.txt', 'shared line one\nshared line two\nafter\n');
    await execFileAsync('git', ['commit', '-qam', 'rename'], { cwd: repo });
    const oid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const files = await serviceFor(repo).commitFiles({ commit: oid });
    expect(files.ok).toBe(true);
    if (!files.ok) {
      return;
    }
    expect(files.value).toEqual([
      expect.objectContaining({ originalPath: 'before.txt', path: 'after.txt', status: 'R' }),
    ]);

    const diff = await serviceFor(repo).commitDiff({
      commit: oid,
      originalPath: 'before.txt',
      path: 'after.txt',
    });
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.value.unifiedDiff).toContain('diff --git a/before.txt b/after.txt');
      expect(diff.value.unifiedDiff).toContain('+after');
    }
  });

  it('CONTAINMENT: treats pathspec magic as a literal historical path', async () => {
    const repo = await makeRepo('brainstrike-git-literal-history-');
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'opened/inside.txt', 'inside\n');
    await writeFile(repo, 'sibling/outside.txt', 'historical-secret\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    const oid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const result = await serviceFor(path.join(repo, 'opened')).commitDiff({
      commit: oid,
      path: ':(top)sibling/outside.txt',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unifiedDiff).toBe('');
    }
  });

  it('scopes historical file paths to an opened repository subfolder', async () => {
    const repo = await makeRepo('brainstrike-git-history-scope-');
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'opened/inside.txt', 'inside\n');
    await writeFile(repo, 'sibling/outside.txt', 'outside\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'scoped history'], { cwd: repo });
    const oid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const service = serviceFor(path.join(repo, 'opened'));

    const files = await service.commitFiles({ commit: oid });

    expect(files).toEqual({
      ok: true,
      value: [{ path: 'inside.txt', status: 'A' }],
    });
    const diff = await service.commitDiff({ commit: oid, path: 'inside.txt' });
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.value.unifiedDiff).toContain('+inside');
      expect(diff.value.unifiedDiff).not.toContain('outside');
    }
  });

  it('switches only to an existing local branch and reports the new branch', async () => {
    const repo = await makeRepo('brainstrike-git-switch-');
    await writeFile(repo, 'file.txt', 'main\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    await execFileAsync('git', ['branch', 'feature/local'], { cwd: repo });

    const switched = await serviceFor(repo).switchBranch({ branch: 'feature/local' });

    expect(switched).toEqual({ ok: true, value: { branch: 'feature/local' } });
    const status = await serviceFor(repo).status();
    expect(status.ok && status.value.branch).toBe('feature/local');

    const missing = await serviceFor(repo).switchBranch({ branch: 'missing-branch' });
    expect(missing.ok).toBe(false);
  });

  it('switches to an option-looking local branch without detaching HEAD', async () => {
    const repo = await makeRepo('brainstrike-git-switch-option-');
    await writeFile(repo, 'file.txt', 'main\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    await execFileAsync('git', ['update-ref', 'refs/heads/--detach', 'HEAD'], { cwd: repo });

    const switched = await serviceFor(repo).switchBranch({ branch: '--detach' });

    expect(switched).toEqual({ ok: true, value: { branch: '--detach' } });
    const current = await execFileAsync('git', ['branch', '--show-current'], { cwd: repo });
    expect(current.stdout.replace(/\r?\n$/, '')).toBe('--detach');
  });

  it('fails closed for the local branch named "-" instead of switching to the previous branch', async () => {
    const repo = await makeRepo('brainstrike-git-switch-dash-');
    await writeFile(repo, 'file.txt', 'main\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    await execFileAsync('git', ['update-ref', 'refs/heads/-', 'HEAD'], { cwd: repo });
    await execFileAsync('git', ['switch', '-qc', 'feature/current'], { cwd: repo });

    const switched = await serviceFor(repo).switchBranch({ branch: '-' });

    expect(switched).toEqual({
      error: expect.stringMatching(/not supported/i),
      ok: false,
    });
    const current = await execFileAsync('git', ['branch', '--show-current'], { cwd: repo });
    expect(current.stdout.replace(/\r?\n$/, '')).toBe('feature/current');
  });

  it.skipIf(process.platform === 'win32')(
    'SECURITY: fetch does not execute configured reference hooks',
    async () => {
      const remote = await fsPromises.mkdtemp(
        path.join(os.tmpdir(), 'brainstrike-git-fetch-remote-')
      );
      const remoteReal = await fsPromises.realpath(remote);
      createdRoots.push(remoteReal);
      await execFileAsync('git', ['init', '--bare', '-q'], { cwd: remoteReal });

      const repo = await makeRepo('brainstrike-git-fetch-');
      await writeFile(repo, 'file.txt', 'local\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
      await execFileAsync('git', ['remote', 'add', 'origin', remoteReal], { cwd: repo });
      await execFileAsync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: repo });
      const hookMarker = path.join(repo, 'REFERENCE_HOOK_EXECUTED');
      await execFileAsync(
        'git',
        ['config', 'hook.sentinel-reference.command', `touch "${hookMarker}"`],
        { cwd: repo }
      );
      await execFileAsync(
        'git',
        ['config', '--add', 'hook.sentinel-reference.event', 'reference-transaction'],
        { cwd: repo }
      );
      await writeFile(repo, 'uncommitted.txt', 'keep me\n');
      const beforeHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;

      const fetched = await serviceFor(repo).fetch({ remote: 'origin' });

      expect(fetched.ok).toBe(true);
      await expect(fsPromises.access(hookMarker)).rejects.toThrow();
      const afterHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout;
      expect(afterHead).toBe(beforeHead);
      await expect(fsPromises.readFile(path.join(repo, 'uncommitted.txt'), 'utf8')).resolves.toBe(
        'keep me\n'
      );
    }
  );
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
  it('REFUSES to push an ancestor repository from an opened subdirectory root', async () => {
    const remote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-remote-'));
    const remoteReal = await fsPromises.realpath(remote);
    createdRoots.push(remoteReal);
    await execFileAsync('git', ['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo('brainstrike-git-push-scope-');
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await writeFile(repo, 'opened/file.txt', 'initial\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'initial'], { cwd: repo });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteReal], { cwd: repo });
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: repo });
    const remoteBefore = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: remoteReal }))
      .stdout;

    await writeFile(repo, 'opened/file.txt', 'local-only\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'local-only'], { cwd: repo });

    const invokedArgs: string[][] = [];
    const service = createGitService({
      cwd: path.join(repo, 'opened'),
      run: async (params) => {
        invokedArgs.push([...params.args]);
        return await execFileGitRunner(params);
      },
    });
    const pushed = await service.push();

    expect(pushed).toEqual({
      error: expect.stringMatching(/full Git worktree root/i),
      ok: false,
    });
    expect(invokedArgs.some((args) => args[0] === 'push')).toBe(false);
    const remoteAfter = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: remoteReal }))
      .stdout;
    expect(remoteAfter).toBe(remoteBefore);
  });

  it.skipIf(process.platform === 'win32')(
    'preserves a carriage-return-ending repository path on POSIX',
    async () => {
      const parent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-cr-root-'));
      const parentReal = await fsPromises.realpath(parent);
      createdRoots.push(parentReal);
      const repo = path.join(parentReal, 'repository\r');
      await fsPromises.mkdir(repo);
      await execFileAsync('git', ['init', '-q'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@brainstrike.dev'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Brainstrike Test'], { cwd: repo });

      const repository = await serviceFor(repo).repository();

      expect(repository.ok).toBe(true);
      if (repository.ok) {
        expect(repository.value.repositoryRoot).toBe(repo);
        expect(repository.value.openedRoot).toBe(repo);
        expect(repository.value.currentWorktree.path).toBe(repo);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'preserves a carriage-return-ending configured remote name on POSIX',
    async () => {
      const remote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-remote-'));
      const remoteReal = await fsPromises.realpath(remote);
      createdRoots.push(remoteReal);
      await execFileAsync('git', ['init', '--bare', '-q'], { cwd: remoteReal });

      const repo = await makeRepo();
      await writeFile(repo, 'a.txt', 'x\n');
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
      const remoteName = 'origin\r';
      await execFileAsync('git', ['config', `remote.${remoteName}.url`, remoteReal], { cwd: repo });

      const pushed = await serviceFor(repo).push({ remote: remoteName });

      expect(pushed.ok).toBe(true);
      const repository = await serviceFor(repo).repository();
      expect(repository.ok).toBe(true);
      if (repository.ok) {
        expect(repository.value.remotes).toContain(remoteName);
        expect(repository.value.defaultRemote).toBe(remoteName);
      }
    }
  );

  it('preserves a whitespace-bearing configured remote name exactly', async () => {
    const remote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-remote-'));
    const remoteReal = await fsPromises.realpath(remote);
    createdRoots.push(remoteReal);
    await execFileAsync('git', ['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    const remoteName = ' origin ';
    await execFileAsync('git', ['config', `remote.${remoteName}.url`, remoteReal], { cwd: repo });

    const pushed = await serviceFor(repo).push({ remote: remoteName });

    expect(pushed.ok).toBe(true);
    const repository = await serviceFor(repo).repository();
    expect(repository.ok).toBe(true);
    if (repository.ok) {
      expect(repository.value.remotes).toContain(remoteName);
      expect(repository.value.defaultRemote).toBe(remoteName);
    }
  });

  it('treats an option-looking configured remote as a fetch/push operand', async () => {
    const remote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-remote-'));
    const remoteReal = await fsPromises.realpath(remote);
    createdRoots.push(remoteReal);
    await execFileAsync('git', ['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await execFileAsync('git', ['branch', '-m', 'trunk'], { cwd: repo });
    await writeFile(repo, 'a.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    await execFileAsync('git', ['remote', 'add', '--', '--all', remoteReal], { cwd: repo });

    const pushed = await serviceFor(repo).push({ remote: '--all' });
    const fetched = await serviceFor(repo).fetch({ remote: '--all' });

    expect(pushed.ok).toBe(true);
    expect(fetched.ok).toBe(true);
    const remoteHead = await execFileAsync('git', ['show-ref', '--verify', 'refs/heads/trunk'], {
      cwd: remoteReal,
    });
    expect(remoteHead.stdout).toContain('refs/heads/trunk');
  });

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
    // fail; the caller must explicitly select the remote for the first push.
    await execFileAsync('git', ['remote', 'add', 'origin', remoteReal], { cwd: repo });

    const before = await serviceFor(repo).aheadBehind();
    expect(before.ok && before.value.hasUpstream).toBe(false);

    const pushed = await serviceFor(repo).push({ remote: 'origin' });
    expect(pushed.ok).toBe(true);

    // The upstream is now configured → ahead/behind resolves against it.
    const after = await serviceFor(repo).aheadBehind();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.hasUpstream).toBe(true);
      expect(after.value.upstream).toContain('origin/');
    }
  });

  it('refuses a first push when no remote was explicitly selected', async () => {
    const remote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-remote-'));
    const remoteReal = await fsPromises.realpath(remote);
    createdRoots.push(remoteReal);
    await execFileAsync('git', ['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFileAsync('git', ['add', '.'], { cwd: repo });
    await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteReal], { cwd: repo });

    const pushed = await serviceFor(repo).push();
    expect(pushed).toEqual({
      error: 'first push requires an explicit remote',
      ok: false,
    });

    const remoteHead = await execFileAsync(
      'git',
      ['show-ref', '--verify', '--quiet', 'refs/heads/main'],
      {
        cwd: remoteReal,
      }
    ).catch((error: unknown) => error);
    expect(remoteHead).toBeInstanceOf(Error);
  });

  it.skipIf(process.platform === 'win32')(
    'SECURITY: pushes do not execute repository-controlled hooks',
    async () => {
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
      const hookMarker = path.join(repo, 'PRE_PUSH_EXECUTED');
      const configuredHookMarker = path.join(repo, 'CONFIGURED_PRE_PUSH_EXECUTED');
      await fsPromises.writeFile(
        path.join(repo, '.git', 'hooks', 'pre-push'),
        `#!/bin/sh\ntouch "${hookMarker}"\n`,
        { mode: 0o755 }
      );
      await execFileAsync(
        'git',
        ['config', 'hook.sentinel-push.command', `touch "${configuredHookMarker}"`],
        { cwd: repo }
      );
      await execFileAsync('git', ['config', '--add', 'hook.sentinel-push.event', 'pre-push'], {
        cwd: repo,
      });

      const pushed = await serviceFor(repo).push();
      expect(pushed.ok).toBe(true);
      await expect(fsPromises.access(hookMarker)).rejects.toThrow();
      await expect(fsPromises.access(configuredHookMarker)).rejects.toThrow();

      const after = await serviceFor(repo).aheadBehind();
      expect(after.ok && after.value.ahead).toBe(0);
    }
  );
});
