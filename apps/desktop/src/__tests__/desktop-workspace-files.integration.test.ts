// @vitest-environment node
/**
 * ADR-0029 stage 4: the agent host's folder service, as the Explorer uses it. Real folders
 * under a per-test temporary directory, a real StateStore, the real secure-fs-native root
 * capability and the real @parcel/watcher, so this file runs in the native integration lane.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HostWorkspaceFiles, WorkspaceFilesEvent } from '@brainstrike/agent-host';
import { StateStore } from '@brainstrike/state-store';
import type { DirectoryHandle, FileSystemChange, RootDescriptor } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import { createDesktopWorkspaceFiles } from '../agent-host-platform/desktop-workspace-files';
import {
  createDesktopWorkspaceRoots,
  type DesktopWorkspaceRoots,
} from '../agent-host-platform/desktop-workspace-roots';

interface Host {
  readonly files: HostWorkspaceFiles;
  readonly folders: DesktopWorkspaceRoots;
  /** Main's folder picker: the one grant that is not already in Recents. */
  pick(folderPath: string): Promise<RootDescriptor>;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  // Last opened, first closed: hosts before their stores, stores before their directories.
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function tempDir(prefix: string): Promise<string> {
  // realpath: the canonical spelling is what the registry presents for a mounted folder.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { force: true, recursive: true }));
  return dir;
}

async function openStore(dataRoot: string): Promise<StateStore> {
  const store = await StateStore.open(dataRoot);
  let closed = false;
  cleanups.push(async () => {
    if (!closed) {
      closed = true;
      await store.close();
    }
  });
  return store;
}

function openHost(store: StateStore): Host {
  const folders = createDesktopWorkspaceRoots({
    lifecycleDelays: new Map(),
    managedWorktreeAuthorizer: async () => 'unmanaged',
    onRestoredRootsChanged: () => undefined,
    onRootGranted: () => undefined,
    store,
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await folders.close();
    }
  };
  cleanups.push(close);
  const files = createDesktopWorkspaceFiles({
    deleteRootData: async () => undefined,
    folders,
    onRootsChanged: () => undefined,
  });
  return {
    files,
    folders,
    pick: (folderPath) =>
      folders.roots.addRoot({
        kind: 'directory',
        name: path.basename(folderPath),
        path: folderPath,
        platform: 'electron',
      }),
  };
}

/** A project folder with one file and one subdirectory. */
async function projectFolder(): Promise<string> {
  const folder = await tempDir('bst-files-project-');
  await writeFile(path.join(folder, 'notes.md'), '# Notes\n');
  await mkdir(path.join(folder, 'src'));
  await writeFile(path.join(folder, 'src', 'main.ts'), 'export {};\n');
  return folder;
}

function directoryHandle(folderPath: string, rootId?: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.basename(folderPath),
    path: folderPath,
    platform: 'electron',
    ...(rootId === undefined ? {} : { rootId }),
  };
}

