/**
 * Hermetic, fs-injected coverage for `git-inventory-discovery.ts`: bounded
 * walk (depth + concurrency), `.git` detection without descent, ignore-set
 * traversal, per-entry error containment, and the gitdir/commondir resolution
 * chain (including the fabricated-gitdir trust check). Every test drives a
 * FAKE in-memory `InventoryFs` — no real filesystem, no git spawn (this
 * module never spawns git).
 */
import path from 'node:path';
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
} from '../../src/git-workspace/git-inventory-discovery.ts';

/**
 * The native absolute path for a POSIX-spelled fixture path. The walk and the
 * resolvers build paths with `path.join`/`path.resolve`, so the fake keys and
 * every expectation use the same native spelling.
 */
function nativePath(fixturePath: string): string {
  return path.resolve(fixturePath);
}

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
      const childPath = path.join(dirPath, name);
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
    fs.addDir(nativePath('/root'), ['.git', 'src']);
    fs.addDir(nativePath('/root/.git'), ['HEAD', 'objects']);
    fs.addDir(nativePath('/root/src'), []);

    const result = await walkForGitEntries({
      fs,
      rootLabel: 'root-1',
      rootPath: nativePath('/root'),
    });

    expect(result.errors).toEqual([]);
    expect(result.gitEntries).toEqual([{ kind: 'dir', path: nativePath('/root/.git') }]);
    expect(fs.readdirCalls).not.toContain(nativePath('/root/.git'));
  });

  it('finds a `.git` FILE (linked worktree / submodule gitfile) without treating it as a directory', async () => {
    const fs = new FakeFs();
    fs.addDir(nativePath('/root'), ['.git']);
    fs.addFile(
      nativePath('/root/.git'),
      `gitdir: ${nativePath('/elsewhere/.git/worktrees/linked')}\n`
    );

    const result = await walkForGitEntries({
      fs,
      rootLabel: 'root-1',
      rootPath: nativePath('/root'),
    });

    expect(result.gitEntries).toEqual([{ kind: 'file', path: nativePath('/root/.git') }]);
  });

  it('never walks the files of a linked worktree or submodule checkout below its gitfile', async () => {
    const fs = new FakeFs();
    fs.addDir(nativePath('/root'), ['.git', 'worktrees']);
    fs.addDir(nativePath('/root/.git'), []);
    fs.addDir(nativePath('/root/worktrees'), ['agent-1']);
    fs.addDir(nativePath('/root/worktrees/agent-1'), ['.git', 'src']);
    fs.addFile(
      nativePath('/root/worktrees/agent-1/.git'),
      `gitdir: ${nativePath('/root/.git/worktrees/agent-1')}\n`
    );
    fs.addDir(nativePath('/root/worktrees/agent-1/src'), []);

    const result = await walkForGitEntries({
      fs,
      rootLabel: 'root-1',
      rootPath: nativePath('/root'),
    });

    expect(result.gitEntries).toEqual([
      { kind: 'dir', path: nativePath('/root/.git') },
      { kind: 'file', path: nativePath('/root/worktrees/agent-1/.git') },
    ]);
    expect(fs.readdirCalls).not.toContain(nativePath('/root/worktrees/agent-1/src'));
  });

  it('skips ignored directory names but keeps descending into ordinary ones (repos nested below other repos)', async () => {
    const fs = new FakeFs();
    fs.addDir(nativePath('/root'), ['node_modules', 'src']);
    fs.addDir(nativePath('/root/node_modules'), ['.git']); // must NOT be found
    fs.addDir(nativePath('/root/node_modules/.git'), []);
    fs.addDir(nativePath('/root/src'), ['nested-worktree']);
    fs.addDir(nativePath('/root/src/nested-worktree'), ['.git']); // nested agent worktree — must be found
    fs.addDir(nativePath('/root/src/nested-worktree/.git'), []);

    const result = await walkForGitEntries({
      fs,
      rootLabel: 'root-1',
      rootPath: nativePath('/root'),
    });

    expect(result.gitEntries).toEqual([
      { kind: 'dir', path: nativePath('/root/src/nested-worktree/.git') },
    ]);
    expect(fs.readdirCalls).not.toContain(nativePath('/root/node_modules'));
  });

  it('bounds descent to maxDepth levels below the root (default 6)', async () => {
    const fs = new FakeFs();
    // Build a single-branch NESTED chain root -> d1 -> d2 -> ... -> d9 (each
    // `dN` lives INSIDE the previous one), each level holding a `.git`
    // DIRECTORY marker at that depth plus the next level down.
    const dirPathsByDepth: string[] = [nativePath('/root')];
    for (let depth = 1; depth <= 9; depth += 1) {
      dirPathsByDepth.push(path.join(dirPathsByDepth[depth - 1] as string, `d${depth}`));
    }
    for (let depth = 0; depth <= 9; depth += 1) {
      const dirPath = dirPathsByDepth[depth] as string;
      const nextChildName = depth < 9 ? [`d${depth + 1}`] : [];
      fs.addDir(dirPath, ['.git', ...nextChildName]);
      fs.addDir(path.join(dirPath, '.git'), []);
    }

    const result = await walkForGitEntries({
      fs,
      rootLabel: 'root-1',
      rootPath: nativePath('/root'),
    });

    expect(DEFAULT_WALK_MAX_DEPTH).toBe(6);
    // depths 0..6 => root + d1..d6 = 7 `.git` markers found.
    expect(result.gitEntries).toHaveLength(7);
    expect(
      findEntry(result.gitEntries, path.join(dirPathsByDepth[6] as string, '.git'))
    ).toBeDefined();
    expect(
      findEntry(result.gitEntries, path.join(dirPathsByDepth[7] as string, '.git'))
    ).toBeUndefined();
    // d7 itself was never even listed — the walk stopped BEFORE descending.
    expect(fs.readdirCalls).not.toContain(dirPathsByDepth[7]);
  });

  it('bounds concurrent readdir calls to maxConcurrency', async () => {
    const fs = new FakeFs();
    const siblingNames = Array.from({ length: 40 }, (_, index) => `sib${index}`);
    fs.addDir(nativePath('/root'), siblingNames);
    for (const name of siblingNames) {
      fs.addDir(path.join(nativePath('/root'), name), []);
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
      rootPath: nativePath('/root'),
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
      fs.addDir(nativePath(`/${prefix}root`), names);
      for (const name of names) {
        fs.addDir(path.join(nativePath(`/${prefix}root`), name), []);
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
        rootPath: nativePath('/aroot'),
        semaphore,
      }),
      walkForGitEntries({
        fs: fsB,
        maxConcurrency: 4,
        rootLabel: 'root-b',
        rootPath: nativePath('/broot'),
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
    fs.addDir(nativePath('/root'), names);
    for (const name of names) {
      fs.addDir(path.join(nativePath('/root'), name), []);
    }
    const controller = new AbortController();
    const started: string[] = [];
    const { promise: childHolding, resolve: markChildHolding } = Promise.withResolvers<void>();
    const { promise: childReleased, resolve: releaseChild } = Promise.withResolvers<void>();
    const originalReaddir = fs.readdir.bind(fs);
    fs.readdir = async (dirPath: string) => {
      started.push(dirPath);
      if (dirPath !== nativePath('/root')) {
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
      rootPath: nativePath('/root'),
      signal: controller.signal,
    });
    await childHolding;
    controller.abort();
    releaseChild();
    const result = await walking;

    // The nine siblings queued behind the held permit never issue a readdir,
    // and an abort is not reported as a directory failure.
    expect(started).toEqual([nativePath('/root'), nativePath('/root/d0')]);
    expect(result.errors).toEqual([]);
  });

  it('contains a per-entry readdir failure to that entry — sibling directories are still walked', async () => {
    const fs = new FakeFs();
    fs.addDir(nativePath('/root'), ['broken', 'ok']);
    // 'broken' is listed as a child of /root but has NO registered node, so
    // readdir(nativePath('/root/broken')) throws ENOENT.
    fs.addDir(nativePath('/root/ok'), ['.git']);
    fs.addDir(nativePath('/root/ok/.git'), []);
    // Force readdir(nativePath('/root/broken')) to look like a directory to its parent by
    // registering it, then delete its own listing to simulate a race/permission failure.
    fs.addDir(nativePath('/root/broken'), []);
    const originalReaddir = fs.readdir.bind(fs);
    fs.readdir = async (dirPath: string) => {
      if (dirPath === nativePath('/root/broken')) {
        throw new Error('EACCES: permission denied');
      }
      return await originalReaddir(dirPath);
    };

    const result = await walkForGitEntries({
      fs,
      rootLabel: 'root-1',
      rootPath: nativePath('/root'),
    });

    expect(result.gitEntries).toEqual([{ kind: 'dir', path: nativePath('/root/ok/.git') }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('root-1');
    expect(result.errors[0]).toContain(nativePath('/root/broken'));
    expect(result.errors[0]).toContain('permission denied');
  });
});

describe('resolveCommonDir', () => {
  it('resolves a `.git` DIRECTORY entry to its own realpath', async () => {
    const fs = new FakeFs();
    fs.addDir(nativePath('/repo/.git'), []);
    fs.setRealpath(nativePath('/repo/.git'), nativePath('/real/repo/.git'));

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'dir',
      gitEntryPath: nativePath('/repo/.git'),
    });

    expect(result).toEqual({ ok: true, value: nativePath('/real/repo/.git') });
  });

  it('resolves a linked-worktree gitfile through its gitdir pointer AND commondir file', async () => {
    const fs = new FakeFs();
    fs.addFile(
      nativePath('/repo-linked/.git'),
      `gitdir: ${nativePath('/main-repo/.git/worktrees/linked')}\n`
    );
    fs.addDir(nativePath('/main-repo/.git/worktrees/linked'), ['commondir']);
    fs.addFile(nativePath('/main-repo/.git/worktrees/linked/commondir'), '../..\n');
    fs.setRealpath(
      nativePath('/main-repo/.git/worktrees/linked'),
      nativePath('/main-repo/.git/worktrees/linked')
    );
    fs.setRealpath(nativePath('/main-repo/.git'), nativePath('/main-repo/.git'));

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'file',
      gitEntryPath: nativePath('/repo-linked/.git'),
    });

    expect(result).toEqual({ ok: true, value: nativePath('/main-repo/.git') });
  });

  it('resolves a submodule gitfile (no commondir file) to its own gitdir — not a fallback guess', async () => {
    const fs = new FakeFs();
    fs.addFile(nativePath('/superproject/sub/.git'), 'gitdir: ../.git/modules/sub\n');
    fs.addDir(nativePath('/superproject/.git/modules/sub'), ['HEAD']);
    fs.setRealpath(
      nativePath('/superproject/.git/modules/sub'),
      nativePath('/superproject/.git/modules/sub')
    );

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'file',
      gitEntryPath: nativePath('/superproject/sub/.git'),
    });

    expect(result).toEqual({ ok: true, value: nativePath('/superproject/.git/modules/sub') });
  });

  it('errors on a gitfile with no recognizable "gitdir:" pointer', async () => {
    const fs = new FakeFs();
    fs.addFile(nativePath('/repo/.git'), 'not-a-gitdir-pointer\n');

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'file',
      gitEntryPath: nativePath('/repo/.git'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(nativePath('/repo/.git'));
      expect(result.error.message).toContain('gitdir:');
    }
  });

  it('errors when the gitdir pointer target does not resolve', async () => {
    const fs = new FakeFs();
    fs.addFile(nativePath('/repo/.git'), `gitdir: ${nativePath('/nowhere/.git/worktrees/x')}\n`);

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'file',
      gitEntryPath: nativePath('/repo/.git'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(nativePath('/repo/.git'));
    }
  });

  it('errors when a present commondir file does not resolve', async () => {
    const fs = new FakeFs();
    fs.addFile(
      nativePath('/repo-linked/.git'),
      `gitdir: ${nativePath('/main-repo/.git/worktrees/linked')}\n`
    );
    fs.addDir(nativePath('/main-repo/.git/worktrees/linked'), ['commondir']);
    fs.addFile(
      nativePath('/main-repo/.git/worktrees/linked/commondir'),
      `${nativePath('/does/not/exist')}\n`
    );
    fs.setRealpath(
      nativePath('/main-repo/.git/worktrees/linked'),
      nativePath('/main-repo/.git/worktrees/linked')
    );

    const result = await resolveCommonDir({
      fs,
      gitEntryKind: 'file',
      gitEntryPath: nativePath('/repo-linked/.git'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('commondir');
    }
  });
});

