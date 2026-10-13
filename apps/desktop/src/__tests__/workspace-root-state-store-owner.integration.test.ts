// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '@brainstrike/state-store';
import { expect, test, vi } from 'vitest';
import { DesktopWorkspaceBindingAuthority } from '../agent-host-platform/desktop-workspace-binding';
import { WorkspaceRootRegistry } from '../ipc-domains/workspace-root-registry';
import {
  createNativeSecureRoot,
  resolveCanonicalRootPath,
} from '../ipc-domains/workspace-root-seams';
import { createStorage, rootHandle } from './ipc-domains/workspace-root-registry-test-helpers';

const unavailablePg = vi.hoisted(() =>
  vi.fn(async (): Promise<never> => {
    throw new Error('PG root provider unavailable');
  })
);
vi.mock('@brainstrike/db/pglite-factory', async (original) => ({
  ...(await original<typeof import('@brainstrike/db/pglite-factory')>()),
  createBrainstrikePglite: unavailablePg,
}));

test('Main Add, binding, disconnect and re-add preserve one SQLite root with the PG provider unavailable', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-root-state-owner-')));
  const folder = join(directory, 'Alpha');
  await mkdir(folder);
  const storage = createStorage();
  const store = await StateStore.open(join(directory, 'profile'));
  const options = {
    createSecureRoot: createNativeSecureRoot,
    disposeCommandSessionsForRoot: async () => 0,
    evictLspServersForRoot: async () => undefined,
    getRootsCatalog: async () => store,
    pathExists: async () => true,
    resolveCanonicalRoot: resolveCanonicalRootPath,
    storage,
  };
  const registry = new WorkspaceRootRegistry(options);
  const authority = new DesktopWorkspaceBindingAuthority({
    borrowRoot: (root) =>
      registry.borrowSourceRootForPath(root.path, async () => ({ close: async () => undefined })),
    readRootNames: async (ids) =>
      new Map(
        (await store.workspaceRoots({ operation: 'list' })).roots
          .filter((root) => ids.includes(root.id))
          .map((root) => [root.id, root.displayName])
      ),
    readRoots: async () =>
      (await store.workspaceRoots({ operation: 'list' })).roots
        .filter((root) => root.status === 'live')
        .map((root) => ({ displayName: root.displayName, path: root.path, rootId: root.id })),
    readWorktree: async () => null,
  });
  try {
    const mounted = await registry.addRoot(rootHandle(folder));
    const request = {
      binding: { operatingRootDisplayName: 'Alpha', operatingRootId: mounted.rootId },
      signal: new AbortController().signal,
      threadId: 'thread-alpha',
    };
    const first = await authority.acquire(request);
    expect(first.roots).toEqual([{ displayName: 'Alpha', path: folder, rootId: mounted.rootId }]);
    await first.close();
    await registry.removeRoot(mounted.rootId);
    await expect(authority.acquire(request)).rejects.toThrow();
    const readded = await registry.addRoot(rootHandle(folder));
    expect(readded.rootId).toBe(mounted.rootId);
    const restored = await authority.acquire(request);
    await restored.close();
    expect(unavailablePg).not.toHaveBeenCalled();
  } finally {
    await authority.close();
    await registry.dispose();
    await store.close();
    await rm(directory, { force: true, recursive: true });
  }
});
