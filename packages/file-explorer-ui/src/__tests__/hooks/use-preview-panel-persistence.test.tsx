import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ColumnVisibility,
  type PreviewPanelPreferences,
  preferencesEqual,
  usePreviewPanelPersistence,
} from '../../preview/use-preview-panel-persistence';

// Mock the file-explorer-hooks module
const mockStorageAdapter = {
  getItem: vi.fn(),
  removeItem: vi.fn(),
  setItem: vi.fn(),
};

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    fileSystemAdapter: {},
    storageAdapter: mockStorageAdapter,
  }),
}));

// Mock createDebounce to execute immediately for testing
vi.mock('@brainstrike/utils/create-debounce', () => ({
  createDebounce: (fn: (...args: unknown[]) => void, _ms: number) => ({
    flush: vi.fn().mockResolvedValue(undefined),
    run: fn,
  }),
}));

// Mock env-utils
vi.mock('@brainstrike/utils/env-utils', () => ({
  isDevEnv: () => false,
}));

// Mock logger
vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Create a wrapper to provide necessary context
const createWrapper = () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return Wrapper;
};

const defaultColumnVisibility: ColumnVisibility = {
  checkbox: true,
  path: true,
  rootFolderId: true,
  size: true,
  tokens: true,
  type: true,
};

const makeColumnVisibility = (overrides: Partial<ColumnVisibility> = {}): ColumnVisibility => ({
  ...defaultColumnVisibility,
  ...overrides,
});

// ── Pure function tests ────────────────────────────────────────────────

describe('preferencesEqual', () => {
  const makePrefs = (
    overrides: Partial<PreviewPanelPreferences> = {}
  ): PreviewPanelPreferences => ({
    collapsedGroups: [],
    columnVisibility: makeColumnVisibility(),
    groupingConfig: 'none',
    pageSize: 25,
    sortDirection: 'asc',
    sortField: 'path',
    ...overrides,
  });

  it('returns true for two identical preferences', () => {
    const a = makePrefs();
    const b = makePrefs();
    expect(preferencesEqual(a, b)).toBe(true);
  });

  it('returns true when both are null', () => {
    expect(preferencesEqual(null, null)).toBe(true);
  });

  it('returns false when only first is null', () => {
    expect(preferencesEqual(null, makePrefs())).toBe(false);
  });

  it('returns false when only second is null', () => {
    expect(preferencesEqual(makePrefs(), null)).toBe(false);
  });

  it('returns false when sortField differs', () => {
    const a = makePrefs({ sortField: 'path' });
    const b = makePrefs({ sortField: 'tokens' });
    expect(preferencesEqual(a, b)).toBe(false);
  });

  it('returns false when sortDirection differs', () => {
    const a = makePrefs({ sortDirection: 'asc' });
    const b = makePrefs({ sortDirection: 'desc' });
    expect(preferencesEqual(a, b)).toBe(false);
  });

  it('returns false when groupingConfig differs', () => {
    const a = makePrefs({ groupingConfig: 'none' });
    const b = makePrefs({ groupingConfig: 'folder' });
    expect(preferencesEqual(a, b)).toBe(false);
  });

  it('returns false when pageSize differs', () => {
    const a = makePrefs({ pageSize: 25 });
    const b = makePrefs({ pageSize: 50 });
    expect(preferencesEqual(a, b)).toBe(false);
  });

  it('returns false when collapsedGroups differ in length', () => {
    const a = makePrefs({ collapsedGroups: ['a'] });
    const b = makePrefs({ collapsedGroups: ['a', 'b'] });
    expect(preferencesEqual(a, b)).toBe(false);
  });

  it('returns false when collapsedGroups have different elements', () => {
    const a = makePrefs({ collapsedGroups: ['a', 'b'] });
    const b = makePrefs({ collapsedGroups: ['a', 'c'] });
    expect(preferencesEqual(a, b)).toBe(false);
  });

  it('returns true when collapsedGroups are identical', () => {
    const a = makePrefs({ collapsedGroups: ['x', 'y', 'z'] });
    const b = makePrefs({ collapsedGroups: ['x', 'y', 'z'] });
    expect(preferencesEqual(a, b)).toBe(true);
  });

  it.each([
    'checkbox',
    'rootFolderId',
    'path',
    'type',
    'tokens',
    'size',
  ] as const)('returns false when columnVisibility %s differs', (key) => {
    const a = makePrefs({ columnVisibility: makeColumnVisibility() });
    const b = makePrefs({ columnVisibility: makeColumnVisibility({ [key]: false }) });
    expect(preferencesEqual(a, b)).toBe(false);
  });
});

