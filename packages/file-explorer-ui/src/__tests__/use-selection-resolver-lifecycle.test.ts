import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSelectionResolverCachesForTests,
  QUERY_SELECTION_LOADING_PROMOTION_MS,
  useSelectionResolver,
} from '../use-selection-resolver';

const useOptionalPGliteDatabaseMock = vi.fn();
const useFileExplorerStoreContextMock = vi.fn();
const loadQuerySelectionSnapshotMock = vi.fn();

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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dedupes delayed loading promotion across multiple resolver consumers', async () => {
    vi.useFakeTimers();
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

    expect(state.setQuerySelectionManifest).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUERY_SELECTION_LOADING_PROMOTION_MS);
    });
    expect(state.setQuerySelectionManifest).toHaveBeenCalledTimes(1);
  });

  it('starts the snapshot read when the database becomes available without restarting cold-start promotion', async () => {
    vi.useFakeTimers();
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

    useOptionalPGliteDatabaseMock.mockReturnValue(null);
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockReturnValue(new Promise<string[]>(() => undefined));

    const { rerender } = renderHook(() => useSelectionResolver());
    expect(state.setQuerySelectionManifest).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUERY_SELECTION_LOADING_PROMOTION_MS / 2);
    });
    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    rerender();

    expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUERY_SELECTION_LOADING_PROMOTION_MS / 2);
    });
    expect(state.setQuerySelectionManifest).toHaveBeenCalledTimes(1);
    expect(state.querySelectionManifest).toEqual(expect.objectContaining({ status: 'loading' }));
  });

  it('keeps no-snapshot overrides outside the materialized manifest base', () => {
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
          includedPaths: ['src/manual.ts'],
          includeFilters: ['**/*.ts'],
          kind: 'recursive-select-all' as const,
          manifestFingerprint: 'fp-1',
          manifestSnapshotId: null,
          rootPath: null,
          totalSelectedCount: 2,
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
      expect.objectContaining({ filePaths: ['src/index.ts'], status: 'ready' })
    );
    expect(result.current.effectiveRelativePaths).toEqual(['src/index.ts', 'src/manual.ts']);

    state.selectionModel = {
      ...state.selectionModel,
      queryDescriptor: {
        ...state.selectionModel.queryDescriptor,
        includedPaths: [],
        totalSelectedCount: 1,
      },
    };
    rerender();

    expect(result.current.effectiveRelativePaths).toEqual(['src/index.ts']);
  });

  it('keeps an error terminal until the database handle changes', async () => {
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null as null | {
        directoryCounts: Map<string, number>;
        errorMessage: string | null;
        filePaths: string[];
        fingerprint: string;
        pathSet: Set<string>;
        snapshotId: string;
        status: 'error' | 'loading' | 'ready';
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

    const firstDatabase = { query: vi.fn() };
    useOptionalPGliteDatabaseMock.mockReturnValue(firstDatabase);
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockRejectedValue(new Error('database failure'));

    const firstResolver = renderHook(() => useSelectionResolver());
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledTimes(1);
    expect(state.querySelectionManifest).toEqual(
      expect.objectContaining({ errorMessage: 'database failure', status: 'error' })
    );

    firstResolver.rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledTimes(1);

    firstResolver.unmount();
    const remountedResolver = renderHook(() => useSelectionResolver());
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledTimes(1);

    useOptionalPGliteDatabaseMock.mockReturnValue({ query: vi.fn() });
    remountedResolver.rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale database completion clear a replacement database error', async () => {
    vi.useFakeTimers();
    const firstLoad = Promise.withResolvers<string[]>();
    const replacementLoad = Promise.withResolvers<string[]>();
    const firstDatabase = { query: vi.fn() };
    const replacementDatabase = { query: vi.fn() };
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null as null | {
        directoryCounts: Map<string, number>;
        errorMessage: string | null;
        filePaths: string[];
        fingerprint: string;
        pathSet: Set<string>;
        snapshotId: string;
        status: 'error' | 'loading' | 'ready';
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

    useOptionalPGliteDatabaseMock.mockReturnValue(firstDatabase);
    useFileExplorerStoreContextMock.mockReturnValue({ getState: () => state });
    loadQuerySelectionSnapshotMock.mockImplementation((database) =>
      database === firstDatabase ? firstLoad.promise : replacementLoad.promise
    );

    const { rerender } = renderHook(() => useSelectionResolver());
    await act(async () => {
      vi.advanceTimersByTime(50);
      await Promise.resolve();
    });
    useOptionalPGliteDatabaseMock.mockReturnValue(replacementDatabase);
    rerender();

    await act(async () => {
      vi.advanceTimersByTime(10);
      await Promise.resolve();
    });

    firstLoad.resolve(['/src/stale.ts']);
    await act(async () => {
      await Promise.resolve();
    });

    state.querySelectionManifest = {
      directoryCounts: new Map(),
      errorMessage: 'unrelated error',
      filePaths: [],
      fingerprint: 'other-fingerprint',
      pathSet: new Set(),
      snapshotId: 'other-snapshot',
      status: 'error',
    };
    state.setQuerySelectionManifest.mockClear();
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(39);
      await Promise.resolve();
    });
    expect(state.setQuerySelectionManifest).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(state.setQuerySelectionManifest).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'fp-1', snapshotId: 'snapshot-1', status: 'loading' })
    );

    replacementLoad.reject(new Error('replacement database failed'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(state.querySelectionManifest).toEqual(
      expect.objectContaining({ errorMessage: 'replacement database failed', status: 'error' })
    );

    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    expect(loadQuerySelectionSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('does not let a late snapshot rejection downgrade a matching ready manifest', async () => {
    const { promise, reject } = Promise.withResolvers<string[]>();
    const state = {
      currentFolderId: 'folder-1',
      querySelectionManifest: null as null | {
        directoryCounts: Map<string, number>;
        errorMessage: string | null;
        filePaths: string[];
        fingerprint: string;
        pathSet: Set<string>;
        snapshotId: string;
        status: 'error' | 'loading' | 'ready';
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
    loadQuerySelectionSnapshotMock.mockReturnValue(promise);

    renderHook(() => useSelectionResolver());
    state.querySelectionManifest = {
      directoryCounts: new Map([['/src', 1]]),
      errorMessage: null,
      filePaths: ['/src/index.ts'],
      fingerprint: 'fp-1',
      pathSet: new Set(['/src/index.ts']),
      snapshotId: 'snapshot-1',
      status: 'ready',
    };

    await act(async () => {
      reject(new Error('late database failure'));
      await promise.catch(() => undefined);
    });

    expect(state.setQuerySelectionManifest).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' })
    );
    expect(state.querySelectionManifest.status).toBe('ready');
  });
});
