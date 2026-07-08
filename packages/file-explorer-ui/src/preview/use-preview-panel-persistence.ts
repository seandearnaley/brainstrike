import { useAdapters } from '@brainstrike/file-explorer-hooks';
// Note: TableRowData type is imported where this hook is used
import { createDebounce } from '@brainstrike/utils/create-debounce';
import { isDevEnv } from '@brainstrike/utils/env-utils';
import { createLogger } from '@brainstrike/utils/logger';
import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'previewPanelPreferences.v1';
const SAVE_DEBOUNCE_MS = 250;
const logger = createLogger('PreviewPanelPersistence');

// Define specific column visibility keys
export interface ColumnVisibility {
  checkbox: boolean;
  path: boolean;
  rootFolderId: boolean;
  size: boolean;
  tokens: boolean;
  type: boolean;
}

export interface PreviewPanelPreferences<T = Record<string, unknown>> {
  collapsedGroups: string[]; // Array of group keys
  columnVisibility: ColumnVisibility;
  groupingConfig: string;
  pageSize: number;
  sortDirection: 'asc' | 'desc';
  sortField: keyof T;
}

function columnsMatch(a: ColumnVisibility, b: ColumnVisibility): boolean {
  return (
    a.checkbox === b.checkbox &&
    a.rootFolderId === b.rootFolderId &&
    a.path === b.path &&
    a.type === b.type &&
    a.tokens === b.tokens &&
    a.size === b.size
  );
}

function arraysMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export interface UsePreviewPanelPersistenceOptions<T = Record<string, unknown>> {
  defaultColumnVisibility: ColumnVisibility;
  defaultGroupingConfig: string;
  defaultPageSize: number;
  defaultSortDirection: 'asc' | 'desc';
  defaultSortField: keyof T;
}

export function preferencesEqual<T>(
  a: PreviewPanelPreferences<T> | null,
  b: PreviewPanelPreferences<T> | null
): boolean {
  if (a === null || b === null) {
    return a === b;
  }

  if (!columnsMatch(a.columnVisibility, b.columnVisibility)) {
    return false;
  }

  if (
    a.sortField !== b.sortField ||
    a.sortDirection !== b.sortDirection ||
    a.groupingConfig !== b.groupingConfig ||
    a.pageSize !== b.pageSize
  ) {
    return false;
  }

  return arraysMatch(a.collapsedGroups, b.collapsedGroups);
}

export function usePreviewPanelPersistence<T = Record<string, unknown>>(
  options: UsePreviewPanelPersistenceOptions<T>
) {
  const { storageAdapter } = useAdapters();
  const [isLoading, setIsLoading] = useState(true);
  const [preferences, setPreferences] = useState<PreviewPanelPreferences<T>>(() => ({
    collapsedGroups: [],
    columnVisibility: options.defaultColumnVisibility,
    groupingConfig: options.defaultGroupingConfig,
    pageSize: options.defaultPageSize,
    sortDirection: options.defaultSortDirection,
    sortField: options.defaultSortField,
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
          collapsedGroups: Array.isArray(parsed.collapsedGroups) ? parsed.collapsedGroups : [],
          columnVisibility: { ...options.defaultColumnVisibility, ...parsed.columnVisibility },
          groupingConfig: parsed.groupingConfig || options.defaultGroupingConfig,
          pageSize: parsed.pageSize || options.defaultPageSize,
          sortDirection: parsed.sortDirection || options.defaultSortDirection,
          sortField: parsed.sortField || options.defaultSortField,
        };
        return validated;
      }
    } catch (error) {
      if (isDevEnv()) {
        logger.warn('Failed to load preview panel preferences', { error });
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
      } catch (error) {
        if (isDevEnv()) {
          logger.warn('Failed to persist preview panel preferences', { error });
        }
      }
    },
    [storageAdapter]
  );

  const { run: debouncedSave, flush } = createDebounce(savePreferences, SAVE_DEBOUNCE_MS);

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
    [debouncedSave]
  );

  // Update preferences
  const updatePreferences = useCallback((updates: Partial<PreviewPanelPreferences<T>>) => {
    setPreferences((currentPrefs) => ({ ...currentPrefs, ...updates }));
  }, []);

  // biome-ignore lint/plugin: Persist preferences when they change - intentional debounced persistence
  useEffect(() => {
    if (!isLoading) {
      persist(preferences);
    }
  }, [preferences, persist, isLoading]);

  // Reset to defaults
  const resetPreferences = useCallback(() => {
    const defaultPreferences: PreviewPanelPreferences<T> = {
      collapsedGroups: [],
      columnVisibility: options.defaultColumnVisibility,
      groupingConfig: options.defaultGroupingConfig,
      pageSize: options.defaultPageSize,
      sortDirection: options.defaultSortDirection,
      sortField: options.defaultSortField,
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
      void flush();
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
    isLoading,
    preferences,
    resetPreferences,
    updatePreferences,
  };
}
