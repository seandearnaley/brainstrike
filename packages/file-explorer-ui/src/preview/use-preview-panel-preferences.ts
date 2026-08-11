import { createLogger } from '@brainstrike/logging';
import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_TAPESTRY_SCALE, MAX_TAPESTRY_SCALE, MIN_TAPESTRY_SCALE } from '../tapestry/utils';
import { GROUPING_CONFIGS } from '../utils/grouping-configs';
import {
  inferPreviewFooterMode,
  PREVIEW_FOOTER_MODES,
  type PreviewFooterMode,
} from './preview-footer-layout';

/**
 * Persisted preferences for the context preview surface.
 *
 * BST-1211 retired the Table View, and with it four stored keys: `activeTab`
 * (there is only one surface now), `sortField` / `sortDirection` (the table
 * headers were the only way to change them), `columnVisibility` (columns are
 * an Explorer-grid concept) and `pageSize` (only the table's pagination bar
 * offered a size selector). The storage key is deliberately unchanged: unknown
 * keys are ignored on read and dropped on the next write, so a profile written
 * by the old panel upgrades in place without a version bump — and without
 * losing the grouping, collapse, footer and scale preferences it shares.
 */
const STORAGE_KEY = 'previewPanelPreferences.v1';
const SAVE_DEBOUNCE_MS = 250;
const logger = createLogger('PreviewPanelPreferences');
const VALID_GROUPING_CONFIGS = new Set(Object.keys(GROUPING_CONFIGS));
const VALID_FOOTER_MODES = new Set<PreviewFooterMode>(PREVIEW_FOOTER_MODES);

interface StoredPreferences {
  collapsedGroups?: string[];
  footerCollapsed?: boolean;
  footerHeight?: number;
  footerMode?: PreviewFooterMode;
  groupingConfig?: string;
  tapestryScale?: number;
}

interface PreviewPanelPreferences {
  collapsedGroups: Set<string>;
  footerMode: PreviewFooterMode;
  groupingConfig: string;
  tapestryScale: number;
}

interface PreviewPanelPreferencesDefaults {
  footerMode: PreviewFooterMode;
  groupingConfig: string;
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

function sanitizeCollapsedGroups(
  value: StoredPreferences['collapsedGroups']
): StoredPreferences['collapsedGroups'] {
  if (!Array.isArray(value)) {
    return;
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
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
  const groupingConfig = sanitizeGroupingConfig(stored.groupingConfig);
  if (groupingConfig !== undefined) {
    sanitized.groupingConfig = groupingConfig;
  }
  const collapsedGroups = sanitizeCollapsedGroups(stored.collapsedGroups);
  if (collapsedGroups) {
    sanitized.collapsedGroups = collapsedGroups;
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
  setCollapsedGroups: Dispatch<SetStateAction<Set<string>>>;
  setFooterMode: Dispatch<SetStateAction<PreviewFooterMode>>;
  setGroupingConfig: Dispatch<SetStateAction<string>>;
  setTapestryScale: Dispatch<SetStateAction<number>>;
}

export function usePreviewPanelPreferences(
  defaults: PreviewPanelPreferencesDefaults
): PreviewPanelPreferences & PreviewPanelPreferencesSetters {
  const storedPreferences = useMemo(() => loadStoredPreferences(), []);

  const [groupingConfig, setGroupingConfig] = useState<string>(() =>
    migrateGroupingConfig(
      getStoredValue(storedPreferences, 'groupingConfig', defaults.groupingConfig)
    )
  );

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    const storedGroups = getStoredValue(storedPreferences, 'collapsedGroups', []);
    return new Set(storedGroups);
  });

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
          collapsedGroups: Array.from(collapsedGroups),
          footerMode,
          groupingConfig,
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
  }, [groupingConfig, collapsedGroups, footerMode, tapestryScale]);

  return {
    collapsedGroups,
    footerMode,
    groupingConfig,
    setCollapsedGroups,
    setFooterMode,
    setGroupingConfig,
    setTapestryScale,
    tapestryScale,
  };
}
