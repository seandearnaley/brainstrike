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
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGitService,
  GIT_MAX_OUTPUT_BYTES,
  type GitCommandRun,
  type GitCommandRunner,
  type GitDiffParams,
  parsePorcelainV2,
} from '../../assistant-server/git-service';
import { execFixtureGit, fixtureGitRunner } from './_git-fixture-environment';

const createdRoots: string[] = [];

async function makeRepo(prefix = 'brainstrike-git-unit-'): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  // realpath so the macOS /var → /private/var symlink does not trip containment.
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  await execFixtureGit(['init', '-q'], { cwd: real });
  await execFixtureGit(['config', 'user.email', 'test@brainstrike.dev'], { cwd: real });
  await execFixtureGit(['config', 'user.name', 'Brainstrike Test'], { cwd: real });
  await execFixtureGit(['config', 'commit.gpgsign', 'false'], { cwd: real });
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
  return createGitService({ cwd, run: fixtureGitRunner });
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
      await execFixtureGit(['config', 'core.fsmonitor', fsmonitor], { cwd: repo });

      expect((await serviceFor(repo).status()).ok).toBe(true);
      await expect(fsPromises.access(marker)).rejects.toThrow();
    }
  );

  it('reports a clean repo after an initial commit', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'hello\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });

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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });

    // unstaged modification to the tracked file
    await writeFile(repo, 'tracked.txt', 'v2\n');
    // staged new file
    await writeFile(repo, 'staged.txt', 's\n');
    await execFixtureGit(['add', 'staged.txt'], { cwd: repo });
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
    const scopedFolder =
      process.platform === 'win32' ? '\u2003scoped folder\u2003' : '  scoped folder  ';
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
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
      await execFixtureGit(['add', '.'], { cwd: repo });
      await execFixtureGit(['commit', '-qm', 'base'], { cwd: repo });
      const marker = path.join(repo, 'DIFF_HOOK_EXECUTED');
      await execFixtureGit(['config', 'hook.sentinel-diff.command', `touch "${marker}"`], {
        cwd: repo,
      });
      await execFixtureGit(['config', '--add', 'hook.sentinel-diff.event', 'post-index-change'], {
        cwd: repo,
      });
      await fsPromises.writeFile(fsmonitor, `#!/bin/sh\ntouch "${fsmonitorMarker}"\n`, {
        mode: 0o755,
      });
      await execFixtureGit(['config', 'core.fsmonitor', fsmonitor], { cwd: repo });
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'file.txt', 'staged-change\n');
    await execFixtureGit(['add', 'file.txt'], { cwd: repo });

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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
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
      return fixtureGitRunner(params);
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    await writeFile(repo, 'sibling/outside.txt', 'after\n');
    const service = serviceFor(path.join(repo, 'opened'));
    const magicPath = ':(top)sibling/outside.txt';

    const staged = await service.stage({ path: magicPath });
    expect(staged.ok).toBe(false);
    expect((await execFixtureGit(['diff', '--cached', '--name-only'], { cwd: repo })).stdout).toBe(
      ''
    );

    await execFixtureGit(['add', 'sibling/outside.txt'], { cwd: repo });
    const unstaged = await service.unstage({ path: magicPath });
    expect(unstaged.ok).toBe(false);
    expect((await execFixtureGit(['diff', '--cached', '--name-only'], { cwd: repo })).stdout).toBe(
      'sibling/outside.txt\n'
    );
  });

  it('stages and unstages an exact all-whitespace path without widening to the opened root', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'base.txt', 'base\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'base'], { cwd: repo });
    const whitespacePath = process.platform === 'win32' ? '\u2003\u2003\u2003' : '   ';
    await writeFile(repo, whitespacePath, 'spaces\n');
    await writeFile(repo, 'other.txt', 'other\n');
    const service = serviceFor(repo);

    const staged = await service.stage({ path: whitespacePath });

    expect(staged.ok).toBe(true);
    expect(
      (await execFixtureGit(['diff', '--cached', '--name-only', '-z'], { cwd: repo })).stdout
    ).toBe(`${whitespacePath}\0`);

    await execFixtureGit(['add', '.'], { cwd: repo });
    const unstaged = await service.unstage({ path: whitespacePath });

    expect(unstaged.ok).toBe(true);
    expect(
      (await execFixtureGit(['diff', '--cached', '--name-only', '-z'], { cwd: repo })).stdout
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
        (await execFixtureGit(['diff', '--cached', '--name-only', '-z'], { cwd: repo })).stdout
      ).toBe('literal\\name.txt\0');
    }
  );

  it('stages then unstages a path', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'init.txt', 'x\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
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
      await execFixtureGit(['add', '.'], { cwd: repo });
      await execFixtureGit(['commit', '-qm', 'base'], { cwd: repo });
      const marker = path.join(repo, 'INDEX_HOOK_EXECUTED');
      await execFixtureGit(['config', 'hook.sentinel-index.command', `touch "${marker}"`], {
        cwd: repo,
      });
      await execFixtureGit(['config', '--add', 'hook.sentinel-index.event', 'post-index-change'], {
        cwd: repo,
      });
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
    await execFixtureGit(['add', '.'], { cwd: repo });

    const result = await serviceFor(repo).commit({
      description: 'A detailed body.\n\nWith a second paragraph.',
      summary: 'a normal message with spaces',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.commit).toMatch(/^[0-9a-f]{7,}$/);
    const log = await execFixtureGit(['log', '-1', '--pretty=%s'], { cwd: repo });
    expect(log.stdout.trim()).toBe('a normal message with spaces');
    const body = await execFixtureGit(['log', '-1', '--pretty=%b'], { cwd: repo });
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
      await execFixtureGit(
        ['config', '--local', 'hook.sentinel.command', `touch "${configuredHookMarker}"`],
        { cwd: repo }
      );
      await execFixtureGit(['config', '--local', '--add', 'hook.sentinel.event', 'pre-commit'], {
        cwd: repo,
      });
      await writeFile(repo, 'safe.txt', 'safe\n');
      await execFixtureGit(['add', '.'], { cwd: repo });

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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });

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
    await execFixtureGit(['add', '.'], { cwd: repo });

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
    const log = await execFixtureGit(['log', '-1', '--pretty=%s'], { cwd: repo });
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
    await execFixtureGit(['add', '.'], { cwd: repo });

    const result = await serviceFor(path.join(repo, 'opened')).commit({
      description: '',
      summary: 'must stay scoped',
    });

    expect(result).toEqual({
      error: expect.stringMatching(/outside the opened folder/i),
      ok: false,
    });
    await expect(
      execFixtureGit(['rev-parse', '--verify', 'HEAD'], { cwd: repo })
    ).rejects.toThrow();
  });

  it('REFUSES a staged rename that crosses into an opened subdirectory root', async () => {
    const repo = await makeRepo();
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'sibling/outside.txt', 'outside\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    await execFixtureGit(['mv', 'sibling/outside.txt', 'opened/moved.txt'], { cwd: repo });

    const result = await serviceFor(path.join(repo, 'opened')).commit({
      summary: 'must not move a sibling through a scoped commit',
    });

    expect(result).toEqual({
      error: expect.stringMatching(/outside the opened folder/i),
      ok: false,
    });
    expect((await execFixtureGit(['status', '--short'], { cwd: repo })).stdout.trim()).toContain(
      'sibling/outside.txt -> opened/moved.txt'
    );
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
      return fixtureGitRunner(params);
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
    const repo = path.join(
      parentReal,
      process.platform === 'win32' ? 'repository\u2003' : 'repository '
    );
    await fsPromises.mkdir(repo);
    await execFixtureGit(['init', '-q'], { cwd: repo });
    await execFixtureGit(['config', 'user.email', 'test@brainstrike.dev'], { cwd: repo });
    await execFixtureGit(['config', 'user.name', 'Brainstrike Test'], { cwd: repo });

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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });

    const linked = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-worktree-'));
    const linkedReal = await fsPromises.realpath(linked);
    createdRoots.push(linkedReal);
    await execFixtureGit(['worktree', 'add', '-q', '-b', 'feature/worktree', linkedReal], {
      cwd: repo,
    });

    const invokedArgs: string[][] = [];
    const recordingRunner: GitCommandRunner = (params) => {
      invokedArgs.push([...params.args]);
      return fixtureGitRunner(params);
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'first commit'], { cwd: repo });
    await writeFile(repo, 'second.txt', 'second\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-q', '-m', 'second commit', '-m', 'Detailed body.'], {
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'first'], { cwd: repo });
    await writeFile(repo, 'second.txt', 'second\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'second'], { cwd: repo });
    const head = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.replace(
      /\r?\n$/,
      ''
    );
    const graftFile = path.join(repo, 'external-grafts');
    await fsPromises.writeFile(graftFile, `${head}\n`, 'utf8');
    const previous = process.env['GIT_GRAFT_FILE'];
    process.env['GIT_GRAFT_FILE'] = graftFile;
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
        process.env['GIT_GRAFT_FILE'] = previous;
      }
    }
  });

  it('includes empty and merge commits and renders first-parent merge details', async () => {
    const repo = await makeRepo('brainstrike-git-merge-history-');
    await writeFile(repo, 'base.txt', 'base\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'base'], { cwd: repo });
    const initialBranch = (
      await execFixtureGit(['branch', '--show-current'], { cwd: repo })
    ).stdout.trim();

    await execFixtureGit(['switch', '-qc', 'feature/history'], { cwd: repo });
    await writeFile(repo, 'feature.txt', 'feature\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'feature commit'], { cwd: repo });

    await execFixtureGit(['switch', '-q', initialBranch], { cwd: repo });
    await writeFile(repo, 'main.txt', 'main\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'main commit'], { cwd: repo });
    await execFixtureGit(['merge', '--no-ff', '-qm', 'merge feature', 'feature/history'], {
      cwd: repo,
    });
    const mergeId = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await execFixtureGit(['commit', '--allow-empty', '-qm', 'empty checkpoint'], {
      cwd: repo,
    });

    const service = serviceFor(repo);
    const history = await service.history({ limit: 20, offset: 0 });
    const files = await service.commitFiles({ commit: mergeId });

    expect(history.ok).toBe(true);
    if (history.ok) {
      expect(history.value.commits.map((commit) => commit.summary)).toEqual(
        expect.arrayContaining(['empty checkpoint', 'merge feature'])
      );
    }
    expect(files).toEqual({ ok: true, value: [{ path: 'feature.txt', status: 'A' }] });
  });

  it('returns changed files (with rename pairing) for a commit', async () => {
    const repo = await makeRepo('brainstrike-git-commit-detail-');
    await writeFile(repo, 'before.txt', 'shared line one\nshared line two\nbefore\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    await execFixtureGit(['mv', 'before.txt', 'after.txt'], { cwd: repo });
    await writeFile(repo, 'after.txt', 'shared line one\nshared line two\nafter\n');
    await execFixtureGit(['commit', '-qam', 'rename'], { cwd: repo });
    const oid = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const files = await serviceFor(repo).commitFiles({ commit: oid });
    expect(files.ok).toBe(true);
    if (!files.ok) {
      return;
    }
    expect(files.value).toEqual([
      expect.objectContaining({ originalPath: 'before.txt', path: 'after.txt', status: 'R' }),
    ]);
  });

  it('scopes historical file paths to an opened repository subfolder', async () => {
    const repo = await makeRepo('brainstrike-git-history-scope-');
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'opened/inside.txt', 'inside\n');
    await writeFile(repo, 'sibling/outside.txt', 'outside\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'scoped history'], { cwd: repo });
    const oid = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const service = serviceFor(path.join(repo, 'opened'));

    const files = await service.commitFiles({ commit: oid });

    expect(files).toEqual({
      ok: true,
      value: [{ path: 'inside.txt', status: 'A' }],
    });
  });

  it('creates and checks out a new local branch from an explicit start point', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'file.txt', 'initial\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    const service = createGitService({ cwd: repo, run: fixtureGitRunner });

    const created = await service.createBranch({ branch: 'bs/bright-fox', startPoint: 'HEAD' });
    expect(created).toEqual({ ok: true, value: { branch: 'bs/bright-fox' } });

    const status = await service.status();
    expect(status.ok && status.value.branch).toBe('bs/bright-fox');
  });

  it('creates the branch at the GIVEN start point, not silently at HEAD (Minor 4)', async () => {
    const repo = await makeRepo('brainstrike-git-create-branch-startpoint-');
    await writeFile(repo, 'file.txt', 'first\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'first commit'], { cwd: repo });
    const firstCommit = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    // A second commit moves HEAD forward, so "starts at HEAD" and "starts at
    // the first commit" become distinguishable outcomes.
    await writeFile(repo, 'file.txt', 'second\n');
    await execFixtureGit(['commit', '-qam', 'second commit'], { cwd: repo });
    const service = createGitService({ cwd: repo, run: fixtureGitRunner });

    const created = await service.createBranch({
      branch: 'bs/from-first-commit',
      startPoint: firstCommit,
    });
    expect(created).toEqual({ ok: true, value: { branch: 'bs/from-first-commit' } });

    const resolved = (
      await execFixtureGit(['rev-parse', 'bs/from-first-commit'], { cwd: repo })
    ).stdout.trim();
    expect(resolved).toBe(firstCommit);
  });

  it('refuses a branch name that already exists rather than silently switching', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'file.txt', 'initial\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    const service = createGitService({ cwd: repo, run: fixtureGitRunner });

    await service.createBranch({ branch: 'bs/bright-fox', startPoint: 'HEAD' });
    const again = await service.createBranch({ branch: 'bs/bright-fox', startPoint: 'HEAD' });
    expect(again).toEqual({ error: 'local branch "bs/bright-fox" already exists', ok: false });
  });

  it('rejects an empty branch name and the "-" shorthand', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'file.txt', 'initial\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    const service = createGitService({ cwd: repo, run: fixtureGitRunner });

    expect(await service.createBranch({ branch: '' })).toEqual({
      error: 'branch must be a non-empty string',
      ok: false,
    });
    expect(await service.createBranch({ branch: '-' })).toEqual({
      error: 'local branch "-" is not supported',
      ok: false,
    });
  });

  it('refuses an option-looking branch name as a visible git error, never a flag parse (Minor 5)', async () => {
    // Mirrors switchBranch's "switches to an option-looking local branch"
    // parity test above, but createBranch's `-c <branch>` has no existing ref
    // to disambiguate against — git itself refuses `--force` as a ref name
    // (confirmed against real git: exit 128, "not a valid branch name"),
    // rather than silently treating it as the `--force` flag to `switch`.
    const repo = await makeRepo('brainstrike-git-create-branch-option-');
    await writeFile(repo, 'file.txt', 'initial\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    const service = createGitService({ cwd: repo, run: fixtureGitRunner });

    const created = await service.createBranch({ branch: '--force' });

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error).not.toBe('');
    }
    const branches = await execFixtureGit(['branch', '--list'], { cwd: repo });
    expect(branches.stdout).not.toContain('force');
  });

  it('rejects an empty startPoint rather than silently falling back to HEAD (Minor 6)', async () => {
    const repo = await makeRepo('brainstrike-git-create-branch-empty-startpoint-');
    await writeFile(repo, 'file.txt', 'initial\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    const service = createGitService({ cwd: repo, run: fixtureGitRunner });

    // Exercises the SAME path the IPC handler now forwards an explicit ''
    // startPoint through (git-ipc-handlers.ts no longer drops it on
    // falsiness) — this is the service-side half of that contract.
    expect(await service.createBranch({ branch: 'bs/empty-startpoint', startPoint: '' })).toEqual({
      error: 'startPoint must be a non-empty string when supplied',
      ok: false,
    });
  });

  it('switches only to an existing local branch and reports the new branch', async () => {
    const repo = await makeRepo('brainstrike-git-switch-');
    await writeFile(repo, 'file.txt', 'main\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    await execFixtureGit(['branch', 'feature/local'], { cwd: repo });

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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    await execFixtureGit(['update-ref', 'refs/heads/--detach', 'HEAD'], { cwd: repo });

    const switched = await serviceFor(repo).switchBranch({ branch: '--detach' });

    expect(switched).toEqual({ ok: true, value: { branch: '--detach' } });
    const current = await execFixtureGit(['branch', '--show-current'], { cwd: repo });
    expect(current.stdout.replace(/\r?\n$/, '')).toBe('--detach');
  });

  it('fails closed for the local branch named "-" instead of switching to the previous branch', async () => {
    const repo = await makeRepo('brainstrike-git-switch-dash-');
    await writeFile(repo, 'file.txt', 'main\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    await execFixtureGit(['update-ref', 'refs/heads/-', 'HEAD'], { cwd: repo });
    await execFixtureGit(['switch', '-qc', 'feature/current'], { cwd: repo });

    const switched = await serviceFor(repo).switchBranch({ branch: '-' });

    expect(switched).toEqual({
      error: expect.stringMatching(/not supported/i),
      ok: false,
    });
    const current = await execFixtureGit(['branch', '--show-current'], { cwd: repo });
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
      await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

      const repo = await makeRepo('brainstrike-git-fetch-');
      await writeFile(repo, 'file.txt', 'local\n');
      await execFixtureGit(['add', '.'], { cwd: repo });
      await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
      await execFixtureGit(['remote', 'add', 'origin', remoteReal], { cwd: repo });
      await execFixtureGit(['push', '-q', '-u', 'origin', 'HEAD'], { cwd: repo });
      const hookMarker = path.join(repo, 'REFERENCE_HOOK_EXECUTED');
      await execFixtureGit(['config', 'hook.sentinel-reference.command', `touch "${hookMarker}"`], {
        cwd: repo,
      });
      await execFixtureGit(
        ['config', '--add', 'hook.sentinel-reference.event', 'reference-transaction'],
        { cwd: repo }
      );
      await writeFile(repo, 'uncommitted.txt', 'keep me\n');
      const beforeHead = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout;

      const fetched = await serviceFor(repo).fetch({ remote: 'origin' });

      expect(fetched.ok).toBe(true);
      await expect(fsPromises.access(hookMarker)).rejects.toThrow();
      const afterHead = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout;
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
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });

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
    await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await execFixtureGit(['remote', 'add', 'origin', remoteReal], { cwd: repo });
    await execFixtureGit(['push', '-q', '-u', 'origin', 'HEAD'], { cwd: repo });

    // Now make a local commit that is NOT pushed → ahead by 1.
    await writeFile(repo, 'b.txt', 'y\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'second'], { cwd: repo });

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
    await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo('brainstrike-git-push-scope-');
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await writeFile(repo, 'opened/file.txt', 'initial\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    await execFixtureGit(['remote', 'add', 'origin', remoteReal], { cwd: repo });
    await execFixtureGit(['push', '-q', '-u', 'origin', 'HEAD'], { cwd: repo });
    const remoteBefore = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: remoteReal })).stdout;

    await writeFile(repo, 'opened/file.txt', 'local-only\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'local-only'], { cwd: repo });

    const invokedArgs: string[][] = [];
    const service = createGitService({
      cwd: path.join(repo, 'opened'),
      run: async (params) => {
        invokedArgs.push([...params.args]);
        return await fixtureGitRunner(params);
      },
    });
    const pushed = await service.push();

    expect(pushed).toEqual({
      error: expect.stringMatching(/full Git worktree root/i),
      ok: false,
    });
    expect(invokedArgs.some((args) => args[0] === 'push')).toBe(false);
    const remoteAfter = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: remoteReal })).stdout;
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
      await execFixtureGit(['init', '-q'], { cwd: repo });
      await execFixtureGit(['config', 'user.email', 'test@brainstrike.dev'], { cwd: repo });
      await execFixtureGit(['config', 'user.name', 'Brainstrike Test'], { cwd: repo });

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
      await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

      const repo = await makeRepo();
      await writeFile(repo, 'a.txt', 'x\n');
      await execFixtureGit(['add', '.'], { cwd: repo });
      await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
      const remoteName = 'origin\r';
      await execFixtureGit(['config', `remote.${remoteName}.url`, remoteReal], { cwd: repo });

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
    await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    const remoteName = ' origin ';
    await execFixtureGit(['config', `remote.${remoteName}.url`, remoteReal], { cwd: repo });

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
    await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await execFixtureGit(['branch', '-m', 'trunk'], { cwd: repo });
    await writeFile(repo, 'a.txt', 'x\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await execFixtureGit(['remote', 'add', '--', '--all', remoteReal], { cwd: repo });

    const pushed = await serviceFor(repo).push({ remote: '--all' });
    const fetched = await serviceFor(repo).fetch({ remote: '--all' });

    expect(pushed.ok).toBe(true);
    expect(fetched.ok).toBe(true);
    const remoteHead = await execFixtureGit(['show-ref', '--verify', 'refs/heads/trunk'], {
      cwd: remoteReal,
    });
    expect(remoteHead.stdout).toContain('refs/heads/trunk');
  });

  it('sets the upstream on the first push of a branch with no upstream', async () => {
    const remote = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-remote-'));
    const remoteReal = await fsPromises.realpath(remote);
    createdRoots.push(remoteReal);
    await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    // origin exists but the branch has NO upstream yet → a bare `git push` would
    // fail; the caller must explicitly select the remote for the first push.
    await execFixtureGit(['remote', 'add', 'origin', remoteReal], { cwd: repo });

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
    await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'x\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await execFixtureGit(['remote', 'add', 'origin', remoteReal], { cwd: repo });

    const pushed = await serviceFor(repo).push();
    expect(pushed).toEqual({
      error: 'first push requires an explicit remote',
      ok: false,
    });

    const remoteHead = await execFixtureGit(
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
      await execFixtureGit(['init', '--bare', '-q'], { cwd: remoteReal });

      const repo = await makeRepo();
      await writeFile(repo, 'a.txt', 'x\n');
      await execFixtureGit(['add', '.'], { cwd: repo });
      await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
      await execFixtureGit(['remote', 'add', 'origin', remoteReal], { cwd: repo });
      await execFixtureGit(['push', '-q', '-u', 'origin', 'HEAD'], { cwd: repo });

      // A second local commit, then push through the service with the upstream set.
      await writeFile(repo, 'b.txt', 'y\n');
      await execFixtureGit(['add', '.'], { cwd: repo });
      await execFixtureGit(['commit', '-qm', 'second'], { cwd: repo });
      const hookMarker = path.join(repo, 'PRE_PUSH_EXECUTED');
      const configuredHookMarker = path.join(repo, 'CONFIGURED_PRE_PUSH_EXECUTED');
      await fsPromises.writeFile(
        path.join(repo, '.git', 'hooks', 'pre-push'),
        `#!/bin/sh\ntouch "${hookMarker}"\n`,
        { mode: 0o755 }
      );
      await execFixtureGit(
        ['config', 'hook.sentinel-push.command', `touch "${configuredHookMarker}"`],
        { cwd: repo }
      );
      await execFixtureGit(['config', '--add', 'hook.sentinel-push.event', 'pre-push'], {
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

describe('git service — structuredFileDiff (real repos)', () => {
  it('working mode: modify — full content both sides, correct absolute hunk ranges, additions/deletions', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'line1\nline2\nline3\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'a.txt', 'line1\nline2-edited\nline3\n');

    const result = await serviceFor(repo).structuredFileDiff({ mode: 'working', path: 'a.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('modified');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'line1\nline2-edited\nline3\n',
      oldContent: 'line1\nline2\nline3\n',
    });
    expect(result.value.additions).toBe(1);
    expect(result.value.deletions).toBe(1);
    expect(result.value.hunks).toEqual([{ newLines: 3, newStart: 1, oldLines: 3, oldStart: 1 }]);
  });

  it('working mode: delete — newContent null, oldContent from HEAD', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'hello\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await fsPromises.rm(path.join(repo, 'a.txt'));

    const result = await serviceFor(repo).structuredFileDiff({ mode: 'working', path: 'a.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('deleted');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: null,
      oldContent: 'hello\n',
    });
  });

  it('staged mode: rename+edit — status "renamed", oldPath set, old content read from oldPath', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'old.txt', 'line1\nline2\nline3\nline4\nline5\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await execFixtureGit(['mv', 'old.txt', 'new.txt'], { cwd: repo });
    await writeFile(repo, 'new.txt', 'line1\nline2-edited\nline3\nline4\nline5\n');
    await execFixtureGit(['add', 'new.txt'], { cwd: repo });

    const result = await serviceFor(repo).structuredFileDiff({ mode: 'staged', path: 'new.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('renamed');
    expect(result.value.oldPath).toBe('old.txt');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'line1\nline2-edited\nline3\nline4\nline5\n',
      oldContent: 'line1\nline2\nline3\nline4\nline5\n',
    });
  });

  it('untracked mode: additions equals countLines with no trailing-newline off-by-one', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'new.txt', 'new\n');

    const result = await serviceFor(repo).structuredFileDiff({
      mode: 'untracked',
      path: 'new.txt',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('untracked');
    expect(result.value.additions).toBe(1);
    expect(result.value.deletions).toBe(0);
    expect(result.value.content).toEqual({ kind: 'full', newContent: 'new\n', oldContent: null });
    expect(result.value.hunks).toEqual([]);
  });

  it('untracked mode: a file over the 2MB cap degrades to hunks-only with a real, non-empty `--no-index` preview', async () => {
    const repo = await makeRepo();
    const line = `${'x'.repeat(100)}\n`;
    const lineCount = 25_000; // ~2.5MB, over both the 2MB content cap and the 1MB diff-output cap.
    await writeFile(repo, 'big-untracked.txt', line.repeat(lineCount));

    const result = await serviceFor(repo).structuredFileDiff({
      mode: 'untracked',
      path: 'big-untracked.txt',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('untracked');
    // The stat-size guard means an over-cap file's bytes are never read, so
    // there is nothing to count lines from — `additions` is honestly `null`
    // (the type allows it), not a fabricated line count.
    expect(result.value.additions).toBeNull();
    expect(result.value.deletions).toBe(0);
    expect(result.value.hunks).toEqual([]);
    expect(result.value.content.kind).toBe('hunks-only');
    if (result.value.content.kind !== 'hunks-only') {
      return;
    }
    // Pin the restored behavior: a REAL `--no-index` preview, never an empty
    // stub — non-empty hunkText, visibly marked as truncated.
    expect(result.value.content.reason).toBe('over-cap-new');
    expect(result.value.content.hunkText.length).toBeGreaterThan(0);
    expect(result.value.content.hunkText).toContain('diff --git');
    expect(result.value.content.hunkTextTruncated).toBe(true);
    expect(result.value.content.hunkText).toContain('…(output truncated)');
  });

  it('staged mode: modify — new side reads the INDEX (:0:), not a later unstaged worktree edit', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'v1\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'a.txt', 'v2\n');
    await execFixtureGit(['add', 'a.txt'], { cwd: repo });
    // Further edit AFTER staging, left unstaged — staged mode must NOT see this.
    await writeFile(repo, 'a.txt', 'v3-unstaged\n');

    const result = await serviceFor(repo).structuredFileDiff({ mode: 'staged', path: 'a.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('modified');
    expect(result.value.content).toEqual({ kind: 'full', newContent: 'v2\n', oldContent: 'v1\n' });
  });

  it('binary file — content kind "binary", hunks empty, additions/deletions null', async () => {
    const repo = await makeRepo();
    await fsPromises.writeFile(
      path.join(repo, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
    );
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init binary'], { cwd: repo });
    await fsPromises.writeFile(
      path.join(repo, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x0e])
    );

    const result = await serviceFor(repo).structuredFileDiff({ mode: 'working', path: 'img.png' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toEqual({ kind: 'binary' });
    expect(result.value.hunks).toEqual([]);
    expect(result.value.additions).toBeNull();
    expect(result.value.deletions).toBeNull();
  });

  it('a file over the 2MB per-side cap degrades to hunks-only, with a visible truncation marker when the diff text also overflows', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'big.txt', 'small\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    const line = `${'x'.repeat(100)}\n`;
    const lineCount = 25_000; // ~2.5MB, over both the 2MB content cap and the 1MB diff-output cap.
    await writeFile(repo, 'big.txt', line.repeat(lineCount));

    const result = await serviceFor(repo).structuredFileDiff({ mode: 'working', path: 'big.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.additions).toBe(lineCount);
    expect(result.value.content.kind).toBe('hunks-only');
    if (result.value.content.kind !== 'hunks-only') {
      return;
    }
    expect(result.value.content.reason).toBe('over-cap-new');
    expect(result.value.content.hunkTextTruncated).toBe(true);
    expect(result.value.content.hunkText).toContain('…(output truncated)');
  });

  it("commit mode CONTAINMENT (ported from the retired commitDiff test): ':(top)' pathspec magic is a literal path and leaks nothing from outside the opened subfolder", async () => {
    const repo = await makeRepo();
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'opened/inside.txt', 'inside\n');
    await writeFile(repo, 'sibling/outside.txt', 'historical-secret\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    const oid = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const result = await serviceFor(path.join(repo, 'opened')).structuredFileDiff({
      commitId: oid,
      mode: 'commit',
      path: ':(top)sibling/outside.txt',
    });

    // Literal-pathspec discipline: no file by that LITERAL name exists in the
    // commit, so the request fails per-path — and nothing anywhere in the
    // result may carry the sibling's content.
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('historical-secret');
  });

  it('commit mode scopes historical paths to the opened subfolder (ported from the retired commitDiff test)', async () => {
    const repo = await makeRepo();
    await fsPromises.mkdir(path.join(repo, 'opened'));
    await fsPromises.mkdir(path.join(repo, 'sibling'));
    await writeFile(repo, 'opened/inside.txt', 'inside\n');
    await writeFile(repo, 'sibling/outside.txt', 'outside\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'scoped history'], { cwd: repo });
    const oid = (await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    const service = serviceFor(path.join(repo, 'opened'));

    const inside = await service.structuredFileDiff({
      commitId: oid,
      mode: 'commit',
      path: 'inside.txt',
    });
    expect(inside.ok).toBe(true);
    if (inside.ok) {
      expect(JSON.stringify(inside.value.content)).toContain('inside');
      expect(JSON.stringify(inside.value)).not.toContain('outside');
    }

    // A relative escape is rejected by containment validation, never resolved.
    const escapeAttempt = await service.structuredFileDiff({
      commitId: oid,
      mode: 'commit',
      path: '../sibling/outside.txt',
    });
    expect(escapeAttempt.ok).toBe(false);
    if (!escapeAttempt.ok) {
      expect(escapeAttempt.error).toMatch(/escapes the opened folder/);
    }
  });

  it('working mode: a zero-numstat, actually-untracked path is directed to mode "untracked", not a generic "no differences"', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'tracked.txt', 'v1\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'brand-new.txt', 'hi\n');

    const result = await serviceFor(repo).structuredFileDiff({
      mode: 'working',
      path: 'brand-new.txt',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/untracked/);
    expect(result.error).toMatch(/mode/);
  });

  it('working mode: an unchanged tracked path reports a generic "no differences" error', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'tracked.txt', 'v1\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });

    const result = await serviceFor(repo).structuredFileDiff({
      mode: 'working',
      path: 'tracked.txt',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toMatch(/no differences/);
  });

  it('working mode: rename+edit — status "renamed", oldPath set (uncommitted, HEAD vs. worktree combined)', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'old.txt', 'line1\nline2\nline3\nline4\nline5\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await execFixtureGit(['mv', 'old.txt', 'new.txt'], { cwd: repo });
    await writeFile(repo, 'new.txt', 'line1\nline2-edited\nline3\nline4\nline5\n');
    // Deliberately NOT staged again — `git mv` auto-stages the rename, and this
    // further edit is left unstaged. `working` mode (HEAD vs. worktree) must
    // still see the combined rename+edit as ONE renamed entry.

    const result = await serviceFor(repo).structuredFileDiff({ mode: 'working', path: 'new.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('renamed');
    expect(result.value.oldPath).toBe('old.txt');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'line1\nline2-edited\nline3\nline4\nline5\n',
      oldContent: 'line1\nline2\nline3\nline4\nline5\n',
    });
  });

  it('SECURITY: untracked mode reads a symlink as its link text, never a dereferenced out-of-root target', async () => {
    const repo = await makeRepo();
    const secretRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-git-outside-'));
    const secretReal = await fsPromises.realpath(secretRoot);
    createdRoots.push(secretReal);
    const secretFile = path.join(secretReal, 'secret.txt');
    await fsPromises.writeFile(secretFile, 'TOP SECRET CONTENT\n', 'utf8');

    // `assertUntrackedDiffPathContained` only checks the PARENT chain, not the
    // leaf — this symlink's PARENT is the repo root itself (contained), but
    // its TARGET points entirely outside the opened root.
    await fsPromises.symlink(secretFile, path.join(repo, 'link-to-secret.txt'));

    const result = await serviceFor(repo).structuredFileDiff({
      mode: 'untracked',
      path: 'link-to-secret.txt',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content.kind).toBe('full');
    if (result.value.content.kind !== 'full') {
      return;
    }
    // Content is the LINK TEXT (the target path string) — never the
    // dereferenced out-of-root file's actual bytes.
    expect(result.value.content.newContent).toBe(secretFile);
    expect(result.value.content.newContent).not.toContain('TOP SECRET');
  });

  it.skipIf(process.platform === 'win32')(
    'SECURITY: working mode reads a modified symlink as link text on both sides, never dereferenced content',
    async () => {
      const repo = await makeRepo();
      await fsPromises.symlink('old-target.txt', path.join(repo, 'link.txt'));
      await execFixtureGit(['add', '.'], { cwd: repo });
      await execFixtureGit(['commit', '-qm', 'init symlink'], { cwd: repo });

      await fsPromises.rm(path.join(repo, 'link.txt'));
      await fsPromises.symlink('new-target.txt', path.join(repo, 'link.txt'));

      const result = await serviceFor(repo).structuredFileDiff({
        mode: 'working',
        path: 'link.txt',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.value.status).toBe('modified');
      // Old side comes from `cat-file blob` (git's own 120000 rendering: the
      // link TEXT). New side must be consistent — also the link text, never a
      // dereferenced read through a (here, dangling) symlink target.
      expect(result.value.content).toEqual({
        kind: 'full',
        newContent: 'new-target.txt',
        oldContent: 'old-target.txt',
      });
    }
  );

  it('cwd is a SUBDIRECTORY of the worktree — working-mode diff of a file inside it succeeds with correct content', async () => {
    const repo = await makeRepo();
    await fsPromises.mkdir(path.join(repo, 'sub', 'dir'), { recursive: true });
    await writeFile(repo, 'sub/dir/file.txt', 'line1\nline2\nline3\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'sub/dir/file.txt', 'line1\nline2-edited\nline3\n');

    // The service is created with cwd PINNED TO THE SUBDIRECTORY, not the
    // worktree root — git's own numstat/diff/cat-file output is repo-root-
    // relative by default (see the module doc comment's PATH SPACE section);
    // `path` here is deliberately cwd-relative ("file.txt", not
    // "sub/dir/file.txt") to prove the sub-root fix actually resolves it.
    const subService = serviceFor(path.join(repo, 'sub', 'dir'));
    const result = await subService.structuredFileDiff({ mode: 'working', path: 'file.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('modified');
    expect(result.value.path).toBe('file.txt');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'line1\nline2-edited\nline3\n',
      oldContent: 'line1\nline2\nline3\n',
    });
    expect(result.value.hunks).toEqual([{ newLines: 3, newStart: 1, oldLines: 3, oldStart: 1 }]);
  });

  it('a tracked file over 4MB at HEAD degrades to hunks-only, never an error (size-probed, never read past the cap)', async () => {
    const repo = await makeRepo();
    const line = `${'y'.repeat(100)}\n`;
    const lineCount = 45_000; // ~4.5MB — over the OLD hard maxBuffer ceiling (GIT_MAX_BUFFER_BYTES, 4MB).
    await writeFile(repo, 'huge.txt', line.repeat(lineCount));
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'add huge file'], { cwd: repo });
    // New side is deliberately SMALL (a near-total deletion) so only the OLD
    // side is over cap — proves the size probe gates each side independently
    // rather than only ever tripping when both sides happen to be huge.
    await writeFile(repo, 'huge.txt', 'shrunk\n');

    const result = await serviceFor(repo).structuredFileDiff({ mode: 'working', path: 'huge.txt' });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content.kind).toBe('hunks-only');
    if (result.value.content.kind !== 'hunks-only') {
      return;
    }
    expect(result.value.content.reason).toBe('over-cap-old');
  });

  it('an unresolved merge conflict (staged mode) surfaces ok:false naming the path, never status "deleted"', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'conflict.txt', 'base\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    const { stdout: originalBranch } = await execFixtureGit(['symbolic-ref', '--short', 'HEAD'], {
      cwd: repo,
    });

    await execFixtureGit(['checkout', '-qb', 'branch-a'], { cwd: repo });
    await writeFile(repo, 'conflict.txt', 'from branch-a\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'branch-a change'], { cwd: repo });

    await execFixtureGit(['checkout', '-q', originalBranch.trim()], { cwd: repo });
    await writeFile(repo, 'conflict.txt', 'from main\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'main change'], { cwd: repo });

    await execFixtureGit(['merge', '-q', 'branch-a'], { cwd: repo }).catch(() => {
      // A conflicting merge exits non-zero — expected, that's the fixture.
    });

    // Only `staged` mode's new side is addressed via `:0:<path>` (the index
    // stage syntax) — `working` mode reads the raw worktree file (which
    // still exists, conflict markers and all) and HEAD via the tree syntax,
    // neither of which can ever produce the "not at stage" wording. The
    // unmerged classification is therefore inherently staged-mode-specific.
    const staged = await serviceFor(repo).structuredFileDiff({
      mode: 'staged',
      path: 'conflict.txt',
    });
    expect(staged.ok).toBe(false);
    if (staged.ok) {
      return;
    }
    expect(staged.error).toMatch(/unmerged path/);
    expect(staged.error).toMatch(/resolve merge conflicts/);
    expect(staged.error).toContain('conflict.txt');
  });
});

describe('git service — structuredFileDiff commit/range modes (real repos, BST-1113)', () => {
  it('commit mode: ordinary commit — correct old/new content, hunks, additions/deletions, status "modified"', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'line1\nline2\nline3\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await writeFile(repo, 'a.txt', 'line1\nline2-edited\nline3\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'edit'], { cwd: repo });
    const { stdout } = await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
    const commitId = stdout.trim();

    const result = await serviceFor(repo).structuredFileDiff({
      commitId,
      mode: 'commit',
      path: 'a.txt',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('modified');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'line1\nline2-edited\nline3\n',
      oldContent: 'line1\nline2\nline3\n',
    });
    expect(result.value.additions).toBe(1);
    expect(result.value.deletions).toBe(1);
    expect(result.value.hunks).toEqual([{ newLines: 3, newStart: 1, oldLines: 3, oldStart: 1 }]);
  });

  it('commit mode: a ROOT commit (no parent) falls back to the empty-tree old ref — status "added", oldContent null', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'root content\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'root commit'], { cwd: repo });
    const { stdout } = await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
    const commitId = stdout.trim();
    // Confirm this really is a root commit (no parent) — the fixture the
    // fallback path needs, not an assumption.
    await expect(
      execFixtureGit(['rev-parse', '--verify', `${commitId}^`], { cwd: repo })
    ).rejects.toThrow();

    const result = await serviceFor(repo).structuredFileDiff({
      commitId,
      mode: 'commit',
      path: 'a.txt',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('added');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: 'root content\n',
      oldContent: null,
    });
  });

  it('commit mode: a file DELETED in that commit — newContent null, status "deleted"', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'hello\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    await fsPromises.rm(path.join(repo, 'a.txt'));
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'delete a.txt'], { cwd: repo });
    const { stdout } = await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
    const commitId = stdout.trim();

    const result = await serviceFor(repo).structuredFileDiff({
      commitId,
      mode: 'commit',
      path: 'a.txt',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.status).toBe('deleted');
    expect(result.value.content).toEqual({
      kind: 'full',
      newContent: null,
      oldContent: 'hello\n',
    });
  });

  it("range mode: baseRef vs HEAD — modified path's old side comes from baseRef; a path added since baseRef has oldContent null", async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'v1\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    const { stdout: baseStdout } = await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
    const baseRef = baseStdout.trim();

    await writeFile(repo, 'a.txt', 'v2\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'edit a'], { cwd: repo });
    await writeFile(repo, 'new.txt', 'brand new\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'add new'], { cwd: repo });

    const modified = await serviceFor(repo).structuredFileDiff({
      baseRef,
      mode: 'range',
      path: 'a.txt',
    });
    expect(modified.ok).toBe(true);
    if (!modified.ok) {
      return;
    }
    expect(modified.value.status).toBe('modified');
    expect(modified.value.content).toEqual({
      kind: 'full',
      newContent: 'v2\n',
      oldContent: 'v1\n',
    });

    const added = await serviceFor(repo).structuredFileDiff({
      baseRef,
      mode: 'range',
      path: 'new.txt',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) {
      return;
    }
    expect(added.value.status).toBe('added');
    expect(added.value.content).toEqual({
      kind: 'full',
      newContent: 'brand new\n',
      oldContent: null,
    });
  });

  it('range mode: new side is HEAD, NOT the live worktree — an uncommitted edit left on disk is invisible', async () => {
    const repo = await makeRepo();
    await writeFile(repo, 'a.txt', 'v1\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init'], { cwd: repo });
    const { stdout: baseStdout } = await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
    const baseRef = baseStdout.trim();

    await writeFile(repo, 'a.txt', 'v2\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'edit a'], { cwd: repo });
    // Left dirty AFTER the commit HEAD sits at — range mode must not see this.
    await writeFile(repo, 'a.txt', 'v3-uncommitted\n');

    const result = await serviceFor(repo).structuredFileDiff({
      baseRef,
      mode: 'range',
      path: 'a.txt',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toEqual({ kind: 'full', newContent: 'v2\n', oldContent: 'v1\n' });
  });

  it('commit mode: old side over the 2MB cap degrades to hunks-only with reason "over-cap-old" (size-probe machinery reached, not bypassed)', async () => {
    const repo = await makeRepo();
    const line = `${'y'.repeat(100)}\n`;
    const lineCount = 45_000; // ~4.5MB — over the content cap and the old hard maxBuffer ceiling.
    await writeFile(repo, 'huge.txt', line.repeat(lineCount));
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'add huge file'], { cwd: repo });
    await writeFile(repo, 'huge.txt', 'shrunk\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'shrink huge file'], { cwd: repo });
    const { stdout } = await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
    const commitId = stdout.trim();

    const result = await serviceFor(repo).structuredFileDiff({
      commitId,
      mode: 'commit',
      path: 'huge.txt',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content.kind).toBe('hunks-only');
    if (result.value.content.kind !== 'hunks-only') {
      return;
    }
    expect(result.value.content.reason).toBe('over-cap-old');
  });

  it('range mode: a binary file — content kind "binary", hunks empty, additions/deletions null', async () => {
    const repo = await makeRepo();
    await fsPromises.writeFile(
      path.join(repo, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
    );
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'init binary'], { cwd: repo });
    const { stdout: baseStdout } = await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
    const baseRef = baseStdout.trim();
    await fsPromises.writeFile(
      path.join(repo, 'img.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x0e])
    );
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'edit binary'], { cwd: repo });

    const result = await serviceFor(repo).structuredFileDiff({
      baseRef,
      mode: 'range',
      path: 'img.png',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.content).toEqual({ kind: 'binary' });
    expect(result.value.hunks).toEqual([]);
    expect(result.value.additions).toBeNull();
    expect(result.value.deletions).toBeNull();
  });
});

describe('git service — forgeRepositoryContext (real repos, BST-1391 review)', () => {
  async function makeRepoWithCommit(prefix?: string): Promise<string> {
    const repo = await makeRepo(prefix);
    await writeFile(repo, 'README.md', '# repository\n');
    await execFixtureGit(['add', '.'], { cwd: repo });
    await execFixtureGit(['commit', '-qm', 'initial'], { cwd: repo });
    return repo;
  }

  async function currentBranch(repo: string): Promise<string> {
    const { stdout } = await execFixtureGit(['symbolic-ref', '--short', 'HEAD'], {
      cwd: repo,
    });
    return stdout.trim();
  }

  it('reports branch: null on a detached HEAD', async () => {
    const repo = await makeRepoWithCommit('brainstrike-git-forge-detached-');
    const { stdout: headSha } = await execFixtureGit(['rev-parse', 'HEAD'], { cwd: repo });
    await execFixtureGit(['checkout', '-q', '--detach', headSha.trim()], { cwd: repo });

    const result = await serviceFor(repo).forgeRepositoryContext();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.branch).toBeNull();
  });

  it('states a reason when the repository has no remotes', async () => {
    const repo = await makeRepoWithCommit('brainstrike-git-forge-noremote-');

    const result = await serviceFor(repo).forgeRepositoryContext();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.remoteUrl).toBeNull();
    expect(result.value.remoteReason).toBe('The repository has no git remotes.');
  });

  it('states a reason for multiple remotes with no "origin" (resolveDefaultRemote leaves it unconfigured)', async () => {
    const repo = await makeRepoWithCommit('brainstrike-git-forge-multiremote-');
    await execFixtureGit(['remote', 'add', 'upstream', 'https://example.com/upstream.git'], {
      cwd: repo,
    });
    await execFixtureGit(['remote', 'add', 'fork', 'https://example.com/fork.git'], {
      cwd: repo,
    });

    const result = await serviceFor(repo).forgeRepositoryContext();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.remoteUrl).toBeNull();
    expect(result.value.remoteReason).toBe(
      'The repository has 2 remotes and no "origin" — set a branch upstream to choose one.'
    );
  });

  it('states a reason when the branch tracks a configured remote that no longer exists', async () => {
    const repo = await makeRepoWithCommit('brainstrike-git-forge-unknownremote-');
    await execFixtureGit(['remote', 'add', 'origin', 'https://example.com/origin.git'], {
      cwd: repo,
    });
    const branch = await currentBranch(repo);
    await execFixtureGit(['config', `branch.${branch}.remote`, 'ghost'], { cwd: repo });

    const result = await serviceFor(repo).forgeRepositoryContext();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.remoteUrl).toBeNull();
    expect(result.value.remoteReason).toBe('current branch names unknown remote "ghost"');
  });

  it('states a reason when `git remote get-url` fails', async () => {
    const repo = await makeRepoWithCommit('brainstrike-git-forge-geturlfail-');
    await execFixtureGit(['remote', 'add', 'origin', 'https://example.com/origin.git'], {
      cwd: repo,
    });
    const failGetUrlRunner: GitCommandRunner = (params) => {
      if (params.args[0] === 'remote' && params.args[1] === 'get-url') {
        return Promise.resolve({
          exitCode: 1,
          stderr: "fatal: simulated get-url failure for 'origin'",
          stdout: '',
          timedOut: false,
        });
      }
      return fixtureGitRunner(params);
    };

    const result = await createGitService({
      cwd: repo,
      run: failGetUrlRunner,
    }).forgeRepositoryContext();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.remoteUrl).toBeNull();
    expect(result.value.remoteReason).toBe(
      'git could not read the URL of remote "origin": fatal: simulated get-url failure for \'origin\''
    );
  });

  // TDD (S5b): a successful `git remote get-url` exit with EMPTY stdout used
  // to pair `remoteUrl: ''` with `remoteReason: null`, violating the type's
  // own documented invariant ("remoteReason is non-null exactly when
  // remoteUrl is null") and sending '' into parseForgeRemote downstream.
  it('treats an empty `git remote get-url` stdout as a stated failure, never `remoteUrl: ""`', async () => {
    const repo = await makeRepoWithCommit('brainstrike-git-forge-emptyurl-');
    await execFixtureGit(['remote', 'add', 'origin', 'https://example.com/origin.git'], {
      cwd: repo,
    });
    const emptyGetUrlRunner: GitCommandRunner = (params) => {
      if (params.args[0] === 'remote' && params.args[1] === 'get-url') {
        return Promise.resolve({ exitCode: 0, stderr: '', stdout: '', timedOut: false });
      }
      return fixtureGitRunner(params);
    };

    const result = await createGitService({
      cwd: repo,
      run: emptyGetUrlRunner,
    }).forgeRepositoryContext();

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.remoteUrl).toBeNull();
    expect(result.value.remoteReason).toBe('git returned an empty URL for remote "origin"');
  });
});
