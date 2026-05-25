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
  const mockState = {
    selectedFilePaths: new Set<string>(),
    maxSelectionCount: 10,
    setSelectedFiles,
    setQuerySelectionManifest: vi.fn(),
    selectionModel: defaultSelectionModel,
    querySelectionManifest: null,
    currentFolderId: 'root',
    ...overrides,
  };
  const mockStore = Object.assign(
    (selector: (s: typeof mockState) => unknown) => selector(mockState),
    { getState: () => mockState }
  );
  return {
    store: mockStore as unknown as ReturnType<typeof useFileExplorerStoreContext>,
    setSelectedFiles,
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
});
