import { createLogger } from '@brainstrike/utils/logger';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_TAPESTRY_SCALE, MAX_TAPESTRY_SCALE, MIN_TAPESTRY_SCALE } from '../tapestry/utils';
import type { TableRowData } from '../utils/grouping-configs';
import { GROUPING_CONFIGS } from '../utils/grouping-configs';
import {
  createDefaultColumnVisibility,
  resolveColumnVisibility,
} from './preview-column-visibility';
import {
  inferPreviewFooterMode,
  PREVIEW_FOOTER_MODES,
  type PreviewFooterMode,
} from './preview-footer-layout';
import type { ColumnVisibility } from './use-preview-panel-persistence';

const STORAGE_KEY = 'previewPanelPreferences.v1';
const SAVE_DEBOUNCE_MS = 250;
const logger = createLogger('PreviewPanelPreferences');
const VALID_SORT_FIELDS = new Set<keyof TableRowData>([
  'id',
  'rootFolderId',
  'path',
  'type',
  'size',
  'tokens',
  'compositeKey',
]);
const VALID_TABS = new Set(['table', 'tapestry']);
const VALID_GROUPING_CONFIGS = new Set(Object.keys(GROUPING_CONFIGS));
const COLUMN_VISIBILITY_KEYS = Object.keys(
  createDefaultColumnVisibility()
) as (keyof ColumnVisibility)[];
const VALID_FOOTER_MODES = new Set<PreviewFooterMode>(PREVIEW_FOOTER_MODES);

/** Default page size for preview panel pagination */
export const DEFAULT_PAGE_SIZE = 50;
const VALID_PAGE_SIZES = new Set([10, 25, 50, 100, 250, 500, 1000]);

interface StoredPreferences {
  activeTab?: string;
  collapsedGroups?: string[];
  columnVisibility?: Partial<ColumnVisibility>;
  footerCollapsed?: boolean;
  footerHeight?: number;
  footerMode?: PreviewFooterMode;
  groupingConfig?: string;
  pageSize?: number;
  sortDirection?: 'asc' | 'desc';
  sortField?: keyof TableRowData;
  tapestryScale?: number;
}

interface PreviewPanelPreferences {
  activeTab: string;
  collapsedGroups: Set<string>;
  columnVisibility: ColumnVisibility;
  footerMode: PreviewFooterMode;
  groupingConfig: string;
  pageSize: number;
  sortDirection: 'asc' | 'desc';
  sortField: keyof TableRowData;
  tapestryScale: number;
}

interface PreviewPanelPreferencesDefaults {
  activeTab: string;
  footerMode: PreviewFooterMode;
  groupingConfig: string;
  sortDirection: 'asc' | 'desc';
  sortField: keyof TableRowData;
}

