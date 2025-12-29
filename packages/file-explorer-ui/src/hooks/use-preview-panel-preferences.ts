import { createLogger } from '@brainstrike/utils';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { resolveColumnVisibility } from '../preview-column-visibility';
import type { TableRowData } from '../utils/grouping-configs';
import type { ColumnVisibility } from './use-preview-panel-persistence';

const STORAGE_KEY = 'previewPanelPreferences.v1';
const SAVE_DEBOUNCE_MS = 250;
const logger = createLogger('PreviewPanelPreferences');

type StoredPreferences = {
  columnVisibility?: Partial<ColumnVisibility>;
  sortField?: keyof TableRowData;
  sortDirection?: 'asc' | 'desc';
  groupingConfig?: string;
  activeTab?: string;
  collapsedGroups?: string[];
};

type PreviewPanelPreferences = {
  columnVisibility: ColumnVisibility;
  sortField: keyof TableRowData;
  sortDirection: 'asc' | 'desc';
  groupingConfig: string;
  activeTab: string;
  collapsedGroups: Set<string>;
};

type PreviewPanelPreferencesDefaults = {
  sortField: keyof TableRowData;
  sortDirection: 'asc' | 'desc';
  groupingConfig: string;
  activeTab: string;
};

function loadStoredPreferences(): StoredPreferences | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? (JSON.parse(stored) as StoredPreferences) : null;
  } catch (error) {
    logger.warn('Failed to parse stored preferences', { storageKey: STORAGE_KEY, error });
    return null;
  }
}

function getStoredValue<K extends keyof StoredPreferences>(
  stored: StoredPreferences | null,
  key: K,
  value: NonNullable<StoredPreferences[K]>
): NonNullable<StoredPreferences[K]> {
  const storedValue = stored?.[key];
  if (storedValue !== undefined && storedValue !== null) {
    return storedValue as NonNullable<StoredPreferences[K]>;
  }
  return value;
}

function migrateGroupingConfig(value: string): string {
  if (value === 'folder') {
    return 'rootFolder';
  }
  return value;
}

function isQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false;
  }
  return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

type PreviewPanelPreferencesSetters = {
  setColumnVisibility: Dispatch<SetStateAction<ColumnVisibility>>;
  setSortField: Dispatch<SetStateAction<keyof TableRowData>>;
  setSortDirection: Dispatch<SetStateAction<'asc' | 'desc'>>;
  setGroupingConfig: Dispatch<SetStateAction<string>>;
  setActiveTab: Dispatch<SetStateAction<string>>;
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>;
};

export function usePreviewPanelPreferences(
  defaults: PreviewPanelPreferencesDefaults
): PreviewPanelPreferences & PreviewPanelPreferencesSetters {
  const storedPreferences = useMemo(() => loadStoredPreferences(), []);

  const [columnVisibility, setColumnVisibility] = useState<ColumnVisibility>(() =>
    resolveColumnVisibility(storedPreferences?.columnVisibility)
  );

  const [sortField, setSortField] = useState<keyof TableRowData>(() =>
    getStoredValue(storedPreferences, 'sortField', defaults.sortField)
  );

  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(() =>
    getStoredValue(storedPreferences, 'sortDirection', defaults.sortDirection)
  );

  const [groupingConfig, setGroupingConfig] = useState<string>(() =>
    migrateGroupingConfig(
      getStoredValue(storedPreferences, 'groupingConfig', defaults.groupingConfig)
    )
  );

  const [activeTab, setActiveTab] = useState<string>(() =>
    getStoredValue(storedPreferences, 'activeTab', defaults.activeTab)
  );

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const storedGroups = getStoredValue(storedPreferences, 'collapsedGroups', []);
    return new Set(storedGroups);
  });

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      try {
        const settings = {
          columnVisibility,
          sortField,
          sortDirection,
          groupingConfig,
          activeTab,
          collapsedGroups: Array.from(collapsedGroups),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch (error) {
        if (isQuotaExceeded(error)) {
          logger.warn('LocalStorage quota exceeded while saving preferences', {
            storageKey: STORAGE_KEY,
          });
          return;
        }
        logger.warn('Failed to save preferences to localStorage', {
          storageKey: STORAGE_KEY,
          error,
        });
      }
    }, SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [columnVisibility, sortField, sortDirection, groupingConfig, collapsedGroups, activeTab]);

  return {
    activeTab,
    collapsedGroups,
    columnVisibility,
    groupingConfig,
    setActiveTab,
    setCollapsedGroups,
    setColumnVisibility,
    setGroupingConfig,
    setSortDirection,
    setSortField,
    sortDirection,
    sortField,
  };
}
