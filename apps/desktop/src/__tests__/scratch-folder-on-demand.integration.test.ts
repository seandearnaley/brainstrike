// @vitest-environment node
/**
 * ADR-0034 (BST-2512): a launch mounts no scratch folder. One mounts the first time its thread
 * needs it, through the root registry, its one owner: here a run's admission, which borrows the
 * folders its thread's binding names. It then stays mounted for the session, and the Explorer's
 * reads use its handle. A folder gone from disk is refused by name and place, never skipped.
 *
 * The host's real store, root registry (native `SecureRoot` handles), Explorer pins and the
 * desktop's binding authority, as `desktop-node-platform.ts` composes them; no app runs.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceRootsFromCatalog } from '@brainstrike/assistant-service/node-workspace-services';
import {
  createWorkspaceRootPins,
  ROOT_UNMOUNTED,
} from '@brainstrike/host-capabilities/workspace-files';
import {
  createHostRootRegistry,
  type HostRootRegistryOwner,
  type HostRootRegistryStore,
} from '@brainstrike/host-capabilities/workspace-roots';
import { StateStore } from '@brainstrike/state-store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { DesktopWorkspaceBindingAuthority } from '../agent-host-platform/desktop-workspace-binding';

let base = '';
let store: StateStore;
const closing: (() => Promise<void>)[] = [];

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'bs-scratch-on-demand-')));
  store = await StateStore.open(join(base, 'profile'));
});

afterEach(async () => {
  for (const close of closing.splice(0).reverse()) {
    await close();
  }
  await store.close();
  await rm(base, { force: true, recursive: true });
});

/** The host's folders as one launch composes them over the profile's store. */
async function launch(roots: HostRootRegistryStore = store) {
  const owner: HostRootRegistryOwner = createHostRootRegistry({
    disposeCommandSessionsForRoot: async () => 0,
    e2e: false,
    evictLspServersForRoot: async () => undefined,
    managedWorktreeAuthorizer: async () => 'unmanaged',
    pickFolder: async () => null,
    publishRootsChanged: async () => undefined,
    store: roots,
  });
  const workspace = new DesktopWorkspaceBindingAuthority({
    borrowRoot: (root) => owner.registry.borrowSourceRootForPath(root.path),
    mountScratchFolders: (rootIds) => owner.registry.mountScratchRoots(rootIds),
    readLiveWorktreePath: async () => null,
    readRootNames: async () => new Map(),
    readRoots: () => loadWorkspaceRootsFromCatalog(store),
  });
  const pins = createWorkspaceRootPins({ mounts: owner.registry });
  const close = async (): Promise<void> => {
    await workspace.close();
    await pins.close();
    await owner.close();
  };
  closing.push(close);
  await owner.start();
  return { close, owner, pins, workspace };
}

/** Three threads sent with no folder open, each in a scratch folder the host made for it. */
async function threeScratchThreads() {
  const scratch = join(base, 'userData', 'scratch');
  await mkdir(scratch, { recursive: true });
  const first = await launch();
  const roots = [];
  for (const name of ['quiet-otter', 'brave-wren', 'calm-heron']) {
    const root = await first.owner.scratch.add({
      make: async () => {
        const folder = join(scratch, name);
        await mkdir(folder);
        await writeFile(join(folder, 'notes.txt'), `${name} notes`);
        return folder;
      },
      signal: new AbortController().signal,
      threadId: `thread-${name}`,
    });
    if (!root) {
      throw new Error('The host made no scratch folder');
    }
    roots.push(root);
  }
  await first.close();
  return roots;
}

/** A run of the thread working in `root`, admitted as Core asks the desktop to admit it. */
function admit(
  workspace: DesktopWorkspaceBindingAuthority,
  root: { displayName: string; path: string; rootId: string }
) {
  return workspace.acquire({
    binding: {
      operatingRootDisplayName: root.displayName,
      operatingRootId: root.rootId,
      operatingRootPath: root.path,
    },
    signal: new AbortController().signal,
    threadId: `thread-${root.displayName}`,
  });
}

async function statusOf(rootId: string): Promise<string | undefined> {
  const { roots } = await store.workspaceRoots({ operation: 'list' });
  return roots.find((root) => root.id === rootId)?.status;
}