// ── Hook tests ─────────────────────────────────────────────────────────

describe('usePreviewPanelPersistence', () => {
  const defaultOptions = {
    defaultColumnVisibility,
    defaultGroupingConfig: 'none',
    defaultPageSize: 25,
    defaultSortDirection: 'asc' as const,
    defaultSortField: 'path' as keyof Record<string, unknown>,
  };

  beforeEach(() => {
    mockStorageAdapter.getItem.mockReset();
    mockStorageAdapter.setItem.mockReset();
    mockStorageAdapter.removeItem.mockReset();
  });

  it('should initialize with default preferences', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.preferences.columnVisibility).toEqual(
      defaultOptions.defaultColumnVisibility
    );
    expect(result.current.preferences.sortField).toBe(defaultOptions.defaultSortField);
    expect(result.current.preferences.sortDirection).toBe(defaultOptions.defaultSortDirection);
    expect(result.current.preferences.groupingConfig).toBe(defaultOptions.defaultGroupingConfig);
    expect(result.current.preferences.pageSize).toBe(defaultOptions.defaultPageSize);
    expect(result.current.preferences.collapsedGroups).toEqual([]);
  });

  it('should load stored preferences on mount', async () => {
    const storedPreferences: PreviewPanelPreferences = {
      collapsedGroups: ['group1', 'group2'],
      columnVisibility: {
        checkbox: false,
        path: true,
        rootFolderId: false,
        size: true,
        tokens: false,
        type: true,
      },
      groupingConfig: 'folder',
      pageSize: 50,
      sortDirection: 'desc',
      sortField: 'tokens',
    };

    mockStorageAdapter.getItem.mockResolvedValue(JSON.stringify(storedPreferences));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.preferences.columnVisibility.checkbox).toBe(false);
    expect(result.current.preferences.sortField).toBe('tokens');
    expect(result.current.preferences.sortDirection).toBe('desc');
    expect(result.current.preferences.groupingConfig).toBe('folder');
    expect(result.current.preferences.collapsedGroups).toEqual(['group1', 'group2']);
    expect(result.current.preferences.pageSize).toBe(50);
  });

  it('should handle corrupted stored data gracefully', async () => {
    mockStorageAdapter.getItem.mockResolvedValue('invalid json');

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.preferences.columnVisibility).toEqual(
      defaultOptions.defaultColumnVisibility
    );
  });

  it('should update preferences', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.updatePreferences({ sortDirection: 'desc' });
    });

    expect(result.current.preferences.sortDirection).toBe('desc');
  });

  it('should reset preferences to defaults', async () => {
    const storedPreferences: PreviewPanelPreferences = {
      collapsedGroups: ['group1'],
      columnVisibility: {
        checkbox: false,
        path: true,
        rootFolderId: false,
        size: true,
        tokens: false,
        type: true,
      },
      groupingConfig: 'folder',
      pageSize: 50,
      sortDirection: 'desc',
      sortField: 'tokens',
    };

    mockStorageAdapter.getItem.mockResolvedValue(JSON.stringify(storedPreferences));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.resetPreferences();
    });

    expect(result.current.preferences.columnVisibility).toEqual(
      defaultOptions.defaultColumnVisibility
    );
    expect(result.current.preferences.sortField).toBe(defaultOptions.defaultSortField);
    expect(result.current.preferences.sortDirection).toBe(defaultOptions.defaultSortDirection);
    expect(result.current.preferences.groupingConfig).toBe(defaultOptions.defaultGroupingConfig);
    expect(result.current.preferences.collapsedGroups).toEqual([]);
    expect(result.current.preferences.pageSize).toBe(defaultOptions.defaultPageSize);
  });

  it('should merge stored preferences with defaults for schema changes', async () => {
    const partialStoredPreferences = {
      columnVisibility: {
        checkbox: false,
      },
      sortField: 'tokens',
    };

    mockStorageAdapter.getItem.mockResolvedValue(JSON.stringify(partialStoredPreferences));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.preferences.columnVisibility.checkbox).toBe(false);
    expect(result.current.preferences.columnVisibility.path).toBe(true);
    expect(result.current.preferences.sortField).toBe('tokens');
    expect(result.current.preferences.sortDirection).toBe('asc');
  });

  it('should handle storage errors gracefully', async () => {
    mockStorageAdapter.getItem.mockRejectedValue(new Error('Storage error'));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.preferences.columnVisibility).toEqual(
      defaultOptions.defaultColumnVisibility
    );
  });

  it('should handle non-array collapsedGroups in stored data', async () => {
    const storedWithInvalidCollapsedGroups = {
      collapsedGroups: 'not-an-array',
      columnVisibility: defaultOptions.defaultColumnVisibility,
      groupingConfig: 'none',
      pageSize: 25,
      sortDirection: 'asc',
      sortField: 'path',
    };

    mockStorageAdapter.getItem.mockResolvedValue(JSON.stringify(storedWithInvalidCollapsedGroups));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.preferences.collapsedGroups).toEqual([]);
  });

  it('should update multiple preference fields at once', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.updatePreferences({
        groupingConfig: 'type',
        pageSize: 100,
        sortDirection: 'desc',
      });
    });

    expect(result.current.preferences.sortDirection).toBe('desc');
    expect(result.current.preferences.groupingConfig).toBe('type');
    expect(result.current.preferences.pageSize).toBe(100);
  });

  // ── Additional coverage tests ─────────────────────────────────────

  it('should persist preferences after update', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);
    mockStorageAdapter.setItem.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.updatePreferences({ sortDirection: 'desc' });
    });

    // Because createDebounce mock executes immediately, setItem should be called
    await waitFor(() => {
      expect(mockStorageAdapter.setItem).toHaveBeenCalled();
    });
  });

  it('should handle setItem errors gracefully during persist', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);
    mockStorageAdapter.setItem.mockRejectedValue(new Error('Write error'));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should not throw when persist fails
    act(() => {
      result.current.updatePreferences({ pageSize: 100 });
    });

    // Allow async operations to complete
    await waitFor(() => {
      expect(mockStorageAdapter.setItem).toHaveBeenCalled();
    });
  });

  it('should start in loading state', () => {
    mockStorageAdapter.getItem.mockReturnValue(new Promise(() => {})); // never resolves

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
  });

  it('should update columnVisibility correctly', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    const newVisibility: ColumnVisibility = {
      checkbox: false,
      path: true,
      rootFolderId: false,
      size: false,
      tokens: true,
      type: false,
    };

    act(() => {
      result.current.updatePreferences({ columnVisibility: newVisibility });
    });

    expect(result.current.preferences.columnVisibility).toEqual(newVisibility);
  });

  it('should update collapsedGroups correctly', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.updatePreferences({ collapsedGroups: ['group-a', 'group-b'] });
    });

    expect(result.current.preferences.collapsedGroups).toEqual(['group-a', 'group-b']);
  });

  it('should persist reset preferences', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);
    mockStorageAdapter.setItem.mockResolvedValue(undefined);

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Modify first
    act(() => {
      result.current.updatePreferences({ pageSize: 100 });
    });

    mockStorageAdapter.setItem.mockClear();

    // Then reset
    act(() => {
      result.current.resetPreferences();
    });

    await waitFor(() => {
      expect(mockStorageAdapter.setItem).toHaveBeenCalled();
    });
  });

  it('should not persist while still loading', async () => {
    let resolveGetItem: ((value: string | null) => void) | undefined;
    mockStorageAdapter.getItem.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveGetItem = resolve;
      })
    );

    renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    // While loading, setItem should not be called
    expect(mockStorageAdapter.setItem).not.toHaveBeenCalled();

    // Now resolve
    expect(resolveGetItem).toBeDefined();
    await act(async () => {
      resolveGetItem?.(null);
    });
  });

  it('should use stored sortField falling back to default when empty', async () => {
    const storedWithEmptySort = {
      collapsedGroups: [],
      columnVisibility: defaultOptions.defaultColumnVisibility,
      groupingConfig: '',
      pageSize: 0,
      sortDirection: '',
      sortField: '',
    };

    mockStorageAdapter.getItem.mockResolvedValue(JSON.stringify(storedWithEmptySort));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Falsy values should fall back to defaults via the || operator
    expect(result.current.preferences.sortField).toBe(defaultOptions.defaultSortField);
    expect(result.current.preferences.sortDirection).toBe(defaultOptions.defaultSortDirection);
    expect(result.current.preferences.groupingConfig).toBe(defaultOptions.defaultGroupingConfig);
    expect(result.current.preferences.pageSize).toBe(defaultOptions.defaultPageSize);
  });

  it('should clean up on unmount without errors', async () => {
    mockStorageAdapter.getItem.mockResolvedValue(null);

    const { result, unmount } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should not throw on unmount
    expect(() => unmount()).not.toThrow();
  });
});
