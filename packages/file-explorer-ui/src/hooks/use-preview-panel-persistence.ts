import { useAdapters } from '@brainstrike/file-explorer-hooks';
import { isDevEnv } from '@brainstrike/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
// Note: TableRowData type is imported where this hook is used
import { createDebounce } from './debounce';

const STORAGE_KEY = 'previewPanelPreferences.v1';
const SAVE_DEBOUNCE_MS = 250;

// Define specific column visibility keys
export interface ColumnVisibility {
  checkbox: boolean;
  rootFolderId: boolean;
  path: boolean;
  type: boolean;
  tokens: boolean;
  size: boolean;
}

export interface PreviewPanelPreferences<T = Record<string, unknown>> {
  columnVisibility: ColumnVisibility;
  sortField: keyof T;
  sortDirection: 'asc' | 'desc';
  groupingConfig: string;
  collapsedGroups: string[]; // Array of group keys
  pageSize: number;
}

export interface UsePreviewPanelPersistenceOptions<T = Record<string, unknown>> {
  defaultColumnVisibility: ColumnVisibility;
  defaultSortField: keyof T;
  defaultSortDirection: 'asc' | 'desc';
  defaultGroupingConfig: string;
  defaultPageSize: number;
}

export function usePreviewPanelPersistence<T = Record<string, unknown>>(
  options: UsePreviewPanelPersistenceOptions<T>
) {
  const { storageAdapter } = useAdapters();
  const [isLoading, setIsLoading] = useState(true);
  const [preferences, setPreferences] = useState<PreviewPanelPreferences<T>>(() => ({
    columnVisibility: options.defaultColumnVisibility,
    sortField: options.defaultSortField,
    sortDirection: options.defaultSortDirection,
    groupingConfig: options.defaultGroupingConfig,
    collapsedGroups: [],
    pageSize: options.defaultPageSize,
  }));

  const lastSavedRef = useRef<PreviewPanelPreferences<T> | null>(null);
  const pendingRef = useRef<PreviewPanelPreferences<T> | null>(null);

  // Load preferences on mount
  const loadPreferences = useCallback(async (): Promise<PreviewPanelPreferences<T> | null> => {
    try {
      const stored = await storageAdapter.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as PreviewPanelPreferences<T>;
        // Validate and merge with defaults to handle schema changes
        const validated: PreviewPanelPreferences<T> = {
          columnVisibility: { ...options.defaultColumnVisibility, ...parsed.columnVisibility },
          sortField: parsed.sortField || options.defaultSortField,
          sortDirection: parsed.sortDirection || options.defaultSortDirection,
          groupingConfig: parsed.groupingConfig || options.defaultGroupingConfig,
          collapsedGroups: Array.isArray(parsed.collapsedGroups) ? parsed.collapsedGroups : [],
          pageSize: parsed.pageSize || options.defaultPageSize,
        };
        return validated;
      }
    } catch (_error) {
      if (isDevEnv()) {
      }
    }
    return null;
  }, [storageAdapter, options]);

  // Save preferences with debouncing
  const savePreferences = useCallback(
    async (preferencesToSave: PreviewPanelPreferences<T>) => {
      try {
        await storageAdapter.setItem(STORAGE_KEY, JSON.stringify(preferencesToSave));
        lastSavedRef.current = preferencesToSave;
      } catch (_error) {
        if (isDevEnv()) {
        }
      }
    },
    [storageAdapter]
  );

  const { run: debouncedSave, flush } = createDebounce(savePreferences, SAVE_DEBOUNCE_MS);

  // Helper to check if preferences are equal
  const preferencesEqual = useCallback(
    (a: PreviewPanelPreferences<T> | null, b: PreviewPanelPreferences<T> | null): boolean => {
      if (a === null || b === null) return a === b;
      return (
        JSON.stringify(a.columnVisibility) === JSON.stringify(b.columnVisibility) &&
        a.sortField === b.sortField &&
        a.sortDirection === b.sortDirection &&
        a.groupingConfig === b.groupingConfig &&
        JSON.stringify(a.collapsedGroups) === JSON.stringify(b.collapsedGroups) &&
        a.pageSize === b.pageSize
      );
    },
    []
  );

  // Persist preferences with optimization to avoid unnecessary saves
  const persist = useCallback(
    (newPreferences: PreviewPanelPreferences<T>) => {
      if (pendingRef.current && preferencesEqual(pendingRef.current, newPreferences)) {
        return;
      }
      if (!pendingRef.current && preferencesEqual(lastSavedRef.current, newPreferences)) {
        return;
      }

      pendingRef.current = newPreferences;
      debouncedSave(newPreferences);
    },
    [debouncedSave, preferencesEqual]
  );

  // Update preferences
  const updatePreferences = useCallback((updates: Partial<PreviewPanelPreferences<T>>) => {
    setPreferences((currentPrefs) => ({ ...currentPrefs, ...updates }));
  }, []);

  // Persist preferences when they change
  useEffect(() => {
    if (!isLoading) {
      persist(preferences);
    }
  }, [preferences, persist, isLoading]);

  // Reset to defaults
  const resetPreferences = useCallback(() => {
    const defaultPreferences: PreviewPanelPreferences<T> = {
      columnVisibility: options.defaultColumnVisibility,
      sortField: options.defaultSortField,
      sortDirection: options.defaultSortDirection,
      groupingConfig: options.defaultGroupingConfig,
      collapsedGroups: [],
      pageSize: options.defaultPageSize,
    };
    setPreferences(defaultPreferences);
    persist(defaultPreferences);
  }, [options, persist]);

  // Load preferences on mount
  useEffect(() => {
    let mounted = true;

    const loadAndSetPreferences = async () => {
      const loaded = await loadPreferences();
      if (mounted && loaded) {
        setPreferences(loaded);
        lastSavedRef.current = loaded;
      }
      if (mounted) {
        setIsLoading(false);
      }
    };

    void loadAndSetPreferences();

    return () => {
      mounted = false;
    };
  }, [loadPreferences]);

  // Flush pending saves on unmount
  useEffect(() => {
    const flushPending = () => {
      flush();
      pendingRef.current = null;
    };

    const beforeUnload = () => flushPending();
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', beforeUnload);
    }

    return () => {
      beforeUnload();
      if (typeof window !== 'undefined') {
        window.removeEventListener('beforeunload', beforeUnload);
      }
    };
  }, [flush]);

  return {
    preferences,
    updatePreferences,
    resetPreferences,
    isLoading,
  };
}
