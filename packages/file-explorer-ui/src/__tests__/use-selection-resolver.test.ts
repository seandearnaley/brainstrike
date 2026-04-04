import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSelectionResolver } from '../use-selection-resolver';

const usePGliteDatabaseMock = vi.fn();
const useFileExplorerStoreContextMock = vi.fn();

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

describe('useSelectionResolver', () => {
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
});
