/**
 * Hermetic, fs-injected coverage for `git-inventory-discovery.ts`: bounded
 * walk (depth + concurrency), `.git` detection without descent, ignore-set
 * traversal, per-entry error containment, and the gitdir/commondir resolution
 * chain (including the fabricated-gitdir trust check). Every test drives a
 * FAKE in-memory `InventoryFs` — no real filesystem, no git spawn (this
 * module never spawns git).
 */
import { describe, expect, it } from 'vitest';
import {
  createWalkSemaphore,
  DEFAULT_WALK_MAX_DEPTH,
  type DiscoveredGitEntry,
  type InventoryDirent,
  type InventoryFs,
  type InventoryStat,
  resolveCommonDir,
  resolveGitEntryAtWorktree,
  walkForGitEntries,
} from '../../assistant-server/git-inventory-discovery';

type FakeNode =
  | { readonly children: readonly string[]; readonly type: 'dir' }
  | { readonly content: string; readonly type: 'file' }
  | { readonly type: 'other' };

/** Minimal in-memory filesystem implementing exactly the `InventoryFs` contract. */
class FakeFs implements InventoryFs {
  private readonly nodes = new Map<string, FakeNode>();
  private readonly realpaths = new Map<string, string>();
  readonly readdirCalls: string[] = [];
  readonly readFileCalls: string[] = [];

  addDir(dirPath: string, children: readonly string[]): void {
    this.nodes.set(dirPath, { children, type: 'dir' });
  }

  addFile(filePath: string, content: string): void {
    this.nodes.set(filePath, { content, type: 'file' });
  }

  addOther(entryPath: string): void {
    this.nodes.set(entryPath, { type: 'other' });
  }

  setRealpath(fromPath: string, toPath: string): void {
    this.realpaths.set(fromPath, toPath);
  }

  async lstat(targetPath: string): Promise<InventoryStat> {
    const node = this.nodes.get(targetPath);
    if (!node) {
      throw enoent(targetPath);
    }
    return {
      isDirectory: () => node.type === 'dir',
      isFile: () => node.type === 'file',
    };
  }

  async readdir(dirPath: string): Promise<readonly InventoryDirent[]> {
    this.readdirCalls.push(dirPath);
    const node = this.nodes.get(dirPath);
    if (node?.type !== 'dir') {
      throw enoent(dirPath);
    }
    return node.children.map((name) => {
      const childPath = `${dirPath}/${name}`;
      const childNode = this.nodes.get(childPath);
      return {
        isDirectory: () => childNode?.type === 'dir',
        isFile: () => childNode?.type === 'file',
        name,
      };
    });
  }

  async readFile(filePath: string): Promise<string> {
    this.readFileCalls.push(filePath);
    const node = this.nodes.get(filePath);
    if (node?.type !== 'file') {
      throw enoent(filePath);
    }
    return node.content;
  }

  async realpath(targetPath: string): Promise<string> {
    const resolved = this.realpaths.get(targetPath) ?? targetPath;
    if (!(this.nodes.has(resolved) || this.realpaths.has(targetPath))) {
      // A path with no registered node and no explicit realpath mapping does
      // not "exist" in this fake — mirror real fs.realpath ENOENT behavior.
      throw enoent(targetPath);
    }
    return resolved;
  }
}