function loadStoredPreferences(): StoredPreferences | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? sanitizeStoredPreferences(JSON.parse(stored) as StoredPreferences) : null;
  } catch (error) {
    logger.warn('Failed to parse stored preferences', { error, storageKey: STORAGE_KEY });
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

function sanitizeColumnVisibility(
  value: StoredPreferences['columnVisibility']
): StoredPreferences['columnVisibility'] {
  if (!value || typeof value !== 'object') {
    return;
  }
  const next: Partial<ColumnVisibility> = {};
  for (const key of COLUMN_VISIBILITY_KEYS) {
    const entry = value[key];
    if (typeof entry === 'boolean') {
      next[key] = entry;
    }
  }
  return next;
}

function sanitizeSortField(value: StoredPreferences['sortField']): StoredPreferences['sortField'] {
  if (value && VALID_SORT_FIELDS.has(value)) {
    return value;
  }
  return;
}

function sanitizeSortDirection(
  value: StoredPreferences['sortDirection']
): StoredPreferences['sortDirection'] {
  if (value === 'asc' || value === 'desc') {
    return value;
  }
  return;
}

function sanitizeGroupingConfig(
  value: StoredPreferences['groupingConfig']
): StoredPreferences['groupingConfig'] {
  if (typeof value !== 'string') {
    return;
  }
  const normalized = migrateGroupingConfig(value);
  if (VALID_GROUPING_CONFIGS.has(normalized)) {
    return normalized;
  }
  return;
}

function sanitizeActiveTab(value: StoredPreferences['activeTab']): StoredPreferences['activeTab'] {
  if (typeof value === 'string' && VALID_TABS.has(value)) {
    return value;
  }
  return;
}

function sanitizeCollapsedGroups(
  value: StoredPreferences['collapsedGroups']
): StoredPreferences['collapsedGroups'] {
  if (!Array.isArray(value)) {
    return;
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function sanitizePageSize(value: StoredPreferences['pageSize']): StoredPreferences['pageSize'] {
  if (typeof value === 'number' && VALID_PAGE_SIZES.has(value)) {
    return value;
  }
  return;
}

function sanitizeTapestryScale(
  value: StoredPreferences['tapestryScale']
): StoredPreferences['tapestryScale'] {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_TAPESTRY_SCALE &&
    value <= MAX_TAPESTRY_SCALE
  ) {
    return value;
  }
  return;
}

function sanitizeFooterMode(
  value: StoredPreferences['footerMode']
): StoredPreferences['footerMode'] {
  if (value && VALID_FOOTER_MODES.has(value)) {
    return value;
  }
  return;
}

function sanitizeFooterHeight(
  value: StoredPreferences['footerHeight']
): StoredPreferences['footerHeight'] {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return;
}

function sanitizeStoredPreferences(stored: StoredPreferences | null): StoredPreferences | null {
  if (!stored || typeof stored !== 'object') {
    return null;
  }

  const sanitized: StoredPreferences = {};
  const columnVisibility = sanitizeColumnVisibility(stored.columnVisibility);
  if (columnVisibility) {
    sanitized.columnVisibility = columnVisibility;
  }
  const sortField = sanitizeSortField(stored.sortField);
  if (sortField !== undefined) {
    sanitized.sortField = sortField;
  }
  const sortDirection = sanitizeSortDirection(stored.sortDirection);
  if (sortDirection !== undefined) {
    sanitized.sortDirection = sortDirection;
  }
  const groupingConfig = sanitizeGroupingConfig(stored.groupingConfig);
  if (groupingConfig !== undefined) {
    sanitized.groupingConfig = groupingConfig;
  }
  const activeTab = sanitizeActiveTab(stored.activeTab);
  if (activeTab !== undefined) {
    sanitized.activeTab = activeTab;
  }
  const collapsedGroups = sanitizeCollapsedGroups(stored.collapsedGroups);
  if (collapsedGroups) {
    sanitized.collapsedGroups = collapsedGroups;
  }
  const pageSize = sanitizePageSize(stored.pageSize);
  if (pageSize !== undefined) {
    sanitized.pageSize = pageSize;
  }
  const tapestryScale = sanitizeTapestryScale(stored.tapestryScale);
  if (tapestryScale !== undefined) {
    sanitized.tapestryScale = tapestryScale;
  }
  const footerMode = sanitizeFooterMode(stored.footerMode);
  const footerHeight = sanitizeFooterHeight(stored.footerHeight);
  if (footerHeight !== undefined) {
    sanitized.footerMode = inferPreviewFooterMode(footerHeight);
  } else if (footerMode !== undefined) {
    sanitized.footerMode = footerMode;
  }

  return sanitized;
}

function isQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false;
  }
  return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

interface PreviewPanelPreferencesSetters {
  setActiveTab: Dispatch<SetStateAction<string>>;
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>;
  setColumnVisibility: Dispatch<SetStateAction<ColumnVisibility>>;
  setFooterMode: Dispatch<SetStateAction<PreviewFooterMode>>;
  setGroupingConfig: Dispatch<SetStateAction<string>>;
  setPageSize: Dispatch<SetStateAction<number>>;
  setSortDirection: Dispatch<SetStateAction<'asc' | 'desc'>>;
  setSortField: Dispatch<SetStateAction<keyof TableRowData>>;
  setTapestryScale: Dispatch<SetStateAction<number>>;
}

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

  const [pageSize, setPageSize] = useState<number>(() =>
    getStoredValue(storedPreferences, 'pageSize', DEFAULT_PAGE_SIZE)
  );
  const [footerMode, setFooterMode] = useState<PreviewFooterMode>(() =>
    getStoredValue(storedPreferences, 'footerMode', defaults.footerMode)
  );
  const [tapestryScale, setTapestryScale] = useState<number>(() =>
    getStoredValue(storedPreferences, 'tapestryScale', DEFAULT_TAPESTRY_SCALE)
  );

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      try {
        const settings = {
          activeTab,
          collapsedGroups: Array.from(collapsedGroups),
          columnVisibility,
          footerMode,
          groupingConfig,
          pageSize,
          sortDirection,
          sortField,
          tapestryScale,
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
          error,
          storageKey: STORAGE_KEY,
        });
      }
    }, SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timeoutId);
  }, [
    columnVisibility,
    sortField,
    sortDirection,
    groupingConfig,
    collapsedGroups,
    activeTab,
    pageSize,
    footerMode,
    tapestryScale,
  ]);

  return {
    activeTab,
    collapsedGroups,
    columnVisibility,
    footerMode,
    groupingConfig,
    pageSize,
    setActiveTab,
    setCollapsedGroups,
    setColumnVisibility,
    setFooterMode,
    setGroupingConfig,
    setPageSize,
    setSortDirection,
    setSortField,
    setTapestryScale,
    sortDirection,
    sortField,
    tapestryScale,
  };
}
