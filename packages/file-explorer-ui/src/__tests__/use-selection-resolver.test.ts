import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSelectionResolver } from '../use-selection-resolver';
import {
  __getSelectionProjectionCacheStatsForTests,
  __resetSelectionProjectionCachesForTests,
  getDirectorySelectedCount,
} from '../utils/selection-projection';

const useFileExplorerStoreContextMock = vi.fn();

vi.mock('../shell/file-explorer-provider', () => ({
  useFileExplorerStoreContext: () => useFileExplorerStoreContextMock(),
  useFileExplorerStoreSelector: vi.fn((selector: (state: unknown) => unknown) => {
    const store = useFileExplorerStoreContextMock();
    return selector(store.getState());
  }),
}));

describe('useSelectionResolver', () => {
  beforeEach(() => {
    useFileExplorerStoreContextMock.mockReset();
    __resetSelectionProjectionCachesForTests();
  });

  it('retains the shared structural cache until the last resolver consumer unmounts', () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: {
        directoryCounts: new Map<string, number>(),
        errorMessage: null,
        filePaths: [] as string[],
        fingerprint: 'fp-1',
        pathSet: new Set<string>(),
        snapshotId: 'snapshot-1',
        status: 'loading' as const,
      },
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set(['/src/index.ts']),
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
      setQuerySelectionManifest: vi.fn(),
    };
    const store = { getState: () => state };
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const firstResolver = renderHook(() => useSelectionResolver());
    const secondResolver = renderHook(() => useSelectionResolver());
    getDirectorySelectedCount(
      state.selectionModel.queryDescriptor,
      null,
      'folder-1',
      '/src',
      new Set(['/src/index.ts'])
    );

    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      activeStructuralCacheConsumers: 2,
      materializedStructuralEntries: 1,
    });

    state.selectionModel.queryDescriptor = {
      ...state.selectionModel.queryDescriptor,
      totalSelectedCount: 3,
    };
    firstResolver.rerender();
    secondResolver.rerender();
    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      activeStructuralCacheConsumers: 2,
      materializedStructuralEntries: 1,
    });

    firstResolver.unmount();
    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      activeStructuralCacheConsumers: 1,
      materializedStructuralEntries: 1,
    });

    secondResolver.unmount();
    expect(__getSelectionProjectionCacheStatsForTests()).toMatchObject({
      activeStructuralCacheConsumers: 0,
      materializedStructuralEntries: 0,
    });
  });

  it('keeps one cache owner across the StrictMode effect replay', () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: {
        directoryCounts: new Map<string, number>(),
        errorMessage: null,
        filePaths: [] as string[],
        fingerprint: 'fp-1',
        pathSet: new Set<string>(),
        snapshotId: 'snapshot-1',
        status: 'loading' as const,
      },
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set(['/src/index.ts']),
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
      setQuerySelectionManifest: vi.fn(),
    };
    const store = { getState: () => state };
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const resolver = renderHook(() => useSelectionResolver(), { wrapper: StrictMode });

    expect(__getSelectionProjectionCacheStatsForTests().activeStructuralCacheConsumers).toBe(1);

    resolver.unmount();
    expect(__getSelectionProjectionCacheStatsForTests().activeStructuralCacheConsumers).toBe(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves filtered materialized paths when no snapshot can be loaded', () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null,
      selectedFilePaths: new Set<string>(),
      selectionModel: {
        explicitPaths: new Set<string>(),
        materializedAt: null,
        materializedPaths: new Set<string>(['src/index.ts', 'src/excluded.ts']),
        mode: 'query' as const,
        queryDescriptor: {
          coveredDirectoryPaths: ['/src'],
          excludedPaths: ['src/excluded.ts'],
          excludeFilters: [],
          folderId: 'folder-1',
          includedPaths: [],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: null,
          rootPath: null,
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });

    const { result, rerender } = renderHook(() => useSelectionResolver());
    rerender();

    expect(state.querySelectionManifest).toEqual(
      expect.objectContaining({
        filePaths: ['src/excluded.ts', 'src/index.ts'],
        status: 'ready',
      })
    );
    expect(result.current.effectiveRelativePaths).toEqual(['src/index.ts']);
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

    useFileExplorerStoreContextMock.mockReturnValue(store);

    const { result, rerender } = renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ['src/index.ts', 'src/utils.ts'],
          fingerprint: 'fp-2',
          snapshotId: 'snapshot-2',
          status: 'ready',
        })
      );
    });

    rerender();
    expect(result.current.effectiveRelativePaths).toEqual([
      'eslint.config.js',
      'src/index.ts',
      'src/utils.ts',
    ]);

    state.selectionModel = {
      ...state.selectionModel,
      queryDescriptor: {
        ...state.selectionModel.queryDescriptor,
        includedPaths: [],
        totalSelectedCount: 2,
      },
    };
    rerender();

    expect(result.current.isQuerySelectionReady).toBe(true);
    expect(result.current.effectiveRelativePaths).toEqual(['src/index.ts', 'src/utils.ts']);
    expect(result.current.selectedCount).toBe(2);
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
});
