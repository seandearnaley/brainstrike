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
import type { HostThreadReads } from '@brainstrike/agent-host';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import {
  StateStore,
  StateStoreReadOnlyError,
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
      listThreads: () => [],
      read: async () => [runStarted],
      readLedger: () =>
        ({
          threads: [{ runs: [{ runId: 'run-beta', status: 'running' }], threadId: 'thread-beta' }],
        }) as unknown as ReturnType<HostThreadReads['readLedger']>,
    });
    const openIds = async () =>
      (await store.workspaceRoots({ operation: 'list-open' })).roots.map((root) => root.id);

    await expect(owner.service['workspace/roots/open']({ path: alpha ?? '' })).resolves.toEqual({
      root: { available: true, path: alpha, rootId: alphaId, worktree: false },
    });
    expect(await openIds()).toEqual([alphaId]);
    // Beta left the open folders but its run still reads it; gamma is gone.
    const live = (await owner.roots.listRoots()).map((root) => root.rootId);
    expect(live.sort()).toEqual([alphaId, betaId].sort());
    // A window reload restores the open folders and keeps the run's folder mounted.
    await expect(owner.service['workspace/roots/restore']({})).resolves.toEqual({
      roots: [{ available: true, path: alpha, rootId: alphaId, worktree: false }],
    });
    expect((await owner.roots.listRoots()).map((root) => root.rootId).sort()).toEqual(
      [alphaId, betaId].sort()
    );
    expect(
      (await owner.service['workspace/roots/mounted']({})).roots.map((root) => root.rootId)
    ).toContain(betaId);

    // A new folder through the picker replaces alpha; a cancelled pick changes nothing.
    const { root: opened } = await owner.service['workspace/roots/open']({});
    expect(opened).toMatchObject({ path: delta, worktree: false });
    expect(await openIds()).toEqual([opened?.rootId]);
    await expect(owner.service['workspace/roots/open']({})).resolves.toEqual({ root: null });
    expect(await openIds()).toEqual([opened?.rootId]);
    // Recents still hold every folder, gamma included, so it opens again with its identity.
    await expect(owner.service['workspace/roots/open']({ path: gamma ?? '' })).resolves.toEqual({
      root: { available: true, path: gamma, rootId: gammaId, worktree: false },
    });
  });

  it('opens only a recent folder by path', async () => {
    const stranger = folder('stranger');
    const { owner } = registry();
    owner.attachThreadReads({
      listThreads: () => [],
      read: async () => [],
      readLedger: () => ({ threads: [] }) as unknown as ReturnType<HostThreadReads['readLedger']>,
    });

    await expect(owner.service['workspace/roots/open']({ path: stranger })).rejects.toMatchObject({
      failure: { code: 'workspace.never-granted' },
    });
    expect((await store.workspaceRoots({ operation: 'list-open' })).roots).toEqual([]);
  });

  it('hides a folder from every reader for its whole data deletion, and restores it if that fails', async () => {
    const workspace = folder('workspace');
    const deleting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rootsStore: HostRootRegistryStore = {
      deleteSetting: (key) => store.deleteSetting(key),
      getSetting: (key) => store.getSetting(key),
      setSetting: (key, value) => store.setSetting(key, value),
      stateDamage: null,
      workspaceRoots: async (request: WorkspaceRootRequest) => {
        if (request.operation === 'delete') {
          deleting.resolve();
          await release.promise;
        }
        return await store.workspaceRoots(request);
      },
    };
    const { owner } = registry({ picked: workspace, rootsStore });
    const { root } = await owner.service['workspace/roots/pick']({});
    const rootId = root?.rootId ?? '';
    expect((await owner.roots.listRoots()).map((entry) => entry.rootId)).toEqual([rootId]);

    const { reservationId } = await owner.service['workspace/roots/reserve-data-deletion']({
      rootId,
    });
    const deletion = owner.service['workspace/roots/delete-data']({ reservationId });
    await deleting.promise;
    expect(await owner.roots.listRoots()).toEqual([]);
    await expect(owner.service['workspace/roots/mounted']({})).resolves.toEqual({ roots: [] });
    await expect(owner.registry.useMountedRoot(rootId, async () => 'read')).rejects.toThrow(
      'not mounted'
    );

    // This store has no indexer attached, so its deletion refuses: the folder stays connected.
    release.resolve();
    await expect(deletion).rejects.toThrow('needs the indexer port');
    expect((await owner.roots.listRoots()).map((entry) => entry.rootId)).toEqual([rootId]);
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
      roots: [{ available: false, path: workspace, rootId: root?.rootId, worktree: false }],
    });
    await expect(owner.service['workspace/roots/mounted']({})).resolves.toEqual({ roots: [] });
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
      roots: [{ available: true, path: target, rootId: granted?.rootId, worktree: false }],
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
        ['list', 'list-open', 'list-worktrees'].includes(request.operation)
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
      roots: [{ available: true, path: workspace, rootId, worktree: false }],
    });
    await expect(owner.service['workspace/roots/recent']({})).resolves.toMatchObject({
      roots: [{ path: workspace }],
    });
    for (const change of [
      service.service['workspace/roots/pick']({}),
      owner.service['workspace/roots/add']({ path: other }),
      owner.service['workspace/roots/remove']({ rootId }),
      owner.service['workspace/roots/reserve-data-deletion']({ rootId }),
      service.service['workspace/roots/seed-for-e2e']({
        recentPaths: [],
        roots: [{ path: other, rootId: crypto.randomUUID() }],
      }),
    ]) {
      await expect(change).rejects.toBeInstanceOf(StateStoreReadOnlyError);
    }
    expect(picked).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    await expect(owner.service['workspace/roots/mounted']({})).resolves.toEqual({
      roots: [{ canonicalPath: workspace, path: workspace, rootId }],
    });
  });

  it('seeds folders only in a desktop E2E session', async () => {
    const workspace = folder('workspace');
    const seed = { recentPaths: [], roots: [{ path: workspace, rootId: crypto.randomUUID() }] };

    await expect(
      registry({ e2e: false }).owner.service['workspace/roots/seed-for-e2e'](seed)
    ).rejects.toMatchObject({ failure: { code: 'workspace.e2e-only' } });
    const { owner } = registry({ e2e: true });
    await owner.service['workspace/roots/seed-for-e2e'](seed);
    await expect(owner.service['workspace/roots/mounted']({})).resolves.toEqual({
      roots: [{ canonicalPath: workspace, path: workspace, rootId: seed.roots[0]?.rootId }],
    });
  });
});
