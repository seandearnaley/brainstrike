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

    useOptionalPGliteDatabaseMock.mockReturnValue(null);
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
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set<string>(['src/index.ts', 'src/utils.ts']),
        materializedAt: null,
        queryDescriptor: {
          kind: 'recursive-folder' as const,
          folderId: 'folder-1',
          rootPath: 'src',
          coveredDirectoryPaths: ['src'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: [],
          excludedPaths: ['src/utils.ts'],
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: 'snapshot-1',
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      querySelectionManifest: null,
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
          totalSelectedCount: 2,
          useRegex: false,
        },
      },
      querySelectionManifest: null,
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
          status: 'ready',
          fingerprint: 'fp-1',
          snapshotId: 'snapshot-1',
          filePaths: ['src/index.ts', 'src/utils.ts'],
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
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set<string>(['src/index.ts', 'src/utils.ts']),
        materializedAt: null,
        queryDescriptor: {
          kind: 'recursive-folder' as const,
          folderId: 'folder-1',
          rootPath: 'src',
          coveredDirectoryPaths: ['src', 'src/components'],
          includeFilters: ['**/*.ts'],
          excludeFilters: [],
          includedPaths: ['eslint.config.js'],
          excludedPaths: [],
          manifestFingerprint: 'fp-2',
          manifestSnapshotId: 'snapshot-2',
          totalSelectedCount: 3,
          useRegex: false,
        },
      },
      querySelectionManifest: null,
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
          status: 'ready',
          fingerprint: 'fp-2',
          snapshotId: 'snapshot-2',
          filePaths: ['eslint.config.js', 'src/index.ts', 'src/utils.ts'],
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
    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
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

  it('keeps effectiveRelativePaths stable when unrelated query descriptor fields change', () => {
    const state = {
      currentFolderId: 'folder-1',
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        mode: 'query' as const,
        explicitPaths: new Set<string>(),
        ruleSetJson: null,
        materializedPaths: new Set<string>(['src/index.ts']),
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
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      querySelectionManifest: null,
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
    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
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

  it('ignores stale snapshot resolutions after the query descriptor changes', async () => {
    let resolveFirst: ((paths: string[]) => void) | undefined;
    let resolveSecond: ((paths: string[]) => void) | undefined;

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
        status: 'ready',
        fingerprint: 'fp-1',
        snapshotId: 'snapshot-1',
      })
    );

    resolveSecond?.(['/src/fresh.ts']);
    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          fingerprint: 'fp-2',
          snapshotId: 'snapshot-2',
          filePaths: ['/src/fresh.ts'],
        })
      );
    });
  });

  it('ignores snapshot completions after the resolver unmounts', async () => {
    let resolveSnapshot: ((paths: string[]) => void) | undefined;

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
        status: 'ready',
        filePaths: ['/src/stale.ts'],
      })
    );
  });
});
