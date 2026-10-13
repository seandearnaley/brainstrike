import { access, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRootRegistry } from '../../ipc-domains/workspace-root-registry';
import { createRegistryCatalogRequest } from './workspace-root-registry-test-helpers';

function createStorage(): ElectronStorageAdapter {
  const values = new Map<string, string>();
  return {
    clear: vi.fn(async () => values.clear()),
    getAllKeys: vi.fn(async () => [...values.keys()]),
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
  } as unknown as ElectronStorageAdapter;
}

describe('WorkspaceRootRegistry secure filesystem integration', () => {
  let fixtureRoot: string | undefined;

  afterEach(async () => {
    if (fixtureRoot) {
      await rm(fixtureRoot, { force: true, recursive: true });
      fixtureRoot = undefined;
    }
  });

  it('never reads through symlinks or a replaced root while retaining regular reads', async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'brainstrike-root-registry-'));
    const workspace = path.join(fixtureRoot, 'workspace');
    const parkedWorkspace = path.join(fixtureRoot, 'parked-workspace');
    const outside = path.join(fixtureRoot, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(path.join(workspace, 'inside.txt'), 'inside authority');
    await writeFile(path.join(outside, 'inside.txt'), 'outside content');
    await writeFile(path.join(outside, 'secret.txt'), 'outside secret');
    await symlink(
      path.join(outside, 'secret.txt'),
      path.join(workspace, 'outside-link.txt'),
      'file'
    );
    await symlink('inside.txt', path.join(workspace, 'inside-link.txt'), 'file');
    await symlink('missing.txt', path.join(workspace, 'dangling-link.txt'), 'file');

    const storage = createStorage();
    const workspaceRoots = createRegistryCatalogRequest();
    const registry = new WorkspaceRootRegistry({
      disposeCommandSessionsForRoot: vi.fn(async () => 0),
      evictLspServersForRoot: vi.fn(async () => undefined),
      getRootsCatalog: async () => ({ workspaceRoots }),
      pathExists: async (rootPath) =>
        access(rootPath).then(
          () => true,
          () => false
        ),
      storage,
    });

    const descriptor = await registry.addRoot({
      kind: 'directory',
      name: 'workspace',
      path: workspace,
      platform: 'electron',
    });
    await expect(
      registry.readFile({
        kind: 'file',
        name: 'inside.txt',
        path: path.join(workspace, 'inside.txt'),
        platform: 'electron',
        rootId: descriptor.rootId,
      })
    ).resolves.toBe('inside authority');

    const listing = await registry.readDirectory(descriptor.handle);
    expect(listing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'outside-link.txt',
          rootFolderId: descriptor.rootId,
          type: 'file',
        }),
        expect.objectContaining({
          name: 'inside-link.txt',
          rootFolderId: descriptor.rootId,
          type: 'file',
        }),
        expect.objectContaining({
          name: 'dangling-link.txt',
          rootFolderId: descriptor.rootId,
          type: 'file',
        }),
      ])
    );
    await expect(
      registry.readFile({
        kind: 'file',
        name: 'outside-link.txt',
        path: path.join(workspace, 'outside-link.txt'),
        platform: 'electron',
        rootId: descriptor.rootId,
      })
    ).rejects.toThrow(/outside the configured root|restricted/);
    await expect(
      registry.readFile({
        kind: 'file',
        name: 'inside-link.txt',
        path: path.join(workspace, 'inside-link.txt'),
        platform: 'electron',
        rootId: descriptor.rootId,
      })
    ).rejects.toThrow('File is a symbolic link. Links are not followed inside workspace roots.');
    await expect(
      registry.readFile({
        kind: 'file',
        name: 'dangling-link.txt',
        path: path.join(workspace, 'dangling-link.txt'),
        platform: 'electron',
        rootId: descriptor.rootId,
      })
    ).rejects.toThrow();

    await rename(workspace, parkedWorkspace);
    await symlink(outside, workspace, 'dir');
    await expect(
      registry.readFile({
        kind: 'file',
        name: 'inside.txt',
        path: path.join(workspace, 'inside.txt'),
        platform: 'electron',
        rootId: descriptor.rootId,
      })
    ).rejects.toThrow('outside the selected workspace root');
    await registry.dispose();
  });
});
