import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFileExplorerStoreContext } from '../file-explorer-provider';
import { useSelectionManager } from '../use-selection-manager-context';

vi.mock('../file-explorer-provider', () => {
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
};

function createMockStore(overrides: Partial<Record<string, unknown>> = {}) {
  const setSelectedFiles = vi.fn();
  const mockState = {
    selectedFilePaths: new Set<string>(),
    maxSelectionCount: 10,
    setSelectedFiles,
    selectionModel: defaultSelectionModel,
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

    const onSelectionLimitExceeded = vi.fn();
    const { result } = renderHook(() => useSelectionManager({ onSelectionLimitExceeded }));

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

    const { result } = renderHook(() => useSelectionManager({ onSelectionLimitExceeded: vi.fn() }));

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
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager({ onSelectionLimitExceeded: vi.fn() }));

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
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager({ onSelectionLimitExceeded: vi.fn() }));

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
      },
    });
    vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

    const { result } = renderHook(() => useSelectionManager({ onSelectionLimitExceeded: vi.fn() }));

    expect(result.current.effectiveSelection).toBe(selectedFilePaths);
  });
});
