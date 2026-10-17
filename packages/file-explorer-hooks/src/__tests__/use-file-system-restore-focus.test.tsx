import { createFileExplorerStore } from '@brainstrike/file-explorer';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { createMemoryStorageAdapter } from '@brainstrike/storage';
import type { RootDescriptor } from '@brainstrike/types';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useFileSystem } from '../use-file-system.js';
import { createAdaptersTestWrapper } from './test-helpers.js';

// BST-1897: a restart refocused the least recently focused root. The store's
// real focus actions write folderAccessOrder here, so these tests pin the
// order its producer actually writes, not a hand-written fixture of it.
function root(name: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path: `/work/${name}`, platform: 'electron' },
    kind: 'path',
    permissionState: 'granted',
    persisted: true,
    rootId: `root-${name}`,
  };
}

const PARENT = root('projects');
const CHILD = root('app');
const NOTES = root('notes');

/** A previous session: these roots mounted (first is Main), focused in `focusOrder`. */
function restartAfter(
  mounted: readonly RootDescriptor[],
  focusOrder: readonly RootDescriptor[],
  restored: readonly RootDescriptor[] = mounted
) {
  const storage = createMemoryStorageAdapter();
  const store = createFileExplorerStore(storage);
  const state = store.getState();
  state.setActiveRoots(
    mounted.map(({ displayName, handle, rootId }) => ({ displayName, path: handle.path, rootId }))
  );
  for (const focused of focusOrder) {
    store.getState().setCurrentFolderId(focused.rootId);
  }
  const adapter: FileSystemAdapter = {
    exists: vi.fn().mockResolvedValue(true),
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
    restoreRoots: vi.fn(async () => [...restored]),
  };
  // Built once: the hook's restore effect depends on these callbacks' identity.
  const parameters: Parameters<typeof useFileSystem>[0] = {
    addActiveRoot: state.addActiveRoot,
    getFolderAccessOrder: () => store.getState().folderAccessOrder,
    getPersistedCurrentFolderId: () => store.getState().currentFolderId,
    removeActiveRoot: state.removeActiveRoot,
    setActiveRoots: state.setActiveRoots,
    setCurrentFolderId: state.setCurrentFolderId,
  };
  const hook = renderHook(() => useFileSystem(parameters), {
    wrapper: createAdaptersTestWrapper(adapter, storage),
  });
  return { ...hook, store };
}

test('a restart refocuses the root focused last, not Main', async () => {
  const { result, store } = restartAfter([PARENT, CHILD], [PARENT, CHILD]);

  await waitFor(() => expect(result.current.rootDirectoryHandles).toHaveLength(2));
  expect(result.current.rootDirectoryHandle?.rootId).toBe(CHILD.rootId);
  expect(store.getState().currentFolderId).toBe(CHILD.rootId);
  expect(store.getState().activeRootIds).toEqual([PARENT.rootId, CHILD.rootId]);
});

test('a restart refocuses the newest root of a longer focus history', async () => {
  const { result } = restartAfter([PARENT, CHILD, NOTES], [CHILD, NOTES, PARENT, NOTES]);

  await waitFor(() => expect(result.current.rootDirectoryHandles).toHaveLength(3));
  expect(result.current.rootDirectoryHandle?.rootId).toBe(NOTES.rootId);
});

test('a restart skips a root that did not come back and takes the next most recent', async () => {
  const { result } = restartAfter([PARENT, CHILD, NOTES], [PARENT, CHILD, NOTES], [PARENT, CHILD]);

  await waitFor(() => expect(result.current.rootDirectoryHandles).toHaveLength(2));
  expect(result.current.rootDirectoryHandle?.rootId).toBe(CHILD.rootId);
});
