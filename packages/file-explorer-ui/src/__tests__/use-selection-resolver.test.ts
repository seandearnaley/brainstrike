import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionResolver } from '../use-selection-resolver';

const usePGliteDatabaseMock = vi.fn();
const useFileExplorerStoreContextMock = vi.fn();
const loadQuerySelectionSnapshotMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: () => usePGliteDatabaseMock(),
}));

vi.mock('../file-explorer-provider', () => ({
  useFileExplorerStoreContext: () => useFileExplorerStoreContextMock(),
  useFileExplorerStoreSelector: vi.fn((selector: (state: unknown) => unknown) => {
    const store = useFileExplorerStoreContextMock();
    return selector(store.getState());
  }),
}));

vi.mock('../utils/query-selection-snapshot', () => ({
  loadQuerySelectionSnapshot: (...args: unknown[]) => loadQuerySelectionSnapshotMock(...args),
}));

describe('useSelectionResolver', () => {
  beforeEach(() => {
    usePGliteDatabaseMock.mockReset();
    useFileExplorerStoreContextMock.mockReset();
    loadQuerySelectionSnapshotMock.mockReset();
  });

  it('dedupes loading manifest transitions across multiple resolver consumers', () => {
    const state = {
      currentFolderId: 'folder-1',
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set<string>(),
        materializedAt: null,
        queryDescriptor: {
          kind: 'recursive-select-all' as const,
          folderId: 'folder-1',
          rootPath: null,
          coveredDirectoryPaths: ['/src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          totalSelectedCount: 600,
          useRegex: false,
        },
      },
      querySelectionManifest: null as null | {
        filePaths: string[];
        pathSet: Set<string>;
        directoryCounts: Map<string, number>;
        fingerprint: string;
        snapshotId: string;
        status: 'loading';
        errorMessage: null;
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = {
      getState: () => state,
    };

    usePGliteDatabaseMock.mockReturnValue(null);
    useFileExplorerStoreContextMock.mockReturnValue(store);

    renderHook(() => useSelectionResolver());
    renderHook(() => useSelectionResolver());

    expect(state.setQuerySelectionManifest).toHaveBeenCalledTimes(1);
  });

  it('uses persisted materialized paths while the query manifest snapshot is unavailable', () => {
    const state = {
      currentFolderId: 'folder-1',
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set<string>(['src/index.ts', 'src/utils.ts']),
        materializedAt: null,
        queryDescriptor: {
          kind: 'recursive-select-all' as const,
          folderId: 'folder-1',
          rootPath: null,
          coveredDirectoryPaths: ['/src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          totalSelectedCount: 600,
          useRegex: false,
        },
      },
      querySelectionManifest: null,
      setQuerySelectionManifest: vi.fn(),
    };

    const store = {
      getState: () => state,
    };

    usePGliteDatabaseMock.mockReturnValue(null);
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const { result } = renderHook(() => useSelectionResolver());

    expect(result.current.selectedCount).toBe(600);
    expect(result.current.effectiveRelativePaths).toEqual(['src/index.ts', 'src/utils.ts']);
    expect(result.current.selectedFilesList).toEqual([
      'folder-1|@|src/index.ts',
      'folder-1|@|src/utils.ts',
    ]);
  });

  it('loads and publishes a ready manifest from the persisted snapshot', async () => {
    const state = {
      currentFolderId: 'folder-1',
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set<string>(),
        materializedAt: null,
        queryDescriptor: {
          kind: 'recursive-select-all' as const,
          folderId: 'folder-1',
          rootPath: null,
          coveredDirectoryPaths: ['/src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
      querySelectionManifest: null,
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = { getState: () => state };
    usePGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue(store);
    loadQuerySelectionSnapshotMock.mockResolvedValue(['/src/utils.ts', '/src/index.ts']);

    renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledWith(expect.any(Object), 'snapshot-1');
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          filePaths: ['/src/index.ts', '/src/utils.ts'],
        })
      );
    });
  });

  it('publishes an errored manifest when snapshot loading fails', async () => {
    const state = {
      currentFolderId: 'folder-1',
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set<string>(),
        materializedAt: null,
        queryDescriptor: {
          kind: 'recursive-select-all' as const,
          folderId: 'folder-1',
          rootPath: null,
          coveredDirectoryPaths: ['/src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: [],
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
      querySelectionManifest: null,
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = { getState: () => state };
    usePGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue(store);
    loadQuerySelectionSnapshotMock.mockRejectedValue(new Error('snapshot broken'));

    renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          errorMessage: 'snapshot broken',
        })
      );
    });
  });
});