describe('the agent host folder service', () => {
  it('restores a picked folder, lists it in Recents and reopens it from Recents after removal', async () => {
    const host = openHost(await openStore(await tempDir('bst-files-store-')));
    const folder = await projectFolder();

    const picked = await host.pick(folder);

    expect(picked).toMatchObject({ handle: { path: folder }, permissionState: 'granted' });
    expect(await host.files['files/restore-roots']({})).toEqual([
      expect.objectContaining({
        handle: expect.objectContaining({ path: folder }),
        rootId: picked.rootId,
      }),
    ]);
    expect((await host.files['files/recent-roots']({})).map((entry) => entry.path)).toEqual([
      folder,
    ]);

    await host.files['files/remove-root']({ rootId: picked.rootId });
    expect(await host.files['files/restore-roots']({})).toEqual([]);

    // Recents is the grant: the folder comes back under the identity it had.
    const reopened = await host.files['files/add-root-by-path']({ path: folder });
    expect(reopened).toMatchObject({ handle: { path: folder }, rootId: picked.rootId });
    expect(await host.files['files/restore-roots']({})).toEqual([
      expect.objectContaining({ rootId: picked.rootId }),
    ]);
  });

  it('refuses to add a folder by path that was never granted, or an empty path', async () => {
    const host = openHost(await openStore(await tempDir('bst-files-store-')));
    const folder = await projectFolder();

    await expect(host.files['files/add-root-by-path']({ path: folder })).rejects.toMatchObject({
      code: 'workspace.never-granted',
      failure: { category: 'authorization' },
    });
    await expect(host.files['files/add-root-by-path']({ path: '' })).rejects.toMatchObject({
      code: 'workspace.path-invalid',
    });
    expect(await host.files['files/restore-roots']({})).toEqual([]);
    expect(await host.files['files/recent-roots']({})).toEqual([]);
  });

  it('reads a mounted folder and its files, and drops a missing file instead of failing', async () => {
    const host = openHost(await openStore(await tempDir('bst-files-store-')));
    const folder = await projectFolder();
    const { rootId } = await host.pick(folder);

    const nodes = await host.files['files/read-directory']({
      handle: directoryHandle(folder, rootId),
    });
    expect(nodes.map((node) => [node.name, node.type]).sort()).toEqual([
      ['notes.md', 'file'],
      ['src', 'directory'],
    ]);

    const fileHandle = {
      kind: 'file',
      name: 'main.ts',
      path: path.join(folder, 'src', 'main.ts'),
      platform: 'electron',
      rootId,
    } as const;
    expect(await host.files['files/read-file']({ handle: fileHandle })).toBe('export {};\n');
    expect(
      await host.files['files/read-file-by-path']({ path: path.join(folder, 'notes.md') })
    ).toBe('# Notes\n');
    expect(
      await host.files['files/read-file-by-absolute-path']({
        absolutePath: path.join(folder, 'notes.md'),
        rootId,
        rootPath: folder,
      })
    ).toBe('# Notes\n');

    expect(
      await host.files['files/read-file-by-path']({ path: path.join(folder, 'deleted.md') })
    ).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses reads outside every mounted folder and paths with a NUL byte', async () => {
    const host = openHost(await openStore(await tempDir('bst-files-store-')));
    const folder = await projectFolder();
    const elsewhere = await projectFolder();
    const { rootId } = await host.pick(folder);

    await expect(
      host.files['files/read-file-by-path']({ path: path.join(elsewhere, 'notes.md') })
    ).rejects.toMatchObject({
      code: 'workspace.path-outside-root',
      failure: { category: 'authorization' },
    });
    await expect(
      host.files['files/read-directory']({ handle: directoryHandle(elsewhere) })
    ).rejects.toMatchObject({ code: 'workspace.path-outside-root' });
    // A claimed root that does not own the path is refused, even with a mounted root's id.
    await expect(
      host.files['files/read-file-by-absolute-path']({
        absolutePath: path.join(elsewhere, 'notes.md'),
        rootId,
        rootPath: elsewhere,
      })
    ).rejects.toMatchObject({ code: 'workspace.root-mismatch' });
    // Escaping the mounted folder with `..` is refused too.
    await expect(
      host.files['files/read-file-by-path']({
        path: `${folder}${path.sep}..${path.sep}${path.basename(elsewhere)}${path.sep}notes.md`,
      })
    ).rejects.toMatchObject({ code: 'workspace.path-outside-root' });

    await expect(
      host.files['files/read-file-by-path']({ path: path.join(folder, 'notes\0.md') })
    ).rejects.toMatchObject({ code: 'workspace.path-invalid', failure: { category: 'input' } });
    await expect(
      host.files['files/read-file']({
        handle: {
          kind: 'file',
          name: 'notes.md',
          path: path.join(folder, 'notes\0.md'),
          platform: 'electron',
          rootId,
        },
      })
    ).rejects.toMatchObject({
      code: 'workspace.path-invalid',
      message: expect.stringMatching(/null bytes/),
    });
    await expect(
      host.files['files/read-directory']({ handle: directoryHandle(`${folder}\0`, rootId) })
    ).rejects.toMatchObject({
      code: 'workspace.path-invalid',
      message: expect.stringMatching(/null bytes/),
    });
  });

  it('refuses reads under a removed folder', async () => {
    const host = openHost(await openStore(await tempDir('bst-files-store-')));
    const folder = await projectFolder();
    const { rootId } = await host.pick(folder);

    await host.files['files/remove-root']({ rootId });

    await expect(
      host.files['files/read-file-by-path']({ path: path.join(folder, 'notes.md') })
    ).rejects.toMatchObject({ code: 'workspace.path-outside-root' });
    await expect(
      host.files['files/read-directory']({ handle: directoryHandle(folder, rootId) })
    ).rejects.toMatchObject({ code: 'workspace.root-unmounted' });
    await expect(
      host.files['files/read-file-by-absolute-path']({
        absolutePath: path.join(folder, 'notes.md'),
        rootId,
        rootPath: folder,
      })
    ).rejects.toMatchObject({ code: 'workspace.root-unmounted' });
  });

  it('restores the last folder only while it is still a mounted folder', async () => {
    const host = openHost(await openStore(await tempDir('bst-files-store-')));
    const first = await projectFolder();
    const second = await projectFolder();
    const firstRoot = await host.pick(first);
    const secondRoot = await host.pick(second);

    // The most recently picked folder is the last folder.
    expect(await host.files['files/restore-last-folder']({})).toMatchObject({
      path: second,
      rootId: secondRoot.rootId,
    });
    await host.files['files/save-last-folder']({ path: first });
    expect(await host.files['files/restore-last-folder']({})).toMatchObject({
      path: first,
      rootId: firstRoot.rootId,
    });

    await host.files['files/remove-root']({ rootId: firstRoot.rootId });
    expect(await host.files['files/restore-last-folder']({})).toBeNull();
    // A folder that is not mounted cannot become the last folder.
    await expect(host.files['files/save-last-folder']({ path: first })).rejects.toThrow(
      /persisted mounted root/
    );
  });

  it('keeps folders, Recents and the last folder across a reopen of the same store', async () => {
    const dataRoot = await tempDir('bst-files-store-');
    const folder = await projectFolder();
    const gone = await projectFolder();
    const store = await openStore(dataRoot);
    const host = openHost(store);
    const kept = await host.pick(folder);
    await host.pick(gone);
    await host.files['files/save-last-folder']({ path: folder });
    await host.folders.close();
    await store.close();

    const reopened = openHost(await openStore(dataRoot));
    // Nothing is mounted until the folders are restored.
    expect(await reopened.files['files/restore-last-folder']({})).toBeNull();
    await rm(gone, { force: true, recursive: true });

    const restored = await reopened.files['files/restore-roots']({});
    expect(restored).toEqual([
      expect.objectContaining({
        handle: expect.objectContaining({ path: folder }),
        permissionState: 'granted',
        rootId: kept.rootId,
      }),
      expect.objectContaining({
        handle: expect.objectContaining({ path: gone }),
        permissionState: 'unknown',
      }),
    ]);
    expect(
      (await reopened.files['files/recent-roots']({})).map((entry) => entry.path).sort()
    ).toEqual([folder, gone].sort());
    expect(await reopened.files['files/restore-last-folder']({})).toMatchObject({
      path: folder,
      rootId: kept.rootId,
    });
    expect(
      await reopened.files['files/read-file-by-path']({ path: path.join(folder, 'notes.md') })
    ).toBe('# Notes\n');
  });

  it('reports a file written inside a watched folder to the client that watches it', async () => {
    const host = openHost(await openStore(await tempDir('bst-files-store-')));
    const folder = await projectFolder();
    const { rootId } = await host.pick(folder);
    const written = path.join(folder, 'src', 'added.ts');

    let onEvent: (event: WorkspaceFilesEvent) => void = () => undefined;
    const sawWrite = new Promise<{ change: FileSystemChange; watchId: string }>((resolve) => {
      onEvent = (event) => {
        const change =
          event.type === 'changes' ? event.changes.find((c) => c.path === written) : undefined;
        if (change) {
          resolve({ change, watchId: event.watchId });
        }
      };
    });
    const session = host.files.open((event) => onEvent(event));
    cleanups.push(() => session.close());

    const { watchId } = await session['files/watch']({ handle: directoryHandle(folder, rootId) });
    await writeFile(written, 'export const added = 1;\n');

    await expect(sawWrite).resolves.toEqual({
      change: expect.objectContaining({ kind: 'file', path: written }),
      watchId,
    });
  });

  it('refuses to watch a folder that is not mounted', async () => {
    const host = openHost(await openStore(await tempDir('bst-files-store-')));
    const folder = await projectFolder();
    const session = host.files.open(() => undefined);
    cleanups.push(() => session.close());

    await expect(session['files/watch']({ handle: directoryHandle(folder) })).rejects.toThrow(
      /exact mounted root/
    );
  });
});
