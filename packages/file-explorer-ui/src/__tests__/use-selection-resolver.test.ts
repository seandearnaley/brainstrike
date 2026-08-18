// biome-ignore-all lint/style/noExcessiveLinesPerFile: Resolver lifecycle and snapshot tests intentionally share one stateful module-mock harness.
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSelectionResolverCachesForTests,
  QUERY_SELECTION_LOADING_PROMOTION_MS,
  useSelectionResolver,
} from '../use-selection-resolver';
import {
  __getSelectionProjectionCacheStatsForTests,
  __resetSelectionProjectionCachesForTests,
  getDirectorySelectedCount,
} from '../utils/selection-projection';

const useOptionalPGliteDatabaseMock = vi.fn();
const useFileExplorerStoreContextMock = vi.fn();
const loadQuerySelectionSnapshotMock = vi.fn();

vi.mock('@brainstrike/db', () => ({
  useOptionalPGliteDatabase: () => useOptionalPGliteDatabaseMock(),
}));
vi.mock('@brainstrike/db/react', () => ({
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
    __resetSelectionResolverCachesForTests();
    useOptionalPGliteDatabaseMock.mockReset();
    useFileExplorerStoreContextMock.mockReset();
    loadQuerySelectionSnapshotMock.mockReset();
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
    useOptionalPGliteDatabaseMock.mockReturnValue(null);
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
    useOptionalPGliteDatabaseMock.mockReturnValue(null);
    useFileExplorerStoreContextMock.mockReturnValue(store);

    const resolver = renderHook(() => useSelectionResolver(), { wrapper: StrictMode });

    expect(__getSelectionProjectionCacheStatsForTests().activeStructuralCacheConsumers).toBe(1);

    resolver.unmount();
    expect(__getSelectionProjectionCacheStatsForTests().activeStructuralCacheConsumers).toBe(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dedupes the in-flight snapshot read across multiple resolver consumers', () => {
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
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockReturnValue(new Promise<string[]>(() => undefined));

    renderHook(() => useSelectionResolver());
    renderHook(() => useSelectionResolver());

    expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it('publishes one ready transition when shared resolver consumers settle', async () => {
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
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockResolvedValue(['/src/index.ts']);

    renderHook(() => useSelectionResolver());
    renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ready' })
      );
    });

    expect(state.setQuerySelectionManifest).toHaveBeenCalledTimes(1);
  });

  it('reloads a matching snapshot when the ready manifest is invalidated', async () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: {
        directoryCounts: new Map<string, number>(),
        errorMessage: null,
        filePaths: ['/src/index.ts'],
        fingerprint: 'fp-1',
        pathSet: new Set(['/src/index.ts']),
        snapshotId: 'snapshot-1',
        status: 'ready' as const,
      } as null | {
        directoryCounts: Map<string, number>;
        errorMessage: null;
        filePaths: string[];
        fingerprint: string;
        pathSet: Set<string>;
        snapshotId: string;
        status: 'ready';
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
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockResolvedValue(['/src/index.ts']);

    const { rerender } = renderHook(() => useSelectionResolver());
    expect(loadQuerySelectionSnapshotMock).not.toHaveBeenCalled();

    state.querySelectionManifest = null;
    rerender();

    await waitFor(() => {
      expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledTimes(1);
    });
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

    useOptionalPGliteDatabaseMock.mockReturnValue(null);
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

  it('does not publish loading for a snapshot that resolves before bounded promotion', async () => {
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
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockResolvedValue(['/src/index.ts']);

    renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ready' })
      );
    });

    expect(state.setQuerySelectionManifest.mock.calls.map(([manifest]) => manifest.status)).toEqual(
      ['ready']
    );
  });

  it('promotes loading after the bounded delay and then publishes the ready manifest', async () => {
    vi.useFakeTimers();
    const { promise, resolve } = Promise.withResolvers<string[]>();
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
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
        state.selectionModel = {
          ...state.selectionModel,
          queryDescriptor: { ...state.selectionModel.queryDescriptor },
        };
      }),
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockReturnValue(promise);

    const { rerender } = renderHook(() => useSelectionResolver());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUERY_SELECTION_LOADING_PROMOTION_MS - 1);
    });
    expect(state.setQuerySelectionManifest).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(state.setQuerySelectionManifest).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'loading' })
    );
    rerender();

    await act(async () => {
      resolve(['/src/index.ts']);
      await promise;
    });

    expect(state.setQuerySelectionManifest.mock.calls.map(([manifest]) => manifest.status)).toEqual(
      ['loading', 'ready']
    );
  });

  it('commits only the latest descriptor during a rapid A to B change', async () => {
    vi.useFakeTimers();
    const first = Promise.withResolvers<string[]>();
    const second = Promise.withResolvers<string[]>();
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
          manifestFingerprint: 'fp-a',
          manifestSnapshotId: 'snapshot-a',
          rootPath: null,
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockImplementation((_: unknown, snapshotId: string) =>
      snapshotId === 'snapshot-a' ? first.promise : second.promise
    );

    const { rerender } = renderHook(() => useSelectionResolver());

    state.selectionModel = {
      ...state.selectionModel,
      queryDescriptor: {
        ...state.selectionModel.queryDescriptor,
        manifestFingerprint: 'fp-b',
        manifestSnapshotId: 'snapshot-b',
      },
    };
    rerender();

    await act(async () => {
      second.resolve(['/src/b.ts']);
      await second.promise;
      first.resolve(['/src/a.ts']);
      await first.promise;
      await vi.advanceTimersByTimeAsync(QUERY_SELECTION_LOADING_PROMOTION_MS);
    });

    expect(state.setQuerySelectionManifest).toHaveBeenCalledTimes(1);
    expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        filePaths: ['/src/b.ts'],
        fingerprint: 'fp-b',
        snapshotId: 'snapshot-b',
        status: 'ready',
      })
    );
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

  it('replaces a prior resolver error after the snapshot descriptor changes', async () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: {
        directoryCounts: new Map<string, number>(),
        errorMessage: 'old database failed',
        filePaths: [],
        fingerprint: 'fp-1',
        pathSet: new Set<string>(),
        snapshotId: 'snapshot-1',
        status: 'error' as const,
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
          manifestFingerprint: 'fp-2',
          manifestSnapshotId: 'snapshot-2',
          rootPath: null,
          totalSelectedCount: 1,
          useRegex: false,
        },
      },
      setQuerySelectionManifest: vi.fn((manifest) => {
        state.querySelectionManifest = manifest;
      }),
    };

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockRejectedValue(new Error('replacement database failed'));

    renderHook(() => useSelectionResolver());

    await waitFor(() => {
      expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: 'replacement database failed',
          status: 'error',
        })
      );
    });
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

    expect(state.setQuerySelectionManifest.mock.calls.map(([manifest]) => manifest.status)).toEqual(
      ['error']
    );
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
    vi.useFakeTimers();
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

    await vi.advanceTimersByTimeAsync(QUERY_SELECTION_LOADING_PROMOTION_MS);

    resolveSnapshot?.(['/src/stale.ts']);
    await Promise.resolve();
    await Promise.resolve();

    expect(state.setQuerySelectionManifest).not.toHaveBeenCalled();
  });
});
