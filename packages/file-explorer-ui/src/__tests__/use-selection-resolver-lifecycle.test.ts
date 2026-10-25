import { act } from '@brainstrike/test-utils/react-act';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QUERY_SELECTION_LOADING_PROMOTION_MS,
  useSelectionResolver,
} from '../use-selection-resolver';

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

    useFileExplorerStoreContextMock.mockReturnValue(store);

    renderHook(() => useSelectionResolver());
    renderHook(() => useSelectionResolver());

    expect(state.setQuerySelectionManifest).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(QUERY_SELECTION_LOADING_PROMOTION_MS);
    });
    expect(state.setQuerySelectionManifest).toHaveBeenCalledTimes(1);
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
});
