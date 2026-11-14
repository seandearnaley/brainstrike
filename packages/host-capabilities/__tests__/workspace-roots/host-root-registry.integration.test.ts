import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  type HostThreadReads,
  hostProjectHooksPath,
  readHostHookApproval,
  readHostWorkspaceTrust,
  trustHostHooks,
  writeHostWorkspaceTrust,
} from '@brainstrike/agent-host';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import {
  StateStore,
  StateStoreReadOnlyError,
  StateStoreRefusalError,
  type WorkspaceRootRequest,
} from '@brainstrike/state-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceRootPins } from '../../src/workspace-files/root-pins.ts';
import {
  createHostRootRegistry,
  type HostRootRegistryOwner,
  type HostRootRegistryStore,
} from '../../src/workspace-roots/index.ts';

let base: string;
let store: StateStore;
const owners: HostRootRegistryOwner[] = [];

beforeEach(async () => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'host-root-registry-')));
  store = await StateStore.open(path.join(base, 'profile'));
});

afterEach(async () => {
  for (const owner of owners.splice(0)) {
    await owner.close();
  }
  await store.close();
  rmSync(base, { force: true, recursive: true });
});

function folder(name: string): string {
  const created = path.join(base, name);
  mkdirSync(created);
  return created;
}

function registry(
  options: {
    readonly e2e?: boolean;
    readonly picked?: string | null;
    /** Folders the picker answers in turn, then a cancel. */
    readonly picks?: string[];
    readonly rootsStore?: HostRootRegistryStore;
  } = {}
) {
  const publishRootsChanged = vi.fn(async () => undefined);
  const owner = createHostRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    e2e: options.e2e ?? false,
    evictLspServersForRoot: async () => undefined,
    managedWorktreeAuthorizer: async () => 'unmanaged',
    pickFolder: async () =>
      options.picks ? (options.picks.shift() ?? null) : (options.picked ?? null),
    publishRootsChanged,
    store: options.rootsStore ?? store,
  });
  owners.push(owner);
  return { owner, publishRootsChanged };
}

