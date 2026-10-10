/**
 * Real-git coverage for the W7 shadow-git SnapshotService (BST-1164 T0).
 *
 * Every test runs against REAL temp directories and the production
 * `execFileSnapshotGitRunner` — no mocking of git (house pattern of
 * `git-service.integration.test.ts`). The suite pins the plan's hard
 * invariants: the user's own `.git` is byte-identical across snapshots,
 * ignore semantics (work-tree `.gitignore` + shipped `info/exclude`),
 * shell-side-effect capture, restore round-trips with conflict gating and
 * empty-ancestor pruning bounded at the root, per-root serialization with
 * private index files, GC primitives, and the runner env-honor guard.
 *
 * MUTATION VERIFICATION (destructive restore seam; each mutation applied,
 * confirmed to fail the named test, then reverted — see the final report):
 * - Inverting the conflict gate in `snapshot-service.ts`'s `applyOneAction`
 *   (`currentHash !== expectedHash` → `===`) fails "reports a conflict for a
 *   path mutated after the pre-revert snapshot and leaves it untouched".
 * - Dropping the `pruneEmptyAncestorDirectories` call after a delete fails
 *   "restores the target tree byte-identically ..." (scaffold dirs survive).
 * - Corrupting the `nested-repo` outcome EITHER way — mislabeling it as
 *   `restored`, or dropping it from the outcome list entirely (silent skip;
 *   exhaustiveness assertion) — fails "skips nested repositories visibly".
 * - Dropping the `add -A` staging in `diffRefs`'s worktree mode fails
 *   "diffs the live worktree without a second snapshot" (added files vanish).
 * - Dropping the `update-ref` advance in `snapshot()` fails "serializes
 *   concurrent snapshots ..." (the second commit loses its parent).
 */

import { createHash } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SHADOW_INFO_EXCLUDE,
  type SnapshotGitCommandParams,
  type SnapshotGitCommandRunner,
  SnapshotGitError,
} from '../../assistant-server/snapshot-git';
import {
  createSnapshotService,
  type SnapshotService,
} from '../../assistant-server/snapshot-service';
import { execFixtureGit, fixtureSnapshotGitRunner } from './_git-fixture-environment';

const HEAVY_TIMEOUT_MS = 60_000;

const createdRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
  // realpath so the macOS /var → /private/var symlink never trips path math.
  const real = await fsPromises.realpath(dir);
  createdRoots.push(real);
  return real;
}

afterEach(async () => {
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop();
    if (dir) {
      await fsPromises.rm(dir, { force: true, recursive: true });
    }
  }
});

async function write(root: string, relative: string, content: string): Promise<void> {
  const absolute = path.join(root, relative);
  await fsPromises.mkdir(path.dirname(absolute), { recursive: true });
  await fsPromises.writeFile(absolute, content, 'utf8');
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFixtureGit(args, { cwd });
  return stdout;
}

async function initUserRepo(root: string): Promise<void> {
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@brainstrike.dev');
  await git(root, 'config', 'user.name', 'Brainstrike Test');
  await git(root, 'config', 'commit.gpgsign', 'false');
}

/** Recursive content+mtime fingerprint of a directory (symlinks by target). */
async function fingerprintDir(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(current: string): Promise<void> {
    const dirents = await fsPromises.readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolute = path.join(current, dirent.name);
      const relative = path.relative(dir, absolute);
      if (dirent.isDirectory()) {
        await visit(absolute);
      } else if (dirent.isSymbolicLink()) {
        result[relative] = `link:${await fsPromises.readlink(absolute)}`;
      } else {
        const [content, stats] = await Promise.all([
          fsPromises.readFile(absolute),
          fsPromises.lstat(absolute),
        ]);
        result[relative] = `${createHash('sha256').update(content).digest('hex')}:${stats.mtimeMs}`;
      }
    }
  }
  await visit(dir);
  return result;
}

interface Fixture {
  readonly baseDir: string;
  readonly root: string;
  readonly service: SnapshotService;
}