describe('resolveGitEntryAtWorktree (bidirectional trust check)', () => {
  it('resolves a genuine linked worktree back to its common dir', async () => {
    const fs = new FakeFs();
    fs.addFile(
      nativePath('/linked-worktree/.git'),
      `gitdir: ${nativePath('/main-repo/.git/worktrees/linked')}\n`
    );
    fs.addDir(nativePath('/main-repo/.git/worktrees/linked'), ['commondir']);
    fs.addFile(nativePath('/main-repo/.git/worktrees/linked/commondir'), '../..\n');
    fs.setRealpath(
      nativePath('/main-repo/.git/worktrees/linked'),
      nativePath('/main-repo/.git/worktrees/linked')
    );
    fs.setRealpath(nativePath('/main-repo/.git'), nativePath('/main-repo/.git'));

    const result = await resolveGitEntryAtWorktree({
      fs,
      worktreePath: nativePath('/linked-worktree'),
    });

    expect(result).toEqual({ ok: true, value: nativePath('/main-repo/.git') });
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
    fs.addDir(nativePath('/attack-target'), ['some-file.txt']);
    fs.addFile(nativePath('/attack-target/some-file.txt'), 'should never be read');

    const result = await resolveGitEntryAtWorktree({
      fs,
      worktreePath: nativePath('/attack-target'),
    });

    const gitPath = nativePath('/attack-target/.git');
    expect(result).toEqual({
      error: expect.objectContaining({
        message: `could not stat "${gitPath}": ENOENT: no such file or directory '${gitPath}'`,
      }),
      ok: false,
    });
    expect(fs.readdirCalls).not.toContain(nativePath('/attack-target'));
    expect(fs.readFileCalls).toEqual([]);
  });

  it('fails validation for a fabricated-gitdir target whose ".git" points at an unrelated repo', async () => {
    const fs = new FakeFs();
    fs.addDir(nativePath('/attack-target/.git'), []);
    fs.setRealpath(nativePath('/attack-target/.git'), nativePath('/attack-target/.git'));

    const result = await resolveGitEntryAtWorktree({
      fs,
      worktreePath: nativePath('/attack-target'),
    });

    // Resolves successfully to ITS OWN common dir, which the caller compares
    // against the expected one and finds a mismatch — proven at the service
    // layer (git-inventory.integration.test.ts). Here we only prove discovery
    // reports the target's own true common dir without touching more than
    // its `.git`.
    expect(result).toEqual({ ok: true, value: nativePath('/attack-target/.git') });
    expect(fs.readdirCalls).not.toContain(nativePath('/attack-target'));
    expect(fs.readFileCalls).toEqual([]);
  });
});