/** ADR-0029 stage 4: the agent host owns the desktop workspace's open folders. */
describe('host root registry', () => {
  it('answers a cancelled pick with no folder and opens nothing', async () => {
    const { owner, publishRootsChanged } = registry({ picked: null });

    await expect(owner.service['workspace/roots/pick']({})).resolves.toEqual({ root: null });
    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({ roots: [] });
    expect(publishRootsChanged).not.toHaveBeenCalledWith(
      expect.objectContaining({ grantedPath: expect.anything() })
    );
  });

  it('opens a picked folder, tells Main, and reopens it from the recent folders without the picker', async () => {
    const workspace = folder('workspace');
    const { owner, publishRootsChanged } = registry({ picked: workspace });

    const { root } = await owner.service['workspace/roots/pick']({});
    expect(root).toMatchObject({ available: true, path: workspace });
    expect(publishRootsChanged).toHaveBeenLastCalledWith({
      grantedPath: workspace,
      recentPaths: [workspace],
    });
    await owner.service['workspace/roots/remove']({ rootId: root?.rootId ?? '' });
    expect((await owner.roots.listRoots()).map((entry) => entry.rootId)).toEqual([]);

    await expect(owner.service['workspace/roots/add']({ path: workspace })).resolves.toEqual(root);
  });

  it('opens a folder as the project: the others close, a running thread keeps its folder, and the picker can cancel', async () => {
    const [alpha, beta, gamma, delta] = ['alpha', 'beta', 'gamma', 'delta'].map(folder);
    const { owner } = registry({ picks: [alpha ?? '', beta ?? '', gamma ?? '', delta ?? ''] });
    const ids: string[] = [];
    for (let pick = 0; pick < 3; pick += 1) {
      const { root } = await owner.service['workspace/roots/pick']({});
      ids.push(root?.rootId ?? '');
    }
    const [alphaId, betaId, gammaId] = ids;
    // A thread is running in beta, admitted with it as its operating folder.
    const runStarted: HostLogRow = {
      event: {
        modelId: 'test-model',
        prompt: 'work',
        runId: 'run-beta',
        snapshot: {
          configuration: {},
          maxSteps: 1,
          toolIdentities: {},
          workspaceBinding: { operatingRootDisplayName: 'beta', operatingRootId: betaId ?? '' },
        },
        type: 'run.started',
      },
      seq: 1,
      threadId: 'thread-beta',
    };
    owner.attachThreadReads({
      listThreads: async () => [],
      read: async () => [runStarted],
      readLedger: async () =>
        ({
          threads: [{ runs: [{ runId: 'run-beta', status: 'running' }], threadId: 'thread-beta' }],
        }) as unknown as Awaited<ReturnType<HostThreadReads['readLedger']>>,
    });
    const openIds = async () =>
      (await store.workspaceRoots({ operation: 'list-open' })).roots.map((root) => root.id);

    await expect(owner.service['workspace/roots/open']({ path: alpha ?? '' })).resolves.toEqual({
      root: { available: true, path: alpha, rootId: alphaId, scratch: false, worktree: false },
    });
    expect(await openIds()).toEqual([alphaId]);
    // Beta left the open folders but its run still reads it; gamma is gone.
    const live = (await owner.roots.listRoots()).map((root) => root.rootId);
    expect(live.sort()).toEqual([alphaId, betaId].sort());
    // A window reload restores the open folders and keeps the run's folder mounted.
    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [{ available: true, path: alpha, rootId: alphaId, scratch: false, worktree: false }],
    });
    expect((await owner.roots.listRoots()).map((root) => root.rootId).sort()).toEqual(
      [alphaId, betaId].sort()
    );
    expect(owner.registry.mountedRoots().map((root) => root.rootId)).toContain(betaId);

    // A new folder through the picker replaces alpha; a cancelled pick changes nothing.
    const { root: opened } = await owner.service['workspace/roots/open']({});
    expect(opened).toMatchObject({ path: delta, scratch: false, worktree: false });
    expect(await openIds()).toEqual([opened?.rootId]);
    await expect(owner.service['workspace/roots/open']({})).resolves.toEqual({ root: null });
    expect(await openIds()).toEqual([opened?.rootId]);
    // Recents still hold every folder, gamma included, so it opens again with its identity.
    await expect(owner.service['workspace/roots/open']({ path: gamma ?? '' })).resolves.toEqual({
      root: { available: true, path: gamma, rootId: gammaId, scratch: false, worktree: false },
    });
  });

  it('opens only a recent folder by path', async () => {
    const stranger = folder('stranger');
    const { owner } = registry();
    owner.attachThreadReads({
      listThreads: async () => [],
      read: async () => [],
      readLedger: async () =>
        ({ threads: [] }) as unknown as Awaited<ReturnType<HostThreadReads['readLedger']>>,
    });

    await expect(owner.service['workspace/roots/open']({ path: stranger })).rejects.toMatchObject({
      failure: { code: 'workspace.never-granted' },
    });
    expect((await store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([]);
  });

  it('refuses to reopen a folder whose path now leads elsewhere, and shows it as needing reconnect', async () => {
    const workspace = folder('workspace');
    const outside = folder('outside');
    const first = registry({ picked: workspace });
    const { root } = await first.owner.service['workspace/roots/pick']({});
    await first.owner.close();
    owners.splice(owners.indexOf(first.owner), 1);
    renameSync(workspace, path.join(base, 'moved'));
    symlinkSync(outside, workspace);

    const { owner } = registry();
    await owner.start();

    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [
        {
          available: false,
          path: workspace,
          rootId: root?.rootId,
          scratch: false,
          worktree: false,
        },
      ],
    });
    expect(owner.registry.mountedRoots()).toEqual([]);
  });

  it('serves a folder picked again at its own path after the alias it was granted through is gone', async () => {
    const target = folder('target');
    writeFileSync(path.join(target, 'notes.txt'), 'kept');
    const alias = path.join(base, 'alias');
    symlinkSync(target, alias);
    const first = registry({ picked: alias });
    const { root: granted } = await first.owner.service['workspace/roots/pick']({});
    await first.owner.service['workspace/roots/remove']({ rootId: granted?.rootId ?? '' });
    unlinkSync(alias);

    const { owner } = registry({ picked: target });
    const { root } = await owner.service['workspace/roots/pick']({});

    expect(root).toEqual({
      available: true,
      path: target,
      rootId: granted?.rootId,
      scratch: false,
      worktree: false,
    });
    const pins = createWorkspaceRootPins({ mounts: owner.registry });
    const [live] = await pins.liveRoots();
    expect(live).toEqual({ path: target, rootId: granted?.rootId });
    const read = await pins.use(live ?? { path: target, rootId: '' }, (pinned) =>
      pinned.root.readFile('notes.txt', 64)
    );
    expect(read).toMatchObject({ status: 'ok' });
    expect(read.status === 'ok' && read.content.toString()).toBe('kept');
    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [
        { available: true, path: target, rootId: granted?.rootId, scratch: false, worktree: false },
      ],
    });
  });

  it('serves the open folders of a damaged store without writing to it, and refuses every change', async () => {
    const workspace = folder('workspace');
    const other = folder('other');
    const first = registry({ picked: workspace });
    const { root } = await first.owner.service['workspace/roots/pick']({});
    const rootId = root?.rootId ?? '';
    await first.owner.close();
    owners.splice(owners.indexOf(first.owner), 1);
    // BST-2144: a store that opened damaged is read-only; any write that reached it is recorded.
    const writes: string[] = [];
    const refuse = (write: string): never => {
      writes.push(write);
      throw new StateStoreReadOnlyError('fixture damage');
    };
    const damaged: HostRootRegistryStore = {
      deleteSetting: async (key) => refuse(`delete ${key}`),
      getSetting: (key) => store.getSetting(key),
      setSetting: async (key) => refuse(`set ${key}`),
      stateDamage: 'fixture damage',
      workspaceRoots: async (request: WorkspaceRootRequest) =>
        ['list', 'list-open', 'list-scratch', 'list-worktrees'].includes(request.operation)
          ? await store.workspaceRoots(request)
          : refuse(request.operation),
    };
    const picked = vi.fn(async () => other);
    const { owner } = registry({ rootsStore: damaged });
    const service = createHostRootRegistry({
      disposeCommandSessionsForRoot: async () => 0,
      e2e: true,
      evictLspServersForRoot: async () => undefined,
      managedWorktreeAuthorizer: async () => 'unmanaged',
      pickFolder: picked,
      publishRootsChanged: async () => undefined,
      store: damaged,
    });
    owners.push(service);

    await owner.start();
    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [{ available: true, path: workspace, rootId, scratch: false, worktree: false }],
    });
    await expect(owner.service['workspace/roots/recent']({})).resolves.toMatchObject({
      roots: [{ path: workspace }],
    });
    const projectId = (await store.workspaceRoots({ operation: 'list' })).roots[0]?.projectId ?? '';
    for (const change of [
      service.service['workspace/roots/pick']({}),
      owner.service['workspace/roots/add']({ path: other }),
      owner.service['workspace/roots/remove']({ rootId }),
      service.service['workspace/roots/seed-for-e2e']({
        recentPaths: [],
        roots: [{ path: other, rootId: crypto.randomUUID() }],
      }),
      owner.service['projects/rename']({ name: 'Renamed', projectId }),
      owner.service['projects/join']({ projectId, rootId }),
      service.service['workspace/roots/locate']({ rootId }),
    ]) {
      await expect(change).rejects.toBeInstanceOf(StateStoreReadOnlyError);
    }
    expect(picked).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(owner.registry.mountedRoots()).toEqual([
      { canonicalPath: workspace, path: workspace, rootId },
    ]);
  });

  it("mounts a thread's scratch folder, never as an open or recent folder, again after a restart, and makes none while a folder is open", async () => {
    mkdirSync(path.join(base, 'scratch'));
    const made = path.join(base, 'scratch', 'quiet-otter');
    const make = vi.fn(async () => {
      mkdirSync(made);
      return made;
    });
    const signal = new AbortController().signal;
    const { owner } = registry();

    const root = await owner.scratch.add({ make, signal, threadId: 'thread-1' });
    expect(root).toEqual({ displayName: 'quiet-otter', path: made, rootId: expect.any(String) });
    const rootId = root?.rootId ?? '';
    // Asked again, the thread's own folder is answered and no other is made.
    await expect(owner.scratch.add({ make, signal, threadId: 'thread-1' })).resolves.toEqual(root);
    expect(make).toHaveBeenCalledTimes(1);
    const scratchRoot = { available: true, path: made, rootId, scratch: true, worktree: false };
    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [scratchRoot],
    });
    expect((await store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([]);
    await expect(owner.service['workspace/roots/recent']({})).resolves.toEqual({ roots: [] });

    // A restart mounts it again for its thread, still neither open nor recent.
    await owner.close();
    const workspace = folder('workspace');
    const restarted = registry({ picked: workspace }).owner;
    await restarted.start();
    expect(restarted.registry.mountedRoots()).toEqual([
      { canonicalPath: made, path: made, rootId },
    ]);
    await expect(restarted.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [scratchRoot],
    });
    // A window shows it by its record, without the picker.
    await expect(restarted.service['workspace/roots/add']({ path: made })).resolves.toEqual(
      scratchRoot
    );
    // It is the thread's own: it never opens as the window's project.
    await expect(restarted.service['workspace/roots/open']({ path: made })).rejects.toThrow();
    await expect(restarted.service['workspace/roots/recent']({})).resolves.toEqual({ roots: [] });

    // With a folder open, a thread with none gets none made.
    await restarted.service['workspace/roots/pick']({});
    const other = vi.fn(async () => made);
    await expect(
      restarted.scratch.add({ make: other, signal, threadId: 'thread-2' })
    ).resolves.toBeNull();
    expect(other).not.toHaveBeenCalled();

    // Its thread deleted, it unmounts and its root and record go.
    await expect(restarted.scratch.forget('thread-1')).resolves.toEqual(root);
    expect(restarted.registry.mountedRoots().map((mounted) => mounted.path)).toEqual([workspace]);
    expect((await store.workspaceRoots({ operation: 'list' })).roots.map((r) => r.path)).toEqual([
      workspace,
    ]);
    await expect(restarted.scratch.read('thread-1')).resolves.toBeNull();
  });

  it('names a project and joins a folder to another, refusing what the store refuses', async () => {
    const [alpha, beta] = ['alpha', 'beta'].map(folder);
    const { owner } = registry({ picks: [alpha ?? '', beta ?? ''] });
    const { root: alphaRoot } = await owner.service['workspace/roots/pick']({});
    const { root: betaRoot } = await owner.service['workspace/roots/pick']({});
    const records = async () => (await store.workspaceRoots({ operation: 'list' })).roots;
    const [alphaRecord, betaRecord] = await records();
    const alphaProject = alphaRecord?.projectId ?? '';

    await expect(
      owner.service['projects/rename']({ name: ' Shared ', projectId: alphaProject })
    ).resolves.toBeNull();
    await expect(
      owner.service['projects/join']({ projectId: alphaProject, rootId: betaRoot?.rootId ?? '' })
    ).resolves.toBeNull();
    expect(await records()).toEqual([
      expect.objectContaining({
        id: alphaRoot?.rootId,
        projectId: alphaProject,
        projectName: 'Shared',
      }),
      expect.objectContaining({
        id: betaRoot?.rootId,
        projectId: alphaProject,
        projectName: 'Shared',
      }),
    ]);

    // Each refusal is the store's, with the code the host passes on; nothing changed.
    await expect(
      owner.service['projects/rename']({ name: 'x'.repeat(81), projectId: alphaProject })
    ).rejects.toMatchObject({ code: 'project.name-too-long' });
    await expect(
      owner.service['projects/rename']({ name: 'Gone', projectId: betaRecord?.projectId ?? '' })
    ).rejects.toMatchObject({ code: 'project.unknown' });
    await expect(
      owner.service['projects/join']({ projectId: alphaProject, rootId: 'no-such-root' })
    ).rejects.toBeInstanceOf(StateStoreRefusalError);
    expect((await records()).map((record) => record.projectName)).toEqual(['Shared', 'Shared']);
  });

  // BST-2511: a repository found inside an open folder has a project but no root, so it is named
  // by its own checkout's path, as the worktree listing names it.
  it('joins a repository found inside an open folder to another project by its path', async () => {
    const [alpha, beta] = ['alpha', 'beta'].map(folder);
    const { owner } = registry({ picks: [alpha ?? '', beta ?? ''] });
    await owner.service['workspace/roots/pick']({});
    await owner.service['workspace/roots/pick']({});
    const [alphaRecord, betaRecord] = (await store.workspaceRoots({ operation: 'list' })).roots;
    const repositoryPath = path.join(alpha ?? '', 'vendor', 'inner');
    const { project } = await store.workspaceRoots({
      canonicalPath: repositoryPath,
      operation: 'ensure-repository-project',
    });

    await expect(
      owner.service['projects/join']({ projectId: betaRecord?.projectId ?? '', repositoryPath })
    ).resolves.toBeNull();
    expect(
      (
        await store.workspaceRoots({
          canonicalPath: repositoryPath,
          operation: 'ensure-repository-project',
        })
      ).project
    ).toEqual({ id: betaRecord?.projectId, name: null });
    // The project it left had no other folder; the open folder that holds it keeps its own.
    await expect(
      owner.service['projects/rename']({ name: 'Gone', projectId: project?.id ?? '' })
    ).rejects.toMatchObject({ code: 'project.unknown' });
    expect((await store.workspaceRoots({ operation: 'list' })).roots[0]?.projectId).toBe(
      alphaRecord?.projectId
    );
    await expect(
      owner.service['projects/join']({
        projectId: betaRecord?.projectId ?? '',
        repositoryPath: path.join(alpha ?? '', 'never-found'),
      })
    ).rejects.toMatchObject({ code: 'project.folder-unknown' });
  });

  it("a folder joined to a project keeps its own trust and approved hooks, and takes none of the project's", async () => {
    const [alpha, beta] = ['alpha', 'beta'].map(folder);
    const hooks = '{"hooks":{}}';
    for (const each of [alpha, beta]) {
      mkdirSync(path.dirname(hostProjectHooksPath(each ?? '')), { recursive: true });
      writeFileSync(hostProjectHooksPath(each ?? ''), hooks);
    }
    const { owner } = registry({ picks: [alpha ?? '', beta ?? ''] });
    await owner.service['workspace/roots/pick']({});
    const { root: betaRoot } = await owner.service['workspace/roots/pick']({});
    const alphaProject = (await store.workspaceRoots({ operation: 'list' })).roots[0]?.projectId;
    const sha256 = createHash('sha256').update(hooks).digest('hex');
    await writeHostWorkspaceTrust(store, alpha ?? '', 'trusted');
    await trustHostHooks(store, { path: alpha ?? '', sha256 });
    await writeHostWorkspaceTrust(store, beta ?? '', 'restricted');

    await owner.service['projects/join']({
      projectId: alphaProject ?? '',
      rootId: betaRoot?.rootId ?? '',
    });

    // Joining is not proof that two folders are one: each answers for itself, as before.
    expect(await readHostWorkspaceTrust(store, beta ?? '')).toBe('restricted');
    expect(await readHostHookApproval(store, beta ?? '')).toBeUndefined();
    expect(await readHostWorkspaceTrust(store, alpha ?? '')).toBe('trusted');
    expect(await readHostHookApproval(store, alpha ?? '')).toBe(sha256);
  });

  it('a folder moved outside the app and picked at its new place is another folder, with a project of its own', async () => {
    const alpha = folder('alpha');
    const moved = path.join(base, 'moved-alpha');
    const first = registry({ picked: alpha });
    const { root } = await first.owner.service['workspace/roots/pick']({});
    await first.owner.close();
    owners.splice(owners.indexOf(first.owner), 1);
    renameSync(alpha, moved);

    const { owner } = registry({ picked: moved });
    await owner.start();
    const { root: picked } = await owner.service['workspace/roots/pick']({});

    expect(picked?.rootId).not.toBe(root?.rootId);
    const records = (await store.workspaceRoots({ operation: 'list' })).roots;
    expect(new Set(records.map((record) => record.projectId)).size).toBe(2);
  });

  it("Locate points a moved folder's record at its new place: its id and project follow, and its trust is asked again", async () => {
    const alpha = folder('alpha');
    const moved = path.join(base, 'moved-alpha');
    const first = registry({ picked: alpha });
    const { root } = await first.owner.service['workspace/roots/pick']({});
    const rootId = root?.rootId ?? '';
    const [recorded] = (await store.workspaceRoots({ operation: 'list' })).roots;
    await first.owner.service['projects/rename']({
      name: 'Alpha project',
      projectId: recorded?.projectId ?? '',
    });
    await writeHostWorkspaceTrust(store, alpha, 'trusted');
    await first.owner.close();
    owners.splice(owners.indexOf(first.owner), 1);
    renameSync(alpha, moved);

    const picks: string[] = [];
    const { owner, publishRootsChanged } = registry({ picks });
    await owner.start();
    await expect(owner.service['workspace/roots/locate']({ rootId })).resolves.toEqual({
      root: null,
    });
    picks.push(moved);
    await expect(owner.service['workspace/roots/locate']({ rootId })).resolves.toEqual({
      root: { available: true, path: moved, rootId, scratch: false, worktree: false },
    });

    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({
        canonicalPath: moved,
        id: rootId,
        path: moved,
        projectId: recorded?.projectId,
        projectName: 'Alpha project',
        status: 'live',
      }),
    ]);
    expect(publishRootsChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ grantedPath: moved })
    );
    // The person's pick is not proof that it is the same folder, so trust is asked again there.
    expect(await readHostWorkspaceTrust(store, moved)).toBe('undecided');
    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [{ available: true, path: moved, rootId, scratch: false, worktree: false }],
    });
  });

  it('Locate refuses a folder still where it was, one recorded under another id, and a thread folder', async () => {
    const [alpha, beta] = ['alpha', 'beta'].map(folder);
    const gone = folder('gone');
    const picks = [alpha ?? '', beta ?? '', gone];
    const { owner } = registry({ picks });
    const { root: alphaRoot } = await owner.service['workspace/roots/pick']({});
    await owner.service['workspace/roots/pick']({});
    const { root: goneRoot } = await owner.service['workspace/roots/pick']({});
    await owner.service['workspace/roots/remove']({ rootId: alphaRoot?.rootId ?? '' });
    await owner.service['workspace/roots/remove']({ rootId: goneRoot?.rootId ?? '' });
    rmSync(gone, { recursive: true });

    // Alpha is closed but still at its place: it opens from Recents, so there is nothing to locate.
    await expect(
      owner.service['workspace/roots/locate']({ rootId: alphaRoot?.rootId ?? '' })
    ).rejects.toMatchObject({ failure: { code: 'workspace.locate-present' } });
    // Beta is recorded as a folder of its own: it cannot become Gone's record too.
    picks.push(beta ?? '');
    await expect(
      owner.service['workspace/roots/locate']({ rootId: goneRoot?.rootId ?? '' })
    ).rejects.toMatchObject({ failure: { code: 'workspace.locate-recorded' } });
    await expect(
      owner.service['workspace/roots/locate']({ rootId: 'no-such-root' })
    ).rejects.toMatchObject({ failure: { code: 'workspace.locate-unknown' } });
    mkdirSync(path.join(base, 'scratch'));
    const made = path.join(base, 'scratch', 'quiet-otter');
    const scratch = await owner.scratch.add({
      make: async () => {
        mkdirSync(made);
        return made;
      },
      signal: new AbortController().signal,
      threadId: 'thread-1',
    });
    await expect(
      owner.service['workspace/roots/locate']({ rootId: scratch?.rootId ?? '' })
    ).rejects.toMatchObject({ failure: { code: 'workspace.locate-unknown' } });
    expect(
      (await store.workspaceRoots({ operation: 'list' })).roots.find(
        (record) => record.id === goneRoot?.rootId
      )
    ).toMatchObject({ path: gone, status: 'disconnected' });
  });

  // A folder opened first and adopted as a managed worktree keeps kind `path`; the worktree ledger
  // still names it, so Locate must not point its record at another folder.
  it("Locate refuses a managed worktree's folder that was opened before it was adopted", async () => {
    const alpha = folder('alpha');
    const moved = path.join(base, 'moved-alpha');
    const first = registry({ picked: alpha });
    const { root } = await first.owner.service['workspace/roots/pick']({});
    const rootId = root?.rootId ?? '';
    await store.worktreeLedger({
      operation: 'insert',
      row: {
        archivedAt: null,
        archiveSnapshotRef: null,
        baseCommit: 'a'.repeat(40),
        baseRef: 'a'.repeat(40),
        branch: 'adopted',
        createdAt: '2026-11-12T00:00:00.000Z',
        createdBy: 'user',
        id: 'worktree-adopted',
        path: alpha,
        repoCommonDir: path.join(base, 'repo', '.git'),
        runId: null,
        setupOutput: null,
        setupReason: null,
        setupStatus: 'none',
        threadId: null,
      },
    });
    await first.owner.close();
    owners.splice(owners.indexOf(first.owner), 1);
    renameSync(alpha, moved);

    const { owner } = registry({ picks: [moved] });
    await owner.start();
    // The store refuses in the re-pin's own commit; the host's connection types it (`storeRefusal`).
    await expect(owner.service['workspace/roots/locate']({ rootId })).rejects.toMatchObject({
      code: 'workspace.locate-unknown',
    });
    expect(
      (await store.workspaceRoots({ operation: 'list' })).roots.find(
        (record) => record.id === rootId
      )
    ).toMatchObject({ path: alpha });
  });

  it("turns a thread's scratch folder into a folder of the person's at its new place: same root id, open, recent, and mounted again after a restart", async () => {
    mkdirSync(path.join(base, 'scratch'));
    const made = path.join(base, 'scratch', 'quiet-otter');
    const signal = new AbortController().signal;
    const { owner, publishRootsChanged } = registry();
    const root = await owner.scratch.add({
      make: async () => {
        mkdirSync(made);
        return made;
      },
      signal,
      threadId: 'thread-1',
    });
    const rootId = root?.rootId ?? '';
    writeFileSync(path.join(made, 'notes.txt'), 'work');
    const place = path.join(folder('Projects'), 'quiet-otter');

    // The platform's scratch folders move it; the registry unmounts it first and mounts it after.
    const moved: string[] = [];
    await expect(
      owner.scratch.promote({
        move: async (scratchFolder) => {
          moved.push(scratchFolder);
          expect(owner.registry.mountedRoots()).toEqual([]);
          renameSync(scratchFolder, place);
          return place;
        },
        threadId: 'thread-1',
      })
    ).resolves.toEqual({ displayName: 'quiet-otter', path: place, rootId });

    expect(moved).toEqual([made]);
    expect(owner.registry.mountedRoots()).toEqual([{ canonicalPath: place, path: place, rootId }]);
    const projectRoot = { available: true, path: place, rootId, scratch: false, worktree: false };
    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [projectRoot],
    });
    expect((await store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([
      expect.objectContaining({ id: rootId, kind: 'path', projectId: expect.any(String) }),
    ]);
    await expect(owner.scratch.read('thread-1')).resolves.toBeNull();
    // Like a folder the person adds, it joins Recents and Main hears of it.
    await expect(owner.service['workspace/roots/recent']({})).resolves.toMatchObject({
      roots: [{ path: place }],
    });
    expect(publishRootsChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ grantedPath: place })
    );
    // A window shows it by its path, as the person's folder now.
    await expect(owner.service['workspace/roots/add']({ path: place })).resolves.toEqual(
      projectRoot
    );

    await owner.close();
    owners.splice(owners.indexOf(owner), 1);
    const restarted = registry().owner;
    await restarted.start();
    expect(restarted.registry.mountedRoots()).toEqual([
      { canonicalPath: place, path: place, rootId },
    ]);
  });

  it('a move that fails leaves the scratch folder mounted where it was, and a record that fails after the move says where the folder is', async () => {
    mkdirSync(path.join(base, 'scratch'));
    const made = path.join(base, 'scratch', 'quiet-otter');
    const place = path.join(folder('Projects'), 'quiet-otter');
    let failRecord = false;
    const failing: HostRootRegistryStore = {
      deleteSetting: (key) => store.deleteSetting(key),
      getSetting: (key) => store.getSetting(key),
      setSetting: (key, value) => store.setSetting(key, value),
      stateDamage: null,
      workspaceRoots: async (request: WorkspaceRootRequest) => {
        if (failRecord && request.operation === 'scratch-to-project') {
          throw new Error('fixture: the state DB refused the write');
        }
        return await store.workspaceRoots(request);
      },
    };
    const { owner } = registry({ rootsStore: failing });
    const root = await owner.scratch.add({
      make: async () => {
        mkdirSync(made);
        return made;
      },
      signal: new AbortController().signal,
      threadId: 'thread-1',
    });
    const rootId = root?.rootId ?? '';
    const refused = new Error('fixture: another disk');

    await expect(
      owner.scratch.promote({
        move: async () => {
          throw refused;
        },
        threadId: 'thread-1',
      })
    ).rejects.toBe(refused);
    expect(owner.registry.mountedRoots()).toEqual([{ canonicalPath: made, path: made, rootId }]);
    await expect(owner.scratch.read('thread-1')).resolves.toEqual(root);

    failRecord = true;
    await expect(
      owner.scratch.promote({
        move: async (scratchFolder) => {
          renameSync(scratchFolder, place);
          return place;
        },
        threadId: 'thread-1',
      })
    ).rejects.toMatchObject({
      failure: {
        code: 'workspace.scratch-project-unrecorded',
        message: expect.stringContaining(place),
      },
    });
    // Nothing is mounted at a place its record does not name; the record still says scratch.
    expect(owner.registry.mountedRoots()).toEqual([]);
    expect((await store.workspaceRoots({ operation: 'list' })).roots).toEqual([
      expect.objectContaining({ id: rootId, kind: 'scratch', path: made }),
    ]);
  });

  it('seeds folders only in a desktop E2E session', async () => {
    const workspace = folder('workspace');
    const seed = { recentPaths: [], roots: [{ path: workspace, rootId: crypto.randomUUID() }] };

    await expect(
      registry({ e2e: false }).owner.service['workspace/roots/seed-for-e2e'](seed)
    ).rejects.toMatchObject({ failure: { code: 'workspace.e2e-only' } });
    const { owner } = registry({ e2e: true });
    await owner.service['workspace/roots/seed-for-e2e'](seed);
    expect(owner.registry.mountedRoots()).toEqual([
      { canonicalPath: workspace, path: workspace, rootId: seed.roots[0]?.rootId },
    ]);
  });
});
