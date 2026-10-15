import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import { useSelectionManager } from '../shell/use-selection-manager-context';

vi.mock('../shell/file-explorer-provider', () => {
  const useFileExplorerStoreContext = vi.fn();
  return {
    useFileExplorerStoreContext,
    useFileExplorerStoreSelector: vi.fn((selector: (state: unknown) => unknown) => {
      const store = useFileExplorerStoreContext();
      return store(selector);
    }),
  };
});

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useSelectionManager: vi.fn(({ selectedFilePaths, setSelectedFiles }) => ({
    handleSelectionChange: vi.fn((next) => setSelectedFiles?.(next)),
    selectedFilePaths,
  })),
}));

const defaultSelectionModel = {
  explicitPaths: new Set<string>(),
  materializedAt: null,
  materializedPaths: null,
  mode: 'explicit' as const,
  queryDescriptor: null,
};

function createMockStore(overrides: Partial<Record<string, unknown>> = {}) {
  const setSelectedFiles = vi.fn();
  const setFolderSelection = vi.fn();
  const mockState = {
    // Multi-root (Phase 6 union): defaults keep single-root tests unchanged.
    activeRootIds: [] as string[],
    currentFolderId: 'root',
    folderStates: {} as Record<string, { selectedFilePaths: Set<string> }>,
    maxSelectionCount: 10,
    querySelectionManifest: null,
    selectedFilePaths: new Set<string>(),
    selectionModel: defaultSelectionModel,
    setFolderSelection,
    setQuerySelectionManifest: vi.fn(),
    setSelectedFiles,
    ...overrides,
  };
  const mockStore = Object.assign(
    (selector: (s: typeof mockState) => unknown) => selector(mockState),
    { getState: () => mockState }
  );
  return {
    setFolderSelection,
    setSelectedFiles,
    store: mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>,
  };
}