async function makeFixture(runner?: SnapshotGitCommandRunner): Promise<Fixture> {
  const baseDir = await makeTempDir('brainstrike-snap-base-');
  const root = await makeTempDir('brainstrike-snap-root-');
  const service = createSnapshotService({
    runner: runner ?? fixtureSnapshotGitRunner,
    snapshotsBaseDir: baseDir,
  });
  return { baseDir, root, service };
}

async function listSnapshotTreePaths(gitDir: string, oid: string): Promise<string[]> {
  const stdout = await git(os.tmpdir(), `--git-dir=${gitDir}`, 'ls-tree', '-r', '--name-only', oid);
  return stdout.split('\n').filter(Boolean);
}

describe('SnapshotService — shadow repo init and user-repo isolation', () => {
  it(
    'initializes on a plain (non-git) root and excludes node_modules/.DS_Store via info/exclude',
    async () => {
      const { baseDir, root, service } = await makeFixture();
      await write(root, 'a.txt', 'alpha\n');
      await write(root, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
      await write(root, '.DS_Store', 'junk\n');
      await write(root, 'src/b.txt', 'beta\n');

      const handle = await service.ensureShadowRepo({ path: root, rootId: 'plain-root' });
      expect(handle.gitDir).toBe(path.join(baseDir, 'plain-root', 'git'));
      const exclude = await fsPromises.readFile(
        path.join(handle.gitDir, 'info', 'exclude'),
        'utf8'
      );
      expect(exclude).toBe(SHADOW_INFO_EXCLUDE);

      const { commitOid } = await service.snapshot(handle, {
        kind: 'turn-start',
        threadId: 'thread-1',
      });
      const paths = await listSnapshotTreePaths(handle.gitDir, commitOid);
      expect(paths).toEqual(['a.txt', 'src/b.txt']);
      // No `.git` appeared in the user's folder — the shadow repo is invisible.
      await expect(fsPromises.stat(path.join(root, '.git'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    HEAVY_TIMEOUT_MS
  );

  it(
    "leaves a real git repo's own .git byte-identical (index, HEAD, refs, stash) and respects its .gitignore",
    async () => {
      const { root, service } = await makeFixture();
      await initUserRepo(root);
      await write(root, 'a.txt', 'alpha\n');
      await write(root, 'b.txt', 'beta\n');
      await write(root, '.gitignore', '*.log\n');
      await git(root, 'add', '.');
      await git(root, 'commit', '-q', '-m', 'base');
      // A stash, a staged change, and a dirty file: nontrivial index/refs state.
      await write(root, 'b.txt', 'beta-stashed\n');
      await git(root, 'stash', 'push', '-q');
      await write(root, 'b.txt', 'beta-staged\n');
      await git(root, 'add', 'b.txt');
      await write(root, 'a.txt', 'alpha-dirty\n');
      await write(root, 'secret.log', 'ignored\n');

      const before = await fingerprintDir(path.join(root, '.git'));
      const handle = await service.ensureShadowRepo({ path: root, rootId: 'git-root' });
      const { commitOid } = await service.snapshot(handle, {
        kind: 'turn-start',
        threadId: 'thread-1',
      });
      const after = await fingerprintDir(path.join(root, '.git'));

      expect(after).toEqual(before);
      const paths = await listSnapshotTreePaths(handle.gitDir, commitOid);
      // The DIRTY worktree state is captured; the .gitignore'd file is not.
      expect(paths).toEqual(['.gitignore', 'a.txt', 'b.txt']);
      const captured = await git(
        root,
        `--git-dir=${handle.gitDir}`,
        'cat-file',
        'blob',
        `${commitOid}:a.txt`
      );
      expect(captured).toBe('alpha-dirty\n');
    },
    HEAVY_TIMEOUT_MS
  );

  it('refuses a runner that does not honor per-command env — no silent shared index', async () => {
    const envBlindRunner: SnapshotGitCommandRunner = (params) =>
      fixtureSnapshotGitRunner({ ...params, env: undefined });
    const { root, service } = await makeFixture(envBlindRunner);
    await expect(service.ensureShadowRepo({ path: root, rootId: 'env-blind' })).rejects.toThrow(
      expect.objectContaining({ code: 'runner-env-unsupported' })
    );
  });

  it('rejects unsafe root ids and missing roots with typed errors', async () => {
    const { service } = await makeFixture();
    await expect(
      service.ensureShadowRepo({ path: os.tmpdir(), rootId: '../escape' })
    ).rejects.toThrow(SnapshotGitError);
    await expect(
      service.ensureShadowRepo({ path: path.join(os.tmpdir(), 'does-not-exist-xyz'), rootId: 'ok' })
    ).rejects.toThrow(expect.objectContaining({ code: 'root-unavailable' }));
  });
});

describe('SnapshotService — diffRefs', () => {
  async function buildDiffFixture(): Promise<{
    fixture: Fixture;
    handle: Awaited<ReturnType<SnapshotService['ensureShadowRepo']>>;
    s1: string;
  }> {
    const fixture = await makeFixture();
    const { root, service } = fixture;
    await write(root, 'modified.txt', 'before\n');
    await write(root, 'deleted.txt', 'doomed\n');
    const handle = await service.ensureShadowRepo({ path: root, rootId: 'diff-root' });
    const { commitOid: s1 } = await service.snapshot(handle, {
      kind: 'turn-start',
      threadId: 'thread-1',
    });
    // Mutations AFTER the snapshot, including a direct-fs "shell" write, a
    // deletion, a new directory tree, and a symlink.
    await write(root, 'modified.txt', 'after\n');
    await fsPromises.rm(path.join(root, 'deleted.txt'));
    await write(root, 'shell-created.txt', 'echoed by a shell\n');
    await write(root, 'deep/tree/new.txt', 'nested\n');
    await fsPromises.symlink('modified.txt', path.join(root, 'link.txt'));
    return { fixture, handle, s1 };
  }

  it(
    'reports adds, modifications, deletions, dir trees, and symlinks between two snapshots',
    async () => {
      const { fixture, handle, s1 } = await buildDiffFixture();
      const { commitOid: s2 } = await fixture.service.snapshot(handle, {
        kind: 'turn-end',
        runId: 'run-9',
        threadId: 'thread-1',
      });
      const diffs = await fixture.service.diffRefs(handle, s1, s2);
      const byPath = new Map(diffs.map((diff) => [diff.path, diff]));
      expect([...byPath.keys()].sort()).toEqual([
        'deep/tree/new.txt',
        'deleted.txt',
        'link.txt',
        'modified.txt',
        'shell-created.txt',
      ]);
      expect(byPath.get('modified.txt')).toMatchObject({
        content: { kind: 'full', newContent: 'after\n', oldContent: 'before\n' },
        status: 'modified',
      });
      expect(byPath.get('deleted.txt')).toMatchObject({
        content: { kind: 'full', newContent: null, oldContent: 'doomed\n' },
        status: 'deleted',
      });
      expect(byPath.get('shell-created.txt')).toMatchObject({
        additions: 1,
        content: { kind: 'full', newContent: 'echoed by a shell\n', oldContent: null },
        status: 'added',
      });
      expect(byPath.get('deep/tree/new.txt')).toMatchObject({ status: 'added' });
      // Symlinks diff as their link text (mode 120000), matching git itself.
      expect(byPath.get('link.txt')).toMatchObject({
        content: { kind: 'full', newContent: 'modified.txt', oldContent: null },
        status: 'added',
      });
      const modifiedHunks = byPath.get('modified.txt')?.hunks;
      expect(modifiedHunks).toEqual([{ newLines: 1, newStart: 1, oldLines: 1, oldStart: 1 }]);
      // The snapshot commit message is the JSON-encoded meta.
      const message = await git(
        fixture.root,
        `--git-dir=${handle.gitDir}`,
        'log',
        '-1',
        '--format=%B',
        s2
      );
      expect(JSON.parse(message.trim())).toEqual({
        kind: 'turn-end',
        runId: 'run-9',
        threadId: 'thread-1',
      });
    },
    HEAVY_TIMEOUT_MS
  );

  it(
    'diffs the live worktree without a second snapshot, identically to the ref pair',
    async () => {
      const { fixture, handle, s1 } = await buildDiffFixture();
      const worktreeDiffs = await fixture.service.diffRefs(handle, s1, { worktree: true });
      const { commitOid: s2 } = await fixture.service.snapshot(handle, {
        kind: 'turn-end',
        threadId: 'thread-1',
      });
      const refDiffs = await fixture.service.diffRefs(handle, s1, s2);
      expect(worktreeDiffs).toEqual(refDiffs);
      expect(worktreeDiffs.map((diff) => diff.path).sort()).toContain('shell-created.txt');
    },
    HEAVY_TIMEOUT_MS
  );
});

describe('SnapshotService — restore plans', () => {
  it(
    'restores the target tree byte-identically, deleting shell-created files and pruning their empty dirs bounded at the root',
    async () => {
      const { root, service } = await makeFixture();
      await write(root, 'modified.txt', 'target-content\n');
      await write(root, 'deleted-in-range.txt', 'must come back\n');
      await write(root, 'keep/keep.txt', 'kept\n');
      await fsPromises.symlink('modified.txt', path.join(root, 'link.txt'));
      const handle = await service.ensureShadowRepo({ path: root, rootId: 'restore-root' });
      const { commitOid: target } = await service.snapshot(handle, {
        kind: 'turn-start',
        threadId: 'thread-1',
      });

      // The "turn": edits, a deletion, a scaffolded tree, a shell-created
      // file, and a symlink retarget.
      await write(root, 'modified.txt', 'turn-content\n');
      await fsPromises.rm(path.join(root, 'deleted-in-range.txt'));
      await write(root, 'app/src/components/button.tsx', 'export const B = 1;\n');
      await write(root, 'shell-side-effect.txt', 'from a shell\n');
      await fsPromises.rm(path.join(root, 'link.txt'));
      await fsPromises.symlink('keep/keep.txt', path.join(root, 'link.txt'));

      const { commitOid: preRevert } = await service.snapshot(handle, {
        kind: 'pre-revert',
        threadId: 'thread-1',
      });
      const plan = await service.computeRestorePlan(handle, target, preRevert);
      const outcomes = await service.applyRestorePlan(handle, plan, {
        expectedPreRevertHashes: await service.snapshotFileHashes(handle, preRevert),
      });

      expect(outcomes).toHaveLength(plan.actions.length);
      expect(outcomes.every((outcome) => outcome.outcome !== 'conflict')).toBe(true);
      expect(outcomes.every((outcome) => outcome.outcome !== 'failed')).toBe(true);

      // Byte-identical to the target snapshot: the worktree diff is empty.
      expect(await service.diffRefs(handle, target, { worktree: true })).toEqual([]);
      expect(await fsPromises.readFile(path.join(root, 'modified.txt'), 'utf8')).toBe(
        'target-content\n'
      );
      expect(await fsPromises.readFile(path.join(root, 'deleted-in-range.txt'), 'utf8')).toBe(
        'must come back\n'
      );
      // Symlinks restore AS symlinks, with the target-side link text.
      const linkStats = await fsPromises.lstat(path.join(root, 'link.txt'));
      expect(linkStats.isSymbolicLink()).toBe(true);
      expect(await fsPromises.readlink(path.join(root, 'link.txt'))).toBe('modified.txt');
      // The scaffolded tree is gone INCLUDING its now-empty ancestors…
      await expect(fsPromises.stat(path.join(root, 'app'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // …while the root itself and unrelated dirs survive (boundary).
      expect((await fsPromises.stat(root)).isDirectory()).toBe(true);
      expect((await fsPromises.stat(path.join(root, 'keep'))).isDirectory()).toBe(true);
    },
    HEAVY_TIMEOUT_MS
  );

  it(
    'reports a conflict for a path mutated after the pre-revert snapshot and leaves it untouched',
    async () => {
      const { root, service } = await makeFixture();
      await write(root, 'conflict.txt', 'target\n');
      await write(root, 'clean.txt', 'target\n');
      const handle = await service.ensureShadowRepo({ path: root, rootId: 'conflict-root' });
      const { commitOid: target } = await service.snapshot(handle, {
        kind: 'turn-start',
        threadId: 'thread-1',
      });
      await write(root, 'conflict.txt', 'turn\n');
      await write(root, 'clean.txt', 'turn\n');
      const { commitOid: preRevert } = await service.snapshot(handle, {
        kind: 'pre-revert',
        threadId: 'thread-1',
      });
      // Mutated AFTER the pre-revert snapshot — the conflict gate must hold.
      await write(root, 'conflict.txt', 'mutated-after-pre-revert\n');

      const plan = await service.computeRestorePlan(handle, target, preRevert);
      const outcomes = await service.applyRestorePlan(handle, plan, {
        expectedPreRevertHashes: await service.snapshotFileHashes(handle, preRevert),
      });

      expect(outcomes).toHaveLength(plan.actions.length);
      const byPath = new Map(outcomes.map((outcome) => [outcome.path, outcome]));
      expect(byPath.get('conflict.txt')).toMatchObject({ outcome: 'conflict' });
      expect(byPath.get('clean.txt')).toMatchObject({ outcome: 'restored' });
      expect(await fsPromises.readFile(path.join(root, 'conflict.txt'), 'utf8')).toBe(
        'mutated-after-pre-revert\n'
      );
      expect(await fsPromises.readFile(path.join(root, 'clean.txt'), 'utf8')).toBe('target\n');
    },
    HEAVY_TIMEOUT_MS
  );

  it(
    'skips nested repositories visibly (gitlink entries) without touching them',
    async () => {
      const { root, service } = await makeFixture();
      await write(root, 'a.txt', 'target\n');
      const nested = path.join(root, 'nested');
      await fsPromises.mkdir(nested);
      await initUserRepo(nested);
      await write(root, 'nested/n.txt', 'n1\n');
      await git(nested, 'add', '.');
      await git(nested, 'commit', '-q', '-m', 'n1');
      const handle = await service.ensureShadowRepo({ path: root, rootId: 'nested-root' });
      const { commitOid: target } = await service.snapshot(handle, {
        kind: 'turn-start',
        threadId: 'thread-1',
      });
      // The turn advances the nested repo's commit — a gitlink change.
      await write(root, 'nested/n.txt', 'n2\n');
      await git(nested, 'add', '.');
      await git(nested, 'commit', '-q', '-m', 'n2');
      await write(root, 'a.txt', 'turn\n');
      const { commitOid: preRevert } = await service.snapshot(handle, {
        kind: 'pre-revert',
        threadId: 'thread-1',
      });

      const plan = await service.computeRestorePlan(handle, target, preRevert);
      const outcomes = await service.applyRestorePlan(handle, plan, {
        expectedPreRevertHashes: await service.snapshotFileHashes(handle, preRevert),
      });

      expect(outcomes).toHaveLength(plan.actions.length);
      const byPath = new Map(outcomes.map((outcome) => [outcome.path, outcome]));
      expect(byPath.get('nested')).toEqual({ outcome: 'skipped-nested-repo', path: 'nested' });
      expect(byPath.get('a.txt')).toMatchObject({ outcome: 'restored' });
      // The nested repo is untouched: still at its post-turn commit.
      expect(await fsPromises.readFile(path.join(root, 'nested', 'n.txt'), 'utf8')).toBe('n2\n');
    },
    HEAVY_TIMEOUT_MS
  );
});

describe('SnapshotService — concurrency and GC', () => {
  it(
    'serializes concurrent snapshots per root with distinct, cleaned-up private index files',
    async () => {
      const seenIndexFiles: string[] = [];
      const indexUseOrder: string[] = [];
      const recordingRunner: SnapshotGitCommandRunner = (params: SnapshotGitCommandParams) => {
        const indexFile = params.env?.['GIT_INDEX_FILE'];
        if (indexFile !== undefined) {
          seenIndexFiles.push(indexFile);
          if (indexUseOrder.at(-1) !== indexFile) {
            indexUseOrder.push(indexFile);
          }
        }
        return fixtureSnapshotGitRunner(params);
      };
      const { root, service } = await makeFixture(recordingRunner);
      await write(root, 'a.txt', 'v1\n');
      const handle = await service.ensureShadowRepo({ path: root, rootId: 'conc-root' });

      const [first, second] = await Promise.all([
        service.snapshot(handle, { kind: 'turn-start', threadId: 'thread-1' }),
        service.snapshot(handle, { kind: 'turn-end', threadId: 'thread-1' }),
      ]);

      // Two distinct private index files, never interleaved: the mutex makes
      // each op's commands a CONTIGUOUS block, so distinct index paths appear
      // exactly once each in first-use order.
      const distinct = [...new Set(seenIndexFiles)].filter(
        (file) => !file.endsWith('runner-env-probe-index')
      );
      expect(distinct).toHaveLength(2);
      expect(indexUseOrder.filter((file) => !file.endsWith('runner-env-probe-index'))).toHaveLength(
        2
      );
      // Serialized lineage: one snapshot is the other's parent.
      const parents = await git(
        root,
        `--git-dir=${handle.gitDir}`,
        'log',
        '--format=%H %P',
        'refs/snapshots/thread-1'
      );
      const lines = parents.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect([first.commitOid, second.commitOid].sort()).toEqual(
        lines.map((line) => line.split(' ')[0]).sort()
      );
      // Temp indexes are cleaned up.
      const leftover = (await fsPromises.readdir(handle.gitDir)).filter((name) =>
        name.startsWith('index-')
      );
      expect(leftover).toEqual([]);
    },
    HEAVY_TIMEOUT_MS
  );

  it.each([
    [
      'recursive',
      'thread-74da70cd-4f39-46de-81b3-56b7b5b1b416-b7a52f6c-7e72-4241-bf33-e5b9bbf1d93e-70950143-21e5-44b4-8aa0-b574d36ad961-55dbf797-1713-4fc6-b4e4-9e85f0453bb7',
    ],
    ['trailing-dot', 'abc.'],
  ])(
    'captures, inventories, restores and prunes %s identities without losing another writer',
    async (_kind, threadId) => {
      const { root, service } = await makeFixture();
      const handle = await service.ensureShadowRepo({ path: root, rootId: 'recursive-root' });
      await write(root, 'child.txt', 'before child');
      const before = await service.snapshot(handle, { kind: 'turn-start', threadId });
      await write(root, 'child.txt', 'child effect');
      const sibling = await service.snapshot(handle, { kind: 'turn-start', threadId: 'sibling' });
      await write(root, 'sibling.txt', 'independent sibling effect');
      const after = await service.snapshot(handle, { kind: 'turn-end', threadId });
      expect(new Set(await service.listSnapshotThreadIds(handle))).toEqual(
        new Set([threadId, 'sibling'])
      );
      const refs = (
        await git(root, `--git-dir=${handle.gitDir}`, 'for-each-ref', '--format=%(refname)')
      )
        .trim()
        .split('\n');
      expect(refs.some((ref) => ref.includes(threadId))).toBe(false);
      expect(refs.every((ref) => ref.split('/').every((part) => part.length <= 128))).toBe(true);
      expect(
        await git(root, `--git-dir=${handle.gitDir}`, 'show', '-s', '--format=%P', after.commitOid)
      ).toContain(before.commitOid);
      expect(
        await service.restorePathsFromSnapshot(handle, before.commitOid, [
          { expectAbsent: false, path: 'child.txt' },
        ])
      ).toEqual([{ outcome: 'restored', path: 'child.txt' }]);
      expect(await fsPromises.readFile(path.join(root, 'child.txt'), 'utf8')).toBe('before child');
      expect(await fsPromises.readFile(path.join(root, 'sibling.txt'), 'utf8')).toBe(
        'independent sibling effect'
      );
      expect(await service.pruneThread(handle, threadId)).toEqual({ deleted: true });
      expect(await service.listSnapshotThreadIds(handle)).toEqual(['sibling']);
      expect(await service.pruneThread(handle, threadId)).toEqual({ deleted: false });
      expect(
        await git(root, `--git-dir=${handle.gitDir}`, 'rev-parse', 'refs/snapshots/sibling')
      ).toContain(sibling.commitOid);
    }
  );

  it('refuses an encoded lineage whose commit belongs to another exact identity', async () => {
    const { root, service } = await makeFixture();
    const handle = await service.ensureShadowRepo({ path: root, rootId: 'integrity-root' });
    // More than 128 characters selects the encoded identity namespace.
    const threadId = 'long-native-child-'.repeat(12);
    await write(root, 'file.txt', 'content');
    await service.snapshot(handle, { kind: 'turn-start', threadId });
    const other = await service.snapshot(handle, { kind: 'turn-start', threadId: 'other' });
    const encodedRef = (
      await git(
        root,
        `--git-dir=${handle.gitDir}`,
        'for-each-ref',
        '--format=%(refname)',
        'refs/snapshot-identities/'
      )
    ).trim();
    await git(root, `--git-dir=${handle.gitDir}`, 'update-ref', encodedRef, other.commitOid);
    await expect(service.listSnapshotThreadIds(handle)).rejects.toThrow(
      'does not match its durable identity'
    );
    await expect(service.pruneThread(handle, threadId)).rejects.toThrow(
      'does not match its durable identity'
    );
    await expect(service.snapshot(handle, { kind: 'turn-end', threadId })).rejects.toThrow(
      'does not match its durable identity'
    );
    expect(await git(root, `--git-dir=${handle.gitDir}`, 'rev-parse', encodedRef)).toContain(
      other.commitOid
    );
    // Corruption refuses root inventory; it does not disable another verified lineage.
    await service.snapshot(handle, { kind: 'turn-end', threadId: 'other' });
    expect(await service.pruneThread(handle, 'other')).toEqual({ deleted: true });
    expect(await git(root, `--git-dir=${handle.gitDir}`, 'rev-parse', encodedRef)).toContain(
      other.commitOid
    );
  });

  it(
    'pruneThread deletes the thread ref; sweepOrphans removes dead roots and keeps live ones',
    async () => {
      const { baseDir, root, service } = await makeFixture();
      await write(root, 'a.txt', 'v1\n');
      const handle = await service.ensureShadowRepo({ path: root, rootId: 'live-root' });
      await service.snapshot(handle, { kind: 'turn-start', threadId: 'thread-1' });
      await service.snapshot(handle, { kind: 'turn-start', threadId: 'thread-2' });

      expect(await service.pruneThread(handle, 'thread-1')).toEqual({ deleted: true });
      expect(await service.pruneThread(handle, 'thread-1')).toEqual({ deleted: false });
      await expect(
        git(root, `--git-dir=${handle.gitDir}`, 'rev-parse', '--verify', 'refs/snapshots/thread-1')
      ).rejects.toThrow();
      // The other thread's lineage survives.
      await git(
        root,
        `--git-dir=${handle.gitDir}`,
        'rev-parse',
        '--verify',
        'refs/snapshots/thread-2'
      );

      // Orphan sweep: a dead root dir goes, the live one and stray files stay.
      await fsPromises.mkdir(path.join(baseDir, 'dead-root', 'git'), { recursive: true });
      await fsPromises.writeFile(path.join(baseDir, 'stray.txt'), 'not a root', 'utf8');
      const swept = await service.sweepOrphans(baseDir, ['live-root']);
      expect(swept).toEqual({ kept: ['live-root'], removed: ['dead-root'] });
      await expect(fsPromises.stat(path.join(baseDir, 'dead-root'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect((await fsPromises.stat(path.join(baseDir, 'live-root'))).isDirectory()).toBe(true);
      expect(await fsPromises.readFile(path.join(baseDir, 'stray.txt'), 'utf8')).toBe('not a root');
      expect(await service.sweepOrphans(path.join(baseDir, 'missing-base'), [])).toEqual({
        kept: [],
        removed: [],
      });
    },
    HEAVY_TIMEOUT_MS
  );
});
