import { createFileExplorerStore } from '@brainstrike/file-explorer';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import { createMemoryStorageAdapter } from '@brainstrike/storage';
import type { RootDescriptor } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { useFileSystem } from '../use-file-system.js';
import { createAdaptersTestWrapper } from './test-helpers.js';

// The incident's four persisted, unavailable roots were reported as unknown.
// Paths/names are disposable fixtures; ids and permission/persistence facts
// follow the exported 2026-10-13 runtime records.
const unavailable: RootDescriptor[] = [
  '6fe91e36-83f2-4e90-915b-055b455460b7',
  'fe0e70d8-2af7-49c2-a4ae-725b309d6c6a',
  '459380ea-8660-4dd8-9283-8c5ff86f87d1',
  'b6f13b6b-9049-4f50-be14-2cd3174a576d',
].map((rootId, index) => ({
  displayName: `saved-${index}`,
  handle: {
    kind: 'directory',
    name: `saved-${index}`,
    path: `/fixture/saved-${index}`,
    platform: 'electron',
  },
  kind: 'path',
  permissionState: 'unknown',
  persisted: true,
  rootId,
}));
const saved = unavailable[0]!;

function setup(
  restoreRoots: () => Promise<RootDescriptor[]>,
  waitForHydration?: () => Promise<void>
) {
  const storage = createMemoryStorageAdapter();
  const store = createFileExplorerStore(storage);
  const state = store.getState();
  state.setActiveRoots(
    unavailable.map(({ displayName, handle, rootId }) => ({
      displayName,
      path: handle.path,
      rootId,
    }))
  );
  state.setCurrentFolderId(saved.rootId);
  state.addSelectedFile(saved.rootId, 'selected.md');
  const adapter: FileSystemAdapter = {
    exists: vi.fn().mockResolvedValue(false),
    readDirectory: vi.fn().mockResolvedValue([]),
    readFile: vi.fn(),
    requestDirectoryAccess: vi.fn(),
    restoreRoots,
  };
  const parameters: Parameters<typeof useFileSystem>[0] = {
    addActiveRoot: state.addActiveRoot,
    getFolderAccessOrder: () => store.getState().folderAccessOrder,
    getPersistedCurrentFolderId: () => store.getState().currentFolderId,
    removeActiveRoot: state.removeActiveRoot,
    setActiveRoots: state.setActiveRoots,
    setCurrentFolderId: state.setCurrentFolderId,
    ...(waitForHydration ? { waitForHydration } : {}),
  };
  const hook = renderHook(() => useFileSystem(parameters), {
    wrapper: createAdaptersTestWrapper(adapter, storage),
  });
  return { ...hook, store };
}

test.each([
  ['unavailable', unavailable],
  ['empty', []],
] as const)(
  '%s authoritative restore retires stale active roots and focus while retaining saved selection',
  async (_label, restored) => {
    const { result, store } = setup(async () => [...restored]);
    await waitFor(() => expect(store.getState().activeRootIds).toEqual([]));
    expect(store.getState().rootDescriptors).toEqual({});
    expect(store.getState().currentFolderId).toBeNull();
    expect(result.current.rootDirectoryHandles).toEqual([]);
    expect(result.current.rootDirectoryHandle).toBeNull();
    expect(store.getState().selectedFilePaths.size).toBe(0);
    const selected = encodeFileSelection(saved.rootId, 'selected.md');
    expect(store.getState().folderStates[saved.rootId]?.selectedFilePaths).toEqual(
      new Set([selected])
    );
    // An explicit re-mount restores that same root's selection, not another id.
    act(() => store.getState().setCurrentFolderId(saved.rootId));
    expect(store.getState().selectedFilePaths).toEqual(new Set([selected]));
  }
);

test('empty restore waits for hydration before replacing the restored view', async () => {
  const hydration = Promise.withResolvers<void>();
  const waitForHydration = vi.fn(() => hydration.promise);
  const { store } = setup(async () => unavailable, waitForHydration);
  await waitFor(() => expect(waitForHydration).toHaveBeenCalledOnce());
  expect(store.getState().currentFolderId).toBe(saved.rootId);
  await act(async () => hydration.resolve());
  await waitFor(() => expect(store.getState().currentFolderId).toBeNull());
  expect(store.getState().activeRootIds).toEqual([]);
});

test('a retired restore cannot clear the replacement view after hydration', async () => {
  const hydration = Promise.withResolvers<void>();
  const waitForHydration = vi.fn(() => hydration.promise);
  const { store, unmount } = setup(async () => unavailable, waitForHydration);
  await waitFor(() => expect(waitForHydration).toHaveBeenCalledOnce());
  unmount();
  await act(async () => hydration.resolve());
  expect(store.getState().currentFolderId).toBe(saved.rootId);
  expect(store.getState().activeRootIds).toHaveLength(4);
});

test('failed restore is not an authoritative empty root set', async () => {
  const restoreRoots = vi.fn().mockRejectedValue(new Error('fixture restore failure'));
  const { result, store } = setup(restoreRoots);
  await waitFor(() => expect(restoreRoots).toHaveBeenCalledOnce());
  await waitFor(() => expect(result.current.isAccessLoading).toBe(false));
  expect(store.getState().currentFolderId).toBe(saved.rootId);
  expect(store.getState().activeRootIds).toHaveLength(4);
});