test("a launch mounts no scratch folder, and a thread's first run mounts its own for the session", async () => {
  const [otter, wren, heron] = await threeScratchThreads();
  if (!(otter && wren && heron)) {
    throw new Error('Three scratch folders were not made');
  }

  const { owner, pins, workspace } = await launch();

  // No handle is opened for a scratch folder at launch; each record stays, not mounted now.
  expect(owner.registry.mountedRoots()).toEqual([]);
  expect(await Promise.all([otter, wren, heron].map((root) => statusOf(root.rootId)))).toEqual([
    'disconnected',
    'disconnected',
    'disconnected',
  ]);
  // The Explorer cannot read a folder its thread has not needed: refused, never empty.
  await expect(
    pins.use({ path: wren.path, rootId: wren.rootId }, async () => 'read')
  ).rejects.toMatchObject({ failure: { code: ROOT_UNMOUNTED } });

  // The thread's run is admitted in its own folder, which mounts for it.
  const borrowed = await admit(workspace, wren);
  expect(borrowed.roots).toEqual([
    expect.objectContaining({ path: wren.path, rootId: wren.rootId }),
  ]);
  await borrowed.close();

  // It stays mounted, and its handle serves the Explorer's reads. The others are still not mounted.
  expect(owner.registry.mountedRoots()).toEqual([
    { canonicalPath: wren.path, path: wren.path, rootId: wren.rootId },
  ]);
  await expect(
    pins.use({ path: wren.path, rootId: wren.rootId }, async (pinned) => {
      const read = await pinned.root.readFile('notes.txt', 1024);
      return read.status === 'ok' ? read.content.toString('utf8') : read.status;
    })
  ).resolves.toBe('brave-wren notes');
  expect(await statusOf(wren.rootId)).toBe('live');
  expect(await statusOf(otter.rootId)).toBe('disconnected');
  expect(await statusOf(heron.rootId)).toBe('disconnected');

  // A second run of it opens nothing new.
  const again = await admit(workspace, wren);
  await again.close();
  expect(owner.registry.mountedRoots().map((root) => root.rootId)).toEqual([wren.rootId]);
});

test('a scratch folder gone from disk refuses its thread’s run by name and place', async () => {
  const [otter] = await threeScratchThreads();
  if (!otter) {
    throw new Error('No scratch folder was made');
  }
  await rm(otter.path, { force: true, recursive: true });

  const { owner, workspace } = await launch();

  await expect(admit(workspace, otter)).rejects.toMatchObject({
    failure: {
      code: 'workspace.root-missing',
      message: `The scratch folder quiet-otter is no longer at ${otter.path}.`,
    },
  });
  expect(owner.registry.mountedRoots()).toEqual([]);
});

/** The profile's store as a launch that could not record which folders it mounted sees it. */
function unrecordedLaunchStore(damage: string | null): HostRootRegistryStore {
  return {
    deleteSetting: (key) => store.deleteSetting(key),
    getSetting: (key) => store.getSetting(key),
    setSetting: (key, value) => store.setSetting(key, value),
    stateDamage: damage,
    workspaceRoots: async (request) => {
      if (request.operation === 'disconnect-except') {
        throw new Error('fixture: the state DB refused the write');
      }
      return await store.workspaceRoots(request);
    },
  };
}

test.each([
  ['a launch whose convergence failed', null],
  ['a damaged store, served read-only', 'fixture damage'],
])(
  'after %s, a scratch folder still recorded live mounts for its thread’s run',
  async (_launch, damage) => {
    const [otter] = await threeScratchThreads();
    if (!otter) {
      throw new Error('No scratch folder was made');
    }

    const { owner, workspace } = await launch(unrecordedLaunchStore(damage));

    // The launch mounted nothing, and could not write that down: the record still says live.
    expect(owner.registry.mountedRoots()).toEqual([]);
    expect(await statusOf(otter.rootId)).toBe('live');
    const borrowed = await admit(workspace, otter);
    expect(borrowed.roots).toEqual([
      expect.objectContaining({ path: otter.path, rootId: otter.rootId }),
    ]);
    await borrowed.close();
    expect(owner.registry.mountedRoots().map((root) => root.rootId)).toEqual([otter.rootId]);
  }
);
