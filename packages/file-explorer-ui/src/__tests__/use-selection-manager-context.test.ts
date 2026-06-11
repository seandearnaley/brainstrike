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
  mode: 'explicit' as const,
  explicitPaths: new Set<string>(),
  ruleSetJson: null,
  materializedPaths: null,
  materializedAt: null,
  queryDescriptor: null,
};

function createMockStore(overrides: Partial<Record<string, unknown>> = {}) {
  const setSelectedFiles = vi.fn();
  const setFolderSelection = vi.fn();
  const mockState = {
    selectedFilePaths: new Set<string>(),
    maxSelectionCount: 10,
    setSelectedFiles,
    setFolderSelection,
    setQuerySelectionManifest: vi.fn(),
    selectionModel: defaultSelectionModel,
    querySelectionManifest: null,
    currentFolderId: 'root',
    // Multi-root (Phase 6 union): defaults keep single-root tests unchanged.
    activeRootIds: [] as string[],
    folderStates: {} as Record<string, { selectedFilePaths: Set<string> }>,
    ...overrides,
  };
  const mockStore = Object.assign(
    (selector: (s: typeof mockState) => unknown) => selector(mockState),
    { getState: () => mockState }
  );
  return {
    store: mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>,
    setSelectedFiles,
    setFolderSelection,
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
    expect(result.current.isRulesMode).toBe(false);
  });

  it('converts materializedPaths to composite keys in rules mode', () => {
    const { store } = createMockStore({
      currentFolderId: 'my-folder',
      selectionModel: {
        mode: 'rules' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: '{}',
        materializedPaths: new Set(['/src/index.ts', '/src/utils.ts']),
        materializedAt: new Date().toISOString(),
        queryDescriptor: null,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager());

    expect(result.current.isRulesMode).toBe(true);
    expect(result.current.effectiveSelection.size).toBe(2);
    // Composite keys are folderId|@|path
    expect(result.current.effectiveSelection.has('my-folder|@|/src/index.ts')).toBe(true);
    expect(result.current.effectiveSelection.has('my-folder|@|/src/utils.ts')).toBe(true);
  });

  it('falls back to selectedFilePaths when in rules mode without materializedPaths', () => {
    const selectedFilePaths = new Set(['fallback|@|/file.ts']);
    const { store } = createMockStore({
      selectedFilePaths,
      selectionModel: {
        mode: 'rules' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: '{}',
        materializedPaths: null,
        materializedAt: null,
        queryDescriptor: null,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager());

    expect(result.current.effectiveSelection).toBe(selectedFilePaths);
  });

  it('falls back to selectedFilePaths when in rules mode without currentFolderId', () => {
    const selectedFilePaths = new Set(['fallback|@|/file.ts']);
    const { store } = createMockStore({
      selectedFilePaths,
      currentFolderId: null,
      selectionModel: {
        mode: 'rules' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: '{}',
        materializedPaths: new Set(['/src/file.ts']),
        materializedAt: new Date().toISOString(),
        queryDescriptor: null,
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager());

    expect(result.current.effectiveSelection).toBe(selectedFilePaths);
  });

  it('uses the exact query manifest in query mode and exposes the canonical selected count', () => {
    const { store } = createMockStore({
      currentFolderId: 'my-folder',
      selectedFilePaths: new Set(),
      querySelectionManifest: {
        filePaths: ['/src/index.ts', '/src/utils.ts'],
        pathSet: new Set(['/src/index.ts', '/src/utils.ts']),
        directoryCounts: new Map([['/src', 2]]),
        fingerprint: 'query-fingerprint',
        snapshotId: 'snapshot-1',
        status: 'ready' as const,
        errorMessage: null,
      },
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set(['/src/index.ts']),
        materializedAt: new Date().toISOString(),
        queryDescriptor: {
          kind: 'recursive-select-all' as const,
          folderId: 'my-folder',
          rootPath: null,
          coveredDirectoryPaths: ['/src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'query-fingerprint',
          manifestSnapshotId: 'snapshot-1',
          useRegex: false,
          totalSelectedCount: 2,
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

  it('uses the stored materialized paths while a query manifest snapshot is still loading', () => {
    const { store } = createMockStore({
      currentFolderId: 'my-folder',
      selectedFilePaths: new Set(),
      querySelectionManifest: null,
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set(['/src/index.ts']),
        materializedAt: new Date().toISOString(),
        queryDescriptor: {
          kind: 'recursive-select-all' as const,
          folderId: 'my-folder',
          rootPath: null,
          coveredDirectoryPaths: ['/src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'query-fingerprint',
          manifestSnapshotId: 'snapshot-1',
          useRegex: false,
          totalSelectedCount: 600,
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
        currentFolderId: ROOT_A,
        selectedFilePaths: new Set([KEY_A]),
        activeRootIds: [ROOT_A, ROOT_B],
        folderStates: {
          // A's folderState is a STALE snapshot while A is focused — the
          // top-level set is its live value; the union must NOT read it.
          [ROOT_A]: { selectedFilePaths: new Set([`${ROOT_A}|@|stale.ts`]) },
          [ROOT_B]: { selectedFilePaths: new Set([KEY_B]) },
        },
      });
    }

    it('unions non-focused roots into effectiveSelection, count, and list', () => {
      const { store } = createTwoRootStore();
      vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

      const { result } = renderHook(() => useSelectionManager());

      expect(result.current.effectiveSelection).toEqual(new Set([KEY_A, KEY_B]));
      expect(result.current.selectedCount).toBe(2);
      expect(result.current.selectedFilesList).toEqual(expect.arrayContaining([KEY_A, KEY_B]));
      // The focused root's stale folderState snapshot must NOT leak in.
      expect(result.current.effectiveSelection.has(`${ROOT_A}|@|stale.ts`)).toBe(false);
    });

    it('keeps set identity when no other root has selections (memo stability)', () => {
      const selectedFilePaths = new Set([KEY_A]);
      const { store } = createMockStore({
        currentFolderId: ROOT_A,
        selectedFilePaths,
        activeRootIds: [ROOT_A, ROOT_B],
        folderStates: { [ROOT_B]: { selectedFilePaths: new Set<string>() } },
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
  });
});
