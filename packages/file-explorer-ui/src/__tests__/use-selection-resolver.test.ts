import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionResolver } from '../use-selection-resolver';

const useOptionalPGliteDatabaseMock = vi.fn();
const useFileExplorerStoreContextMock = vi.fn();
const loadQuerySelectionSnapshotMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  useOptionalPGliteDatabase: () => useOptionalPGliteDatabaseMock(),
}));

vi.mock('../shell/file-explorer-provider', () => ({
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
    useOptionalPGliteDatabaseMock.mockReset();
    useFileExplorerStoreContextMock.mockReset();
    loadQuerySelectionSnapshotMock.mockReset();
  });

  it('dedupes loading manifest transitions across multiple resolver consumers', () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null as null | {
        filePaths: string[];
        pathSet: Set<string>;
        directoryCounts: Map<string, number>;
        fingerprint: string;
        snapshotId: string;
        status: 'loading';
        errorMessage: null;
      },
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 600,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = {
      getState: () => state,
    };

    useOptionalPGliteDatabaseMock.mockReturnValue(null);
    useFileExplorerStoreContextMock.mockReturnValue(store);

    renderHook(() => useSelectionResolver());
    renderHook(() => useSelectionResolver());

    expect(state.setQuerySelectionManifest).toHaveBeenCalledTimes(1);
  });

  it('uses persisted materialized paths while the query manifest snapshot is unavailable', () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(['src/index.ts', 'src/utils.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 600,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn(),
    };

    const store = {
      getState: () => state,
    };

    useOptionalPGliteDatabaseMock.mockReturnValue(null);
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const { result } = renderHook(() => useSelectionResolver());

    expect(result.current.selectedCount).toBe(600);
    expect(result.current.effectiveRelativePaths).toEqual(['src/index.ts', 'src/utils.ts']);
    expect(result.current.selectedFilesList).toEqual([
      'folder-1|@|src/index.ts',
      'folder-1|@|src/utils.ts',
    ]);
  });

  it('removes excluded restored query paths from the effective file list before the manifest snapshot loads', () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(['src/index.ts', 'src/utils.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['src'],
          excludedPaths: ['src/utils.ts'],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-folder' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: 'src',
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn(),
    };

    const store = {
      getState: () => state,
    };

    useOptionalPGliteDatabaseMock.mockReturnValue(null);
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const { result } = renderHook(() => useSelectionResolver());

    expect(result.current.selectedCount).toBe(1);
    expect(result.current.effectiveRelativePaths).toEqual(['src/index.ts']);
    expect(result.current.selectedFilesList).toEqual(['folder-1|@|src/index.ts']);
  });

  it('publishes a ready manifest immediately when persisted materialized paths are exact', async () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(['src/index.ts', 'src/utils.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = {
      getState: () => state,
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const { result, rerender } = renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ['src/index.ts', 'src/utils.ts'],
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          status: 'ready',
        })
      );
    });

    rerender();

    expect(result.current.isQuerySelectionReady).toBe(true);
    expect(result.current.selectedCount).toBe(2);
  });

  it('publishes a ready manifest immediately when persisted materialized paths plus included overrides are exact', async () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(['src/index.ts', 'src/utils.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['src', 'src/components'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: ['eslint.config.js'],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-folder' as const,
          manifestFingerprint: 'fp-2',
          manifestSnapshotId: 'snapshot-2',
          rootPath: 'src',
          totalSelectedCount: 3,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = {
      getState: () => state,
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const { result, rerender } = renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ['eslint.config.js', 'src/index.ts', 'src/utils.ts'],
          fingerprint: 'fp-2',
          snapshotId: 'snapshot-2',
          status: 'ready',
        })
      );
    });

    rerender();

    expect(result.current.isQuerySelectionReady).toBe(true);
    expect(result.current.selectedCount).toBe(3);
  });

  it('loads and publishes a ready manifest from the persisted snapshot', async () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = { getState: () => state };
    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue(store);
    loadQuerySelectionSnapshotMock.mockResolvedValue(['/src/utils.ts', '/src/index.ts']);

    renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledWith(expect.any(Object), 'snapshot-1');
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ['/src/index.ts', '/src/utils.ts'],
          status: 'ready',
        })
      );
    });
  });

  it('keeps effectiveRelativePaths stable when unrelated query descriptor fields change', () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(['src/index.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn(),
    };

    const store = { getState: () => state };
    useOptionalPGliteDatabaseMock.mockReturnValue(null);
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const { result, rerender } = renderHook(() => useSelectionResolver());
    const initialPaths = result.current.effectiveRelativePaths;

    state.selectionModel = {
      ...state.selectionModel,
      queryDescriptor: {
        ...state.selectionModel.queryDescriptor,
        coveredDirectoryPaths: ['/src', '/src/nested'],
      },
    };

    rerender();

    expect(result.current.effectiveRelativePaths).toBe(initialPaths);
    expect(result.current.effectiveRelativePaths).toEqual(['src/index.ts']);
  });

  it('publishes an errored manifest when snapshot loading fails', async () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = { getState: () => state };
    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue(store);
    loadQuerySelectionSnapshotMock.mockRejectedValue(new Error('snapshot broken'));

    renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: 'snapshot broken',
          status: 'error',
        })
      );
    });
  });

  it('ignores stale snapshot resolutions after the query descriptor changes', async () => {
    let resolveFirst: ((paths: string[]) => void) | undefined;
    let resolveSecond: ((paths: string[]) => void) | undefined;

    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = { getState: () => state };
    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue(store);
    loadQuerySelectionSnapshotMock.mockImplementation((_: unknown, snapshotId: string) => {
      if (snapshotId === 'snapshot-1') {
        return new Promise<string[]>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return new Promise<string[]>((resolve) => {
        resolveSecond = resolve;
      });
    });

    const { rerender } = renderHook(() => useSelectionResolver());

    state.selectionModel = {
      ...state.selectionModel,
      queryDescriptor: {
        ...state.selectionModel.queryDescriptor,
        manifestFingerprint: 'fp-2',
        manifestSnapshotId: 'snapshot-2',
      },
    };
    state.querySelectionManifest = null;
    rerender();

    resolveFirst?.(['/src/stale.ts']);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.setQuerySelectionManifest).not.toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'fp-1',
        snapshotId: 'snapshot-1',
        status: 'ready',
      })
    );

    resolveSecond?.(['/src/fresh.ts']);
    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ['/src/fresh.ts'],
          fingerprint: 'fp-2',
          snapshotId: 'snapshot-2',
          status: 'ready',
        })
      );
    });
  });

  it('ignores snapshot completions after the resolver unmounts', async () => {
    let resolveSnapshot: ((paths: string[]) => void) | undefined;

    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: [],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          rootPath: null,
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    const store = { getState: () => state };
    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue(store);
    loadQuerySelectionSnapshotMock.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          resolveSnapshot = resolve;
        })
    );

    const { unmount } = renderHook(() => useSelectionResolver());
    unmount();

    resolveSnapshot?.(['/src/stale.ts']);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.setQuerySelectionManifest).not.toHaveBeenCalledWith(
      expect.objectContaining({
        filePaths: ['/src/stale.ts'],
        status: 'ready',
      })
    );
  });
});
