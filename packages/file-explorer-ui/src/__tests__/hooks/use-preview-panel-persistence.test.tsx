import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  type ColumnVisibility,
  type PreviewPanelPreferences,
  usePreviewPanelPersistence,
} from '../../hooks/use-preview-panel-persistence';

// Mock the file-explorer-hooks module
const mockStorageAdapter = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: mockStorageAdapter,
    fileSystemAdapter: {},
  }),
}));

// Mock createDebounce
vi.mock('@brainstrike/hooks', () => ({
  createDebounce: (fn: (...args: unknown[]) => void, _ms: number) => ({
    run: fn,
    flush: vi.fn().mockResolvedValue(undefined),
  }),
  useEventCallback: <TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult
  ): ((...args: TArgs) => TResult) => callback,
}));

// Create a wrapper to provide necessary context
const createWrapper = () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return Wrapper;
};

describe('usePreviewPanelPersistence', () => {
  const defaultOptions = {
    defaultColumnVisibility: {
      checkbox: true,
      rootFolderId: true,
      path: true,
      type: true,
      tokens: true,
      size: true,
    } as ColumnVisibility,
    defaultSortField: 'path' as keyof Record<string, unknown>,
    defaultSortDirection: 'asc' as const,
    defaultGroupingConfig: 'none',
    defaultPageSize: 25,
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
      columnVisibility: {
        checkbox: false,
        rootFolderId: false,
        path: true,
        type: true,
        tokens: false,
        size: true,
      },
      sortField: 'tokens',
      sortDirection: 'desc',
      groupingConfig: 'folder',
      collapsedGroups: ['group1', 'group2'],
      pageSize: 50,
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

    // Should fall back to defaults
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
      columnVisibility: {
        checkbox: false,
        rootFolderId: false,
        path: true,
        type: true,
        tokens: false,
        size: true,
      },
      sortField: 'tokens',
      sortDirection: 'desc',
      groupingConfig: 'folder',
      collapsedGroups: ['group1'],
      pageSize: 50,
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
    // Simulate stored preferences missing some new fields
    const partialStoredPreferences = {
      columnVisibility: {
        checkbox: false,
        // Missing other fields
      },
      sortField: 'tokens',
      // Missing sortDirection, groupingConfig, etc.
    };

    mockStorageAdapter.getItem.mockResolvedValue(JSON.stringify(partialStoredPreferences));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should merge with defaults
    expect(result.current.preferences.columnVisibility.checkbox).toBe(false);
    expect(result.current.preferences.columnVisibility.path).toBe(true); // From defaults
    expect(result.current.preferences.sortField).toBe('tokens');
    expect(result.current.preferences.sortDirection).toBe('asc'); // From defaults
  });

  it('should handle storage errors gracefully', async () => {
    mockStorageAdapter.getItem.mockRejectedValue(new Error('Storage error'));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should fall back to defaults
    expect(result.current.preferences.columnVisibility).toEqual(
      defaultOptions.defaultColumnVisibility
    );
  });

  it('should handle non-array collapsedGroups in stored data', async () => {
    const storedWithInvalidCollapsedGroups = {
      columnVisibility: defaultOptions.defaultColumnVisibility,
      sortField: 'path',
      sortDirection: 'asc',
      groupingConfig: 'none',
      collapsedGroups: 'not-an-array', // Invalid
      pageSize: 25,
    };

    mockStorageAdapter.getItem.mockResolvedValue(JSON.stringify(storedWithInvalidCollapsedGroups));

    const { result } = renderHook(() => usePreviewPanelPersistence(defaultOptions), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Should default to empty array
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
        sortDirection: 'desc',
        groupingConfig: 'type',
        pageSize: 100,
      });
    });

    expect(result.current.preferences.sortDirection).toBe('desc');
    expect(result.current.preferences.groupingConfig).toBe('type');
    expect(result.current.preferences.pageSize).toBe(100);
  });
});
