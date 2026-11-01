import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  listOpenRoots,
  openRootsCatalog,
  rootHandle,
  secureRoot,
} from './workspace-root-registry-test-helpers';

// ADR-0029 stage 4: the agent host's root registry. The catalog's open order
// (`roots.open_position`) is the one record of the open folders; closing a
// folder and disconnecting it commit in one transaction, so nothing rolls back.
describe('WorkspaceRootRegistry', () => {
  it('keeps a transiently unmountable folder open and returns it as unavailable', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    const catalog = openRootsCatalog([entry]);
    const registry = createRegistry(
      {
        createSecureRoot: async () => {
          throw new Error('native addon temporarily unavailable');
        },
      },
      catalog
    );

    await expect(registry.restoreRoots()).resolves.toEqual([
      expect.objectContaining({ permissionState: 'unknown', rootId: 'root-a' }),
    ]);
    expect(await listOpenRoots(catalog)).toEqual([{ path: entry.path, rootId: entry.rootId }]);
    await registry.dispose();
  });

  it('deduplicates aliases by canonical identity and reuses the durable root id', async () => {
    const alias = path.resolve('/alias/workspace');
    const anotherAlias = path.resolve('/another-alias/workspace');
    const canonical = path.resolve('/canonical/workspace');
    const catalog = openRootsCatalog([
      { addedAt: 1, canonicalPath: canonical, path: alias, rootId: 'root-a' },
    ]);
    const canonicalByPath = new Map([
      [alias, canonical],
      [anotherAlias, canonical],
    ]);
    const registry = createRegistry(
      {
        // Mount-then-ask: the probe's own canonicalPath is the identity of the path being
        // added, matched against the identity each record was granted under.
        createSecureRoot: async (rootPath) =>
          secureRoot(canonicalByPath.get(rootPath) ?? path.normalize(rootPath)),
      },
      catalog
    );

    const descriptor = await registry.addRoot(rootHandle(anotherAlias));

    // The picker re-pins the folder to the path just picked, under its durable id.
    expect(descriptor).toMatchObject({
      handle: { path: anotherAlias, rootId: 'root-a' },
      persisted: true,
      rootId: 'root-a',
    });
    expect(await listOpenRoots(catalog)).toEqual([{ path: anotherAlias, rootId: 'root-a' }]);
    await registry.dispose();
  });

  it('keeps the folder open and mounted when the catalog refuses its removal', async () => {
    const entry = { addedAt: 1, path: '/workspace', rootId: 'root-a' };
    const catalog = openRootsCatalog([entry]);
    const mounted = secureRoot('/workspace');
    const registry = createRegistry({ createSecureRoot: async () => mounted }, catalog);
    await registry.restoreRoots();
    catalog.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(registry.removeRoot('root-a')).rejects.toThrow('db unavailable');
    expect(await listOpenRoots(catalog)).toEqual([{ path: entry.path, rootId: entry.rootId }]);
    expect(mounted.close).not.toHaveBeenCalled();

    await expect(registry.removeRoot('root-a')).resolves.toBe(true);
    expect(mounted.close).toHaveBeenCalledOnce();
    expect(await listOpenRoots(catalog)).toEqual([]);
    await registry.dispose();
  });

  it('opens folders in the order they were added and restores them in that order', async () => {
    const catalog = openRootsCatalog([]);
    const registry = createRegistry({}, catalog);
    const first = await registry.addRoot(rootHandle(path.resolve('/first')));
    const second = await registry.addRoot(rootHandle(path.resolve('/second')));
    await registry.removeRoot(first.rootId);
    const readded = await registry.addRoot(rootHandle(path.resolve('/first')));

    expect(readded.rootId).toBe(first.rootId);
    expect((await registry.restoreRoots()).map((root) => root.rootId)).toEqual([
      second.rootId,
      first.rootId,
    ]);
    await registry.dispose();
  });

  it("closes a removed folder's handle only after the reads on it end, and lends it no more", async () => {
    const mounted = secureRoot(path.resolve('/workspace'));
    const registry = createRegistry({ createSecureRoot: async () => mounted });
    const root = await registry.addRoot(rootHandle(path.resolve('/workspace')));
    const reading = Promise.withResolvers<void>();
    const read = registry.useMountedRoot(root.rootId, async (handle) => {
      await reading.promise;
      return handle.root;
    });

    const removal = registry.removeRoot(root.rootId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mounted.close).not.toHaveBeenCalled();
    await expect(registry.useMountedRoot(root.rootId, async () => 'late')).rejects.toThrow(
      'not mounted'
    );

    reading.resolve();
    await expect(read).resolves.toBe(mounted);
    await expect(removal).resolves.toBe(true);
    expect(mounted.close).toHaveBeenCalledOnce();
    expect(registry.mountedRoots()).toEqual([]);
    await registry.dispose();
  });

  it('hides a folder whose data is being deleted for the whole deletion', async () => {
    const registry = createRegistry();
    const root = await registry.addRoot(rootHandle(path.resolve('/workspace')));
    const reservation = registry.reserveRootDataDeletion(root.rootId);

    expect(registry.mountedRoots()).toEqual([]);
    await expect(registry.useMountedRoot(root.rootId, async () => 'read')).rejects.toThrow(
      'not mounted'
    );

    reservation.release();
    expect(registry.mountedRoots()).toEqual([
      expect.objectContaining({ path: path.resolve('/workspace'), rootId: root.rootId }),
    ]);
    await registry.dispose();
  });

  it('refuses to reopen a folder whose path now resolves elsewhere, and keeps it open for reconnect', async () => {
    const workspace = path.resolve('/workspace');
    const catalog = openRootsCatalog([{ addedAt: 1, path: workspace, rootId: 'root-a' }]);
    // A symlink swapped in at the folder's path resolves to another folder.
    const swapped = secureRoot(path.resolve('/elsewhere'));
    const registry = createRegistry({ createSecureRoot: async () => swapped }, catalog);

    await expect(registry.restoreRoots()).resolves.toEqual([
      expect.objectContaining({ permissionState: 'unknown', rootId: 'root-a' }),
    ]);
    expect(swapped.close).toHaveBeenCalledOnce();
    expect(registry.mountedRoots()).toEqual([]);
    expect(await listOpenRoots(catalog)).toEqual([{ path: workspace, rootId: 'root-a' }]);
    await registry.dispose();
  });

  it('reopens a changed folder without the picker never, and re-pins it when the person picks it', async () => {
    const workspace = path.resolve('/workspace');
    const catalog = openRootsCatalog([]);
    let canonical = workspace;
    const registry = createRegistry(
      { createSecureRoot: async () => secureRoot(canonical) },
      catalog
    );
    const granted = await registry.addRoot(rootHandle(workspace));
    await registry.removeRoot(granted.rootId);
    canonical = path.resolve('/elsewhere');

    await expect(registry.addRootByPath(workspace)).rejects.toThrow('not the one that was granted');
    await expect(registry.addRoot(rootHandle(workspace))).resolves.toMatchObject({
      rootId: granted.rootId,
    });
    expect(registry.mountedRoots()).toEqual([
      { canonicalPath: path.resolve('/elsewhere'), path: workspace, rootId: granted.rootId },
    ]);
    await registry.dispose();
  });
});