function enoent(targetPath: string): NodeJS.ErrnoException {
  const error = new Error(
    `ENOENT: no such file or directory '${targetPath}'`
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

function findEntry(
  entries: readonly DiscoveredGitEntry[],
  targetPath: string
): DiscoveredGitEntry | undefined {
  return entries.find((entry) => entry.path === targetPath);
}

describe('walkForGitEntries', () => {
  it('finds a `.git` directory at the root without descending into it', async () => {
    const fs = new FakeFs();
    fs.addDir('/root', ['.git', 'src']);
    fs.addDir('/root/.git', ['HEAD', 'objects']);
    fs.addDir('/root/src', []);

    const result = await walkForGitEntries({ fs, rootLabel: 'root-1', rootPath: '/root' });

    expect(result.errors).toEqual([]);
    expect(result.gitEntries).toEqual([{ kind: 'dir', path: '/root/.git' }]);
    expect(fs.readdirCalls).not.toContain('/root/.git');
  });

  it('finds a `.git` FILE (linked worktree / submodule gitfile) without treating it as a directory', async () => {
    const fs = new FakeFs();
    fs.addDir('/root', ['.git']);
    fs.addFile('/root/.git', 'gitdir: /elsewhere/.git/worktrees/linked\n');

    const result = await walkForGitEntries({ fs, rootLabel: 'root-1', rootPath: '/root' });

    expect(result.gitEntries).toEqual([{ kind: 'file', path: '/root/.git' }]);
  });

  it('skips ignored directory names but keeps descending into ordinary ones (repos nested below other repos)', async () => {
    const fs = new FakeFs();
    fs.addDir('/root', ['node_modules', 'src']);
    fs.addDir('/root/node_modules', ['.git']); // must NOT be found
    fs.addDir('/root/node_modules/.git', []);
    fs.addDir('/root/src', ['nested-worktree']);
    fs.addDir('/root/src/nested-worktree', ['.git']); // nested agent worktree — must be found
    fs.addDir('/root/src/nested-worktree/.git', []);

    const result = await walkForGitEntries({ fs, rootLabel: 'root-1', rootPath: '/root' });

    expect(result.gitEntries).toEqual([{ kind: 'dir', path: '/root/src/nested-worktree/.git' }]);
    expect(fs.readdirCalls).not.toContain('/root/node_modules');
  });

  it('bounds descent to maxDepth levels below the root (default 6)', async () => {
    const fs = new FakeFs();
    // Build a single-branch NESTED chain root -> d1 -> d2 -> ... -> d9 (each
    // `dN` lives INSIDE the previous one), each level holding a `.git`
    // DIRECTORY marker at that depth plus the next level down.
    const dirPathsByDepth: string[] = ['/root'];
    for (let depth = 1; depth <= 9; depth += 1) {
      dirPathsByDepth.push(`${dirPathsByDepth[depth - 1]}/d${depth}`);
    }
    for (let depth = 0; depth <= 9; depth += 1) {
      const dirPath = dirPathsByDepth[depth] as string;
      const nextChildName = depth < 9 ? [`d${depth + 1}`] : [];
      fs.addDir(dirPath, ['.git', ...nextChildName]);
      fs.addDir(`${dirPath}/.git`, []);
    }

    const result = await walkForGitEntries({ fs, rootLabel: 'root-1', rootPath: '/root' });

    expect(DEFAULT_WALK_MAX_DEPTH).toBe(6);
    // depths 0..6 => root + d1..d6 = 7 `.git` markers found.
    expect(result.gitEntries).toHaveLength(7);
    expect(findEntry(result.gitEntries, `${dirPathsByDepth[6]}/.git`)).toBeDefined();
    expect(findEntry(result.gitEntries, `${dirPathsByDepth[7]}/.git`)).toBeUndefined();
    // d7 itself was never even listed — the walk stopped BEFORE descending.
    expect(fs.readdirCalls).not.toContain(dirPathsByDepth[7]);
  });

  it('bounds concurrent readdir calls to maxConcurrency', async () => {
    const fs = new FakeFs();
    const siblingNames = Array.from({ length: 40 }, (_, index) => `sib${index}`);
    fs.addDir('/root', siblingNames);
    for (const name of siblingNames) {
      fs.addDir(`/root/${name}`, []);
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const originalReaddir = fs.readdir.bind(fs);
    fs.readdir = async (dirPath: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield once so overlapping concurrent calls actually stack before any
      // one of them resolves — otherwise synchronous-ish fakes never overlap.
      await Promise.resolve();
      try {
        return await originalReaddir(dirPath);
      } finally {
        inFlight -= 1;
      }
    };

    const result = await walkForGitEntries({
      fs,
      maxConcurrency: 4,
      rootLabel: 'root-1',
      rootPath: '/root',
    });

    expect(result.errors).toEqual([]);
    expect(maxInFlight).toBe(4);
  });

  it('shares ONE semaphore budget across multiple calls when a `semaphore` is passed in (BST-1112 review 3712386046 — the walk bound was per-root, not global)', async () => {
    // Two INDEPENDENT fake filesystems, standing in for two different
    // workspace roots — `git-inventory-service.ts`'s `buildInventorySnapshot`
    // calls `walkForGitEntries` once per root, all against the same
    // `InventoryFs` in production, but this module's own contract only cares
    // that a shared `semaphore` bounds calls TOGETHER regardless of which
    // `fs` each call uses.
    function makeSiblingFs(prefix: string): FakeFs {
      const fs = new FakeFs();
      const names = Array.from({ length: 20 }, (_, index) => `${prefix}${index}`);
      fs.addDir(`/${prefix}root`, names);
      for (const name of names) {
        fs.addDir(`/${prefix}root/${name}`, []);
      }
      return fs;
    }

    let inFlight = 0;
    let maxInFlight = 0;
    function wrapReaddir(fs: FakeFs): void {
      const original = fs.readdir.bind(fs);
      fs.readdir = async (dirPath: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Same yield-once trick as the single-call concurrency test below —
        // lets overlapping calls from BOTH roots actually stack.
        await Promise.resolve();
        try {
          return await original(dirPath);
        } finally {
          inFlight -= 1;
        }
      };
    }

    const fsA = makeSiblingFs('a');
    const fsB = makeSiblingFs('b');
    wrapReaddir(fsA);
    wrapReaddir(fsB);

    const semaphore = createWalkSemaphore(4);

    await Promise.all([
      walkForGitEntries({
        fs: fsA,
        maxConcurrency: 4,
        rootLabel: 'root-a',
        rootPath: '/aroot',
        semaphore,
      }),
      walkForGitEntries({
        fs: fsB,
        maxConcurrency: 4,
        rootLabel: 'root-b',
        rootPath: '/broot',
        semaphore,
      }),
    ]);

    // With two UNSHARED per-call semaphores (the pre-fix default, still what
    // happens when `semaphore` is omitted) this could reach 8 — each call's
    // own budget of 4, both roots running concurrently via `Promise.all`.
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it('drops readdirs still waiting for a permit once the walk is aborted, without recording errors', async () => {
    const fs = new FakeFs();
    const names = Array.from({ length: 10 }, (_, index) => `d${index}`);
    fs.addDir('/root', names);
    for (const name of names) {
      fs.addDir(`/root/${name}`, []);
    }
    const controller = new AbortController();
    const started: string[] = [];
    const { promise: childHolding, resolve: markChildHolding } = Promise.withResolvers<void>();
    const { promise: childReleased, resolve: releaseChild } = Promise.withResolvers<void>();
    const originalReaddir = fs.readdir.bind(fs);
    fs.readdir = async (dirPath: string) => {
      started.push(dirPath);
      if (dirPath !== '/root') {
        // The first child holds the only permit until the walk is aborted.
        markChildHolding();
        await childReleased;
      }
      return await originalReaddir(dirPath);
    };

    const walking = walkForGitEntries({
      fs,
      maxConcurrency: 1,
      rootLabel: 'root-1',
      rootPath: '/root',
      signal: controller.signal,
    });
    await childHolding;
    controller.abort();
    releaseChild();
    const result = await walking;

    // The nine siblings queued behind the held permit never issue a readdir,
    // and an abort is not reported as a directory failure.
    expect(started).toEqual(['/root', '/root/d0']);
    expect(result.errors).toEqual([]);
  });

  it('contains a per-entry readdir failure to that entry — sibling directories are still walked', async () => {
    const fs = new FakeFs();
    fs.addDir('/root', ['broken', 'ok']);
    // 'broken' is listed as a child of /root but has NO registered node, so
    // readdir('/root/broken') throws ENOENT.
    fs.addDir('/root/ok', ['.git']);
    fs.addDir('/root/ok/.git', []);
    // Force readdir('/root/broken') to look like a directory to its parent by
    // registering it, then delete its own listing to simulate a race/permission failure.
    fs.addDir('/root/broken', []);
    const originalReaddir = fs.readdir.bind(fs);
    fs.readdir = async (dirPath: string) => {
      if (dirPath === '/root/broken') {
        throw new Error('EACCES: permission denied');
      }
      return await originalReaddir(dirPath);
    };

    const result = await walkForGitEntries({ fs, rootLabel: 'root-1', rootPath: '/root' });

    expect(result.gitEntries).toEqual([{ kind: 'dir', path: '/root/ok/.git' }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('root-1');
    expect(result.errors[0]).toContain('/root/broken');
    expect(result.errors[0]).toContain('permission denied');
  });
});

describe('resolveCommonDir', () => {
  it('resolves a `.git` DIRECTORY entry to its own realpath', async () => {
    const fs = new FakeFs();
    fs.addDir('/repo/.git', []);
    fs.setRealpath('/repo/.git', '/real/repo/.git');

    const result = await resolveCommonDir({ fs, gitEntryKind: 'dir', gitEntryPath: '/repo/.git' });

    expect(result).toEqual({ ok: true, value: '/real/repo/.git' });
  });

  it('resolves a linked-worktree gitfile through its gitdir pointer AND commondir file', async () => {
    const fs = new FakeFs();
    fs.addFile('/repo-linked/.git', 'gitdir: /main-repo/.git/worktrees/linked\n');
    fs.addDir('/main-repo/.git/worktrees/linked', ['commondir']);
    fs.addFile('/main-repo/.git/worktrees/linked/commondir', '../..\n');
    fs.setRealpath('/main-repo/.git/worktrees/linked', '/main-repo/.git/worktrees/linked');
    fs.setRealpath('/main-repo/.git', '/main-repo/.git');

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'file',
      gitEntryPath: '/repo-linked/.git',
    });

    expect(result).toEqual({ ok: true, value: '/main-repo/.git' });
  });

  it('resolves a submodule gitfile (no commondir file) to its own gitdir — not a fallback guess', async () => {
    const fs = new FakeFs();
    fs.addFile('/superproject/sub/.git', 'gitdir: ../.git/modules/sub\n');
    fs.addDir('/superproject/.git/modules/sub', ['HEAD']);
    fs.setRealpath('/superproject/.git/modules/sub', '/superproject/.git/modules/sub');

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'file',
      gitEntryPath: '/superproject/sub/.git',
    });

    expect(result).toEqual({ ok: true, value: '/superproject/.git/modules/sub' });
  });

  it('errors on a gitfile with no recognizable "gitdir:" pointer', async () => {
    const fs = new FakeFs();
    fs.addFile('/repo/.git', 'not-a-gitdir-pointer\n');

    const result = await resolveCommonDir({ fs, gitEntryKind: 'file', gitEntryPath: '/repo/.git' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('/repo/.git');
      expect(result.error).toContain('gitdir:');
    }
  });

  it('errors when the gitdir pointer target does not resolve', async () => {
    const fs = new FakeFs();
    fs.addFile('/repo/.git', 'gitdir: /nowhere/.git/worktrees/x\n');

    const result = await resolveCommonDir({ fs, gitEntryKind: 'file', gitEntryPath: '/repo/.git' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('/repo/.git');
    }
  });

  it('errors when a present commondir file does not resolve', async () => {
    const fs = new FakeFs();
    fs.addFile('/repo-linked/.git', 'gitdir: /main-repo/.git/worktrees/linked\n');
    fs.addDir('/main-repo/.git/worktrees/linked', ['commondir']);
    fs.addFile('/main-repo/.git/worktrees/linked/commondir', '/does/not/exist\n');
    fs.setRealpath('/main-repo/.git/worktrees/linked', '/main-repo/.git/worktrees/linked');

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'file',
      gitEntryPath: '/repo-linked/.git',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('commondir');
    }
  });
});

describe('resolveGitEntryAtWorktree (bidirectional trust check)', () => {
  it('resolves a genuine linked worktree back to its common dir', async () => {
    const fs = new FakeFs();
    fs.addFile('/linked-worktree/.git', 'gitdir: /main-repo/.git/worktrees/linked\n');
    fs.addDir('/main-repo/.git/worktrees/linked', ['commondir']);
    fs.addFile('/main-repo/.git/worktrees/linked/commondir', '../..\n');
    fs.setRealpath('/main-repo/.git/worktrees/linked', '/main-repo/.git/worktrees/linked');
    fs.setRealpath('/main-repo/.git', '/main-repo/.git');

    const result = await resolveGitEntryAtWorktree({ fs, worktreePath: '/linked-worktree' });

    expect(result).toEqual({ ok: true, value: '/main-repo/.git' });
  });

  it('fails validation for a fabricated-gitdir target whose ".git" does not exist at all — and reads NOTHING else under the target', async () => {
    const fs = new FakeFs();
    // The attack target directory exists on disk WITH unrelated real
    // content — it is not a real linked worktree of the repo under test (it
    // has no `.git` of its own). Only `<target>/.git`'s absence is checked.
    // Asserted DIRECTLY below via the fake's call log — a mutation that reads
    // every entry under the target (e.g. an added `readdir` + `readFile`
    // sweep) would sail through silently if that content happened to be
    // registered, so relying on an incidental unhandled ENOENT rejection
    // (the previous version of this comment's claim) is not proof.
    fs.addDir('/attack-target', ['some-file.txt']);
    fs.addFile('/attack-target/some-file.txt', 'should never be read');

    const result = await resolveGitEntryAtWorktree({ fs, worktreePath: '/attack-target' });

    expect(result).toEqual({
      error:
        'could not stat "/attack-target/.git": ENOENT: no such file or directory \'/attack-target/.git\'',
      ok: false,
    });
    expect(fs.readdirCalls).not.toContain('/attack-target');
    expect(fs.readFileCalls).toEqual([]);
  });

  it('fails validation for a fabricated-gitdir target whose ".git" points at an unrelated repo', async () => {
    const fs = new FakeFs();
    fs.addDir('/attack-target/.git', []);
    fs.setRealpath('/attack-target/.git', '/attack-target/.git');

    const result = await resolveGitEntryAtWorktree({ fs, worktreePath: '/attack-target' });

    // Resolves successfully to ITS OWN common dir, which the caller compares
    // against the expected one and finds a mismatch — proven at the service
    // layer (git-inventory.integration.test.ts). Here we only prove discovery
    // reports the target's own true common dir without touching more than
    // its `.git`.
    expect(result).toEqual({ ok: true, value: '/attack-target/.git' });
    expect(fs.readdirCalls).not.toContain('/attack-target');
    expect(fs.readFileCalls).toEqual([]);
  });
});
