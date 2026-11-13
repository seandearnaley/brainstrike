/**
 * Git's patch, end to end against real repositories (ADR-0036): what the
 * renderer draws is git's own patch, so it must apply to the old side, count
 * the same lines as numstat, read the same in the view as in the file's own
 * diff and in the snapshot engine, survive a hostile git config, and still
 * parse when cut to its bound. The generated property runs in four parts:
 * here and in structured-diff-patch-{2,3,4}.test.ts.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveGitScopeChangesetView } from '../../src/git-workspace/changeset-git-scope.ts';
import { PATCH_BOUND, pinnedPatchArgs } from '../../src/git-workspace/structured-diff-content.ts';
import { parsePatch } from './patch-test-support.ts';
import {
  applied,
  checkPatchAgreement,
  deps,
  fileDiff,
  git,
  patchOf,
  removeTempDirs,
  repoWith,
  snapshotDiffs,
  uncommitted,
  view,
} from './structured-diff-patch-test-support.ts';

afterEach(removeTempDirs);

describe("git's patch is the diff the user sees", () => {
  it('applies to the old side, counts what numstat counts, and reads the same in the view and the snapshot engine (part 1 of 4)', async () => {
    await checkPatchAgreement();
  });
});

const HOSTILE_CONFIG = `[color]
\tui = always
\tdiff = always
[core]
\tquotePath = true
\tabbrev = 12
[diff]
\tnoprefix = true
\tmnemonicPrefix = true
\tsuppressBlankEmpty = true
\tcontext = 0
\tinterHunkContext = 10
\talgorithm = patience
\tindentHeuristic = false
\tsubmodule = log
\texternal = echo EXTERNAL
[diff "evil"]
\ttextconv = sed s/^/TEXTCONV:/
\tcommand = echo DRIVER
`;

describe('a hostile git config', () => {
  it('cannot change a byte of the patch, the counts or the view', async () => {
    const lines = Array.from({ length: 40 }, (_, index) =>
      index % 5 === 0 ? '' : `line ${index}`
    );
    const before = `${lines.join('\n')}\n`;
    const after = before.replace('line 3\n', 'line three\n').replace('line 14\n', 'fourteen\n');
    // Pairs where `diff.algorithm=patience` counts other lines than myers, and
    // where `diff.indentHeuristic=false` slides the hunk.
    const algorithm = ['x\nb\nc\nc\nc\na\nc\ny\nc\ny\n\n', 'c\na\na\nb\nc\nx\n'] as const;
    const heuristic = ['x\n}\n\nb\nc\nb\na\n}\n', '\nb\na\n'] as const;
    async function outcome(hostile: boolean) {
      const dir = await repoWith({
        'algorithm.txt': algorithm[0],
        'f.txt': before,
        'heuristic.txt': heuristic[0],
        'naïve.txt': 'one\ntwo\n',
        'old.txt': before,
      });
      const sub = path.join(dir, 'sub');
      await mkdir(sub);
      git(sub, ['init', '-q']);
      await writeFile(path.join(sub, 'one.txt'), 'one\n');
      git(sub, ['add', '-A']);
      git(sub, ['commit', '-q', '-m', 'one']);
      git(dir, ['-c', 'advice.addEmbeddedRepo=false', 'add', 'sub']);
      git(dir, ['commit', '-q', '-m', 'sub']);
      if (hostile) {
        await appendFile(path.join(dir, '.git', 'config'), HOSTILE_CONFIG);
        await writeFile(path.join(dir, '.git', 'info', 'attributes'), '* diff=evil\n');
      }
      const diffs = await snapshotDiffs(
        dir,
        async () => {
          await writeFile(path.join(dir, 'algorithm.txt'), algorithm[1]);
          await writeFile(path.join(dir, 'f.txt'), after);
          await writeFile(path.join(dir, 'heuristic.txt'), heuristic[1]);
          await writeFile(path.join(dir, 'naïve.txt'), 'one\n\ntwo\n');
          await writeFile(path.join(dir, 'notes new.txt'), 'fresh\n\n');
          git(dir, ['mv', 'old.txt', 'renamed.txt']);
          await writeFile(path.join(dir, 'renamed.txt'), after);
          await writeFile(path.join(sub, 'one.txt'), 'two\n');
          git(sub, ['commit', '-q', '-am', 'two']);
        },
        hostile ? HOSTILE_CONFIG : ''
      );
      const listing = await view(dir);
      return {
        diffs,
        // A submodule's own diff is not under test: git-scope reads its sides as blobs.
        files: await Promise.all(
          listing.files
            .filter((file) => file.path !== 'sub')
            .map((file) => fileDiff(dir, file.path))
        ),
        view: listing.files.map(({ repositoryRoot: _root, worktreePath: _tree, ...file }) => file),
      };
    }
    const [clean, hostile] = await Promise.all([outcome(false), outcome(true)]);

    expect(hostile).toEqual(clean);
    const f = clean.files.find((file) => file.path === 'f.txt');
    expect(f && parsePatch(patchOf(f))).toEqual({ additions: 2, deletions: 2, hunks: 2 });
    expect(clean.view.map((file) => file.path)).toEqual([
      'algorithm.txt',
      'f.txt',
      'heuristic.txt',
      'naïve.txt',
      'renamed.txt',
      'sub',
      'notes new.txt',
    ]);
    for (const file of clean.view) {
      expect(file.patch).toMatch(/^diff --git a\//u);
      expect(file.patch).not.toContain('\u001b');
    }
  });
});

describe('an over-bound patch', () => {
  it('is cut after a whole hunk at the capture ceiling, still parses and applies, and the view leaves it to load on demand', async () => {
    // About 14,000 hunks: a patch past the runner's 4 MB capture ceiling.
    const lines = Array.from({ length: 140_000 }, (_, index) => `line ${index} ${'x'.repeat(28)}`);
    const before = `${lines.join('\n')}\n`;
    const after = `${lines.map((line, index) => (index % 10 === 5 ? `${line}!` : line)).join('\n')}\n`;
    const dir = await repoWith({ 'f.txt': before });
    const diffs = await snapshotDiffs(dir, async () => {
      await writeFile(path.join(dir, 'f.txt'), after);
    });
    const [diff, listing] = await Promise.all([fileDiff(dir, 'f.txt'), view(dir)]);
    const whole = git(dir, pinnedPatchArgs(['HEAD', '--', 'f.txt']));

    expect(diff).toMatchObject({ additions: 14_000, deletions: 14_000 });
    expect(diff.content).toMatchObject({
      kind: 'hunks-only',
      patchTruncated: true,
      reason: 'over-cap-both',
    });
    const patch = patchOf(diff);
    expect(patch.length).toBeGreaterThan(PATCH_BOUND);
    expect(whole.startsWith(patch)).toBe(true);
    expect(whole.slice(patch.length).startsWith('@@ ')).toBe(true);
    const parsed = parsePatch(patch);
    expect(parsed.hunks).toBeGreaterThan(0);
    expect(parsed.additions).toBeLessThan(14_000);
    const partial = await applied(patch, { 'f.txt': before }, 'f.txt');
    expect(after.startsWith(partial.slice(0, partial.lastIndexOf('!') + 1))).toBe(true);
    expect(listing.files).toEqual([
      expect.objectContaining({ additions: 14_000, deletions: 14_000, patch: null, path: 'f.txt' }),
    ]);
    expect(diffs.find((entry) => entry.path === 'f.txt')?.content).toEqual(diff.content);
  });

  it("a single hunk past the view's bound opens whole", async () => {
    const added = Array.from({ length: 30_000 }, (_, index) => `added ${index} ${'y'.repeat(30)}`);
    const dir = await repoWith({ 'keep.txt': 'keep\n' });
    await writeFile(path.join(dir, 'big.txt'), `${added.join('\n')}\n`);
    git(dir, ['add', 'big.txt']);

    const [diff, listing] = await Promise.all([fileDiff(dir, 'big.txt'), view(dir)]);

    expect(diff).toMatchObject({ additions: 30_000, content: { kind: 'full' }, deletions: 0 });
    expect(patchOf(diff).length).toBeGreaterThan(PATCH_BOUND);
    expect(parsePatch(patchOf(diff))).toMatchObject({ additions: 30_000, hunks: 1 });
    expect(listing.files).toEqual([
      expect.objectContaining({ additions: 30_000, patch: null, path: 'big.txt' }),
    ]);
  });
});

describe('a merge conflict', () => {
  it('names the conflicted file in the scopes that hold it, and leaves the uncommitted view whole', async () => {
    const dir = await repoWith({ 'c.txt': 'base\n', 'other.txt': 'x\n' });
    git(dir, ['checkout', '-q', '-b', 'side']);
    await writeFile(path.join(dir, 'c.txt'), 'side\n');
    git(dir, ['commit', '-qam', 'side']);
    git(dir, ['checkout', '-q', '-']);
    await writeFile(path.join(dir, 'c.txt'), 'ours\n');
    git(dir, ['commit', '-qam', 'ours']);
    expect(() => git(dir, ['merge', '-q', 'side'])).toThrow();
    await writeFile(path.join(dir, 'other.txt'), 'y\n');

    for (const kind of ['unstaged', 'staged'] as const) {
      const result = await resolveGitScopeChangesetView(deps(dir), 'root', {
        ...uncommitted(dir),
        scope: { kind },
      });
      expect(result).toMatchObject({ error: { code: 'changeset.unmerged-path' }, ok: false });
      expect(result.ok ? '' : result.error.message).toContain('c.txt');
    }
    expect((await view(dir)).files.map((file) => file.path)).toEqual(['c.txt', 'other.txt']);
  });
});