describe('useSelectionManager', () => {
  it('initializes with store state', () => {
    const { store, setSelectedFiles } = createMockStore({
      selectedFilePaths: new Set(['file1.ts']),
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
    const { result } = renderHook(() => useSelectionManager());

    expect(result.current.selectedFilesList).toEqual(['file1.ts']);

    // Test setSelectedFilesStable via setSelectedFilesFromList
    result.current.setSelectedFilesFromList(['file1.ts', 'file2.ts']);
    expect(setSelectedFiles).toHaveBeenCalled();
    const call = setSelectedFiles.mock.calls[0]![0];
    expect(call).toBeInstanceOf(Set);
    expect(Array.from(call as Set<string>)).toEqual(['file1.ts', 'file2.ts']);
  });

  it('returns selectedFilePaths as effectiveSelection in explicit mode', () => {
    const selectedFilePaths = new Set(['root|@|/src/file.ts']);
    const { store } = createMockStore({ selectedFilePaths });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager());

    expect(result.current.effectiveSelection).toBe(selectedFilePaths);
  });

  it('uses the exact query manifest in query mode and exposes the canonical selected count', () => {
    const { store } = createMockStore({
      currentFolderId: 'my-folder',
      querySelectionManifest: {
        directoryCounts: new Map([['/src', 2]]),
        errorMessage: null,
        filePaths: ['/src/index.ts', '/src/utils.ts'],
        fingerprint: 'query-fingerprint',
        pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready' as const,
      },
      selectedFilePaths: new Set(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: new Date().toISOString(),
        materializedPaths: new Set(['/src/index.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'my-folder',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'query-fingerprint',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager());

    expect(result.current.isQueryMode).toBe(true);
    expect(result.current.selectedCount).toBe(2);
    expect(result.current.selectedFilesList).toEqual([
      'my-folder|@|/src/index.ts',
      'my-folder|@|/src/utils.ts',
    ]);
    expect(result.current.effectiveSelection).toEqual(
      new Set(['my-folder|@|/src/index.ts', 'my-folder|@|/src/utils.ts'])
    );
  });

  it("adds the other roots' selections to the forest selection in query mode", () => {
    const { store } = createMockStore({
      activeRootIds: ['my-folder', 'other'],
      currentFolderId: 'my-folder',
      folderStates: { other: { selectedFilePaths: new Set(['other|@|/b.ts']) } },
      querySelectionManifest: {
        directoryCounts: new Map([['/src', 1]]),
        errorMessage: null,
        filePaths: ['/src/index.ts'],
        fingerprint: 'query-fingerprint',
        pathSet: new Set(['/src/index.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready' as const,
      },
      selectedFilePaths: new Set(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: new Date().toISOString(),
        materializedPaths: new Set(['/src/index.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'my-folder',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'query-fingerprint',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager());

    // The count and the forest selection describe the same files.
    expect(result.current.selectedCount).toBe(2);
    expect(result.current.forestSelection).toEqual(
      new Set(['my-folder|@|/src/index.ts', 'other|@|/b.ts'])
    );
    // The focused root's own selection is unchanged.
    expect(result.current.effectiveSelection).toEqual(new Set(['my-folder|@|/src/index.ts']));
  });

  it('uses the stored materialized paths while a query manifest snapshot is still loading', () => {
    const { store } = createMockStore({
      currentFolderId: 'my-folder',
      querySelectionManifest: null,
      selectedFilePaths: new Set(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: new Date().toISOString(),
        materializedPaths: new Set(['/src/index.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'my-folder',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'query-fingerprint',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 600,
          useRegex: false,
        },
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager());

    expect(result.current.isQueryMode).toBe(true);
    expect(result.current.selectedCount).toBe(600);
    expect(result.current.selectedFilesList).toEqual(['my-folder|@|/src/index.ts']);
    expect(result.current.effectiveSelection).toEqual(new Set(['my-folder|@|/src/index.ts']));
  });

  describe('cross-root union (Phase 6, explicit mode)', () => {
    const ROOT_A = 'aaaaaaaa-0000-4000-8000-000000000001';
    const ROOT_B = 'bbbbbbbb-0000-4000-8000-000000000002';
    const KEY_A = `${ROOT_A}|@|src/a.ts`;
    const KEY_B = `${ROOT_B}|@|src/b.ts`;

    function createTwoRootStore() {
      return createMockStore({
        activeRootIds: [ROOT_A, ROOT_B],
        currentFolderId: ROOT_A,
        folderStates: {
          // A's folderState is a STALE snapshot while A is focused — the
          // top-level set is its live value; the union must NOT read it.
          [ROOT_A]: { selectedFilePaths: new Set([`${ROOT_A}|@|stale.ts`]) },
          [ROOT_B]: { selectedFilePaths: new Set([KEY_B]) },
        },
        selectedFilePaths: new Set([KEY_A]),
      });
    }

    it('unions non-focused roots into effectiveSelection, count, and list', () => {
      const { store } = createTwoRootStore();
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

      const { result } = renderHook(() => useSelectionManager());

      expect(result.current.effectiveSelection).toEqual(new Set([KEY_A, KEY_B]));
      expect(result.current.forestSelection).toBe(result.current.effectiveSelection);
      expect(result.current.selectedCount).toBe(2);
      expect(result.current.selectedFilesList).toEqual(expect.arrayContaining([KEY_A, KEY_B]));
      // The focused root's stale folderState snapshot must NOT leak in.
      expect(result.current.effectiveSelection.has(`${ROOT_A}|@|stale.ts`)).toBe(false);
    });

    it('keeps set identity when no other root has selections (memo stability)', () => {
      const selectedFilePaths = new Set([KEY_A]);
      const { store } = createMockStore({
        activeRootIds: [ROOT_A, ROOT_B],
        currentFolderId: ROOT_A,
        folderStates: { [ROOT_B]: { selectedFilePaths: new Set<string>() } },
        selectedFilePaths,
      });
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

      const { result } = renderHook(() => useSelectionManager());

      expect(result.current.effectiveSelection).toBe(selectedFilePaths);
    });

    it('partitions write-backs: focused keys to the core, others to setFolderSelection', () => {
      const { store, setSelectedFiles, setFolderSelection } = createTwoRootStore();
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

      const { result } = renderHook(() => useSelectionManager());

      // Deselect B's file: keep only A's key.
      result.current.setSelectedFilesFromList([KEY_A]);

      expect(setFolderSelection).toHaveBeenCalledExactlyOnceWith(ROOT_B, []);
      const coreCall = setSelectedFiles.mock.calls.at(-1)?.[0] as Set<string>;
      expect(Array.from(coreCall)).toEqual([KEY_A]);
    });

    it('routes a non-focused root NEW selection through setFolderSelection', () => {
      const { store, setSelectedFiles, setFolderSelection } = createTwoRootStore();
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

      const { result } = renderHook(() => useSelectionManager());

      const KEY_B2 = `${ROOT_B}|@|src/b2.ts`;
      result.current.setSelectedFilesFromList([KEY_A, KEY_B, KEY_B2]);

      expect(setFolderSelection).toHaveBeenCalledExactlyOnceWith(
        ROOT_B,
        expect.arrayContaining([KEY_B, KEY_B2])
      );
      const coreCall = setSelectedFiles.mock.calls.at(-1)?.[0] as Set<string>;
      expect(Array.from(coreCall)).toEqual([KEY_A]);
    });

    it('drops a key whose rootId is no longer active (no mis-attribution to focused)', () => {
      const { store, setSelectedFiles, setFolderSelection } = createTwoRootStore();
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

      const { result } = renderHook(() => useSelectionManager());

      // A lingering key from a disconnected root (rootId not in activeRootIds).
      const KEY_GONE = 'cccccccc-0000-4000-8000-000000000003|@|src/gone.ts';
      result.current.setSelectedFilesFromList([KEY_A, KEY_GONE]);

      // The stale key is neither bucketed to a folderState nor funneled into the
      // focused root's top-level set — it is simply discarded.
      expect(setFolderSelection).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining([KEY_GONE])
      );
      const coreCall = setSelectedFiles.mock.calls.at(-1)?.[0] as Set<string>;
      expect(Array.from(coreCall)).toEqual([KEY_A]);
    });
  });
});
