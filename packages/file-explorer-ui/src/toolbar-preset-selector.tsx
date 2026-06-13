/**
 * Toolbar Preset Selector
 *
 * A compact view filter preset selector for the file explorer toolbar.
 * Provides quick access to preset selection without opening settings dialog.
 *
 * This component is React Compiler safe - all hooks are called unconditionally
 * at the top level with stable dependencies.
 */

import { FILE_EXPLORER_STORAGE_KEY } from '@brainstrike/file-explorer';
import type { ViewFilterPreset } from '@brainstrike/types';
import { isDevEnv } from '@brainstrike/utils/env-utils';
import { createLogger } from '@brainstrike/utils/logger';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useViewFilterPresets } from './hooks/use-view-filter-presets';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './shell/file-explorer-provider';
import { ViewFilterPresetDropdown } from './view-filter-preset-dropdown';

const logger = createLogger('ToolbarPresetSelector');

interface ZustandPersistStorage {
  getItem: (key: string) => Promise<unknown> | unknown;
  setItem: (key: string, value: unknown) => Promise<void> | void;
}

interface ZustandPersistOptions {
  name?: string;
  partialize?: (state: unknown) => unknown;
  storage?: ZustandPersistStorage;
  version?: number;
}

interface ZustandPersistApi {
  getOptions?: () => ZustandPersistOptions;
}

function readPersistedStorageValue(currentValue: unknown): unknown {
  if (typeof currentValue !== 'string' || currentValue.length === 0) {
    return currentValue;
  }

  try {
    return JSON.parse(currentValue);
  } catch {
    return {};
  }
}

function unwrapPersistedState(current: unknown): {
  currentObject: Record<string, unknown>;
  hasWrapper: boolean;
  persistedState: Record<string, unknown>;
} {
  const currentIsObject = current !== null && typeof current === 'object';
  const currentObject = currentIsObject ? (current as Record<string, unknown>) : {};
  const hasWrapper = currentIsObject && 'state' in currentObject;
  const wrappedState = currentObject['state'];
  const persistedState =
    hasWrapper && wrappedState !== null && typeof wrappedState === 'object'
      ? (wrappedState as Record<string, unknown>)
      : currentObject;

  return { currentObject, hasWrapper, persistedState };
}

function resolveLivePersistedState(
  getState: (() => unknown) | null,
  partialize: ((state: unknown) => unknown) | null,
  persistedState: Record<string, unknown>
): Record<string, unknown> {
  if (!(getState && partialize)) {
    return persistedState;
  }

  const liveState = partialize(getState());
  return liveState !== null && typeof liveState === 'object'
    ? (liveState as Record<string, unknown>)
    : {};
}

/** Resolve the Zustand persist API from a store reference, or null if unavailable. */
function resolveStorePersistApi(store: unknown): {
  getState: (() => unknown) | null;
  name: string;
  partialize: ((state: unknown) => unknown) | null;
  storage: ZustandPersistStorage;
  version: number;
} | null {
  const storeRef = store as {
    getState?: () => unknown;
    persist?: ZustandPersistApi;
  };
  const persistApi = storeRef.persist;
  if (!persistApi || typeof persistApi.getOptions !== 'function') {
    return null;
  }
  const opts = persistApi.getOptions();
  const storage = opts?.storage;
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    return null;
  }
  return {
    storage,
    name: opts?.name ?? FILE_EXPLORER_STORAGE_KEY,
    version: opts?.version ?? 1,
    partialize: typeof opts?.partialize === 'function' ? opts.partialize : null,
    getState: typeof storeRef.getState === 'function' ? storeRef.getState : null,
  };
}

/** Merge patch into the Zustand persisted state JSON and write it back. */
async function mergeAndWriteStoragePatch(
  storage: ZustandPersistStorage,
  name: string,
  version: number,
  getState: (() => unknown) | null,
  partialize: ((state: unknown) => unknown) | null,
  patch: Record<string, unknown>
): Promise<void> {
  let currentValue: unknown = null;
  try {
    currentValue = await storage.getItem(name);
  } catch (error) {
    if (isDevEnv()) {
      logger.warn('Failed to read preset storage', { error });
    }
    return;
  }

  const current = readPersistedStorageValue(currentValue);
  const { currentObject, hasWrapper, persistedState } = unwrapPersistedState(current);
  const liveStateObject = resolveLivePersistedState(getState, partialize, persistedState);
  const base = { ...persistedState, ...liveStateObject };
  const merged = { ...base, ...patch };
  const wrapper = hasWrapper ? { ...currentObject, state: merged } : { version, state: merged };

  try {
    await storage.setItem(name, wrapper);
  } catch (error) {
    if (isDevEnv()) {
      logger.warn('Failed to persist preset patch', { error });
    }
  }
}

interface ToolbarPresetSelectorProps {
  /** Optional class name for the dropdown */
  className?: string | undefined;
  /** Called when filter patterns change (to update file tree) */
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
}

interface ActiveFilterState {
  excludeFilters: readonly string[];
  includeFilters: readonly string[];
  useRegex: boolean;
}

function areFilterListsEquivalent(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const counts = new Map<string, number>();
  for (const value of left) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  for (const value of right) {
    const count = counts.get(value);
    if (!count) {
      return false;
    }
    if (count === 1) {
      counts.delete(value);
      continue;
    }
    counts.set(value, count - 1);
  }

  return counts.size === 0;
}

function doesPresetMatchFilters(
  preset: ViewFilterPreset,
  activeFilters: ActiveFilterState
): boolean {
  return (
    preset.useRegex === activeFilters.useRegex &&
    areFilterListsEquivalent(preset.includes, activeFilters.includeFilters) &&
    areFilterListsEquivalent(preset.excludes, activeFilters.excludeFilters)
  );
}

function resolveSelectedPreset(
  presets: readonly ViewFilterPreset[],
  viewFilterPresetId: string | null,
  activeFilters: ActiveFilterState
): ViewFilterPreset | null {
  // Duplicate presets are resolved deterministically by list order: the first exact
  // filter match wins unless the stored preset id still points at a matching preset.
  const matchingPreset =
    presets.find((preset) => doesPresetMatchFilters(preset, activeFilters)) ?? null;

  if (!viewFilterPresetId) {
    return matchingPreset;
  }

  const presetById = presets.find((preset) => preset.id === viewFilterPresetId) ?? null;
  if (!presetById) {
    return matchingPreset;
  }

  return doesPresetMatchFilters(presetById, activeFilters) ? presetById : matchingPreset;
}

/**
 * Internal component that handles store connection and persistence.
 * Separated to ensure stable hook order for React Compiler.
 */
const ToolbarPresetSelectorInner: React.FC<
  ToolbarPresetSelectorProps & {
    excludeFilters: readonly string[];
    includeFilters: readonly string[];
    viewFilterPresetId: string | null;
    useRegex: boolean;
    setViewFilterPresetId: (id: string | null) => void;
    setFilters: (includes: string[], excludes: string[]) => void;
    setUseRegex: (useRegex: boolean) => void;
    persistPatch: (patch: Record<string, unknown>) => Promise<void>;
  }
> = React.memo(
  ({
    onFilterChange,
    className,
    includeFilters,
    excludeFilters,
    useRegex,
    viewFilterPresetId,
    setViewFilterPresetId,
    setFilters,
    setUseRegex,
    persistPatch,
  }) => {
    // Load presets from database
    const { presets, loading, error, createPreset, updatePreset, deletePreset } =
      useViewFilterPresets();

    const activeFilters = useMemo<ActiveFilterState>(
      () => ({
        includeFilters,
        excludeFilters,
        useRegex,
      }),
      [includeFilters, excludeFilters, useRegex]
    );
    const [optimisticPresetId, setOptimisticPresetId] = useState<string | null>(null);

    // The active preset is the exact preset whose filter triplet matches the live filter state.
    // viewFilterPresetId is synchronized to that canonical match and must not drift independently.
    const selectedPreset = useMemo(
      () => resolveSelectedPreset(presets, viewFilterPresetId, activeFilters),
      [presets, viewFilterPresetId, activeFilters]
    );

    const displayedPreset = useMemo(() => {
      if (!optimisticPresetId) {
        return selectedPreset;
      }

      return presets.find((preset) => preset.id === optimisticPresetId) ?? selectedPreset;
    }, [optimisticPresetId, presets, selectedPreset]);

    useEffect(() => {
      if (!optimisticPresetId) {
        return;
      }

      if (selectedPreset?.id === optimisticPresetId) {
        setOptimisticPresetId(null);
        return;
      }

      const optimisticPreset = presets.find((preset) => preset.id === optimisticPresetId) ?? null;
      if (!optimisticPreset) {
        setOptimisticPresetId(null);
      }
    }, [optimisticPresetId, presets, selectedPreset]);

    useEffect(() => {
      if (loading || error || optimisticPresetId) {
        return;
      }

      const selectedPresetId = selectedPreset?.id ?? null;
      if (viewFilterPresetId === selectedPresetId) {
        return;
      }

      setViewFilterPresetId(selectedPresetId);
      void persistPatch({ viewFilterPresetId: selectedPresetId }).catch((error: unknown) => {
        if (isDevEnv()) {
          logger.warn('Failed to persist preset sync', { error });
        }
      });
    }, [
      error,
      loading,
      optimisticPresetId,
      persistPatch,
      selectedPreset,
      setViewFilterPresetId,
      viewFilterPresetId,
    ]);

    // Handle preset selection with persistence
    const handlePresetSelect = useCallback(
      async (preset: ViewFilterPreset) => {
        setOptimisticPresetId(preset.id);
        // Apply the filter payload before setting the preset id so the synchronization
        // effect never observes a new preset id against stale filter state.
        setFilters(preset.includes, preset.excludes);
        setUseRegex(preset.useRegex);
        setViewFilterPresetId(preset.id);

        // Defer expensive tree filtering to prevent UI blocking on large trees.
        // startTransition allows React to interrupt this work if the user
        // interacts with the UI, keeping the app responsive.
        React.startTransition(() => {
          onFilterChange(preset.includes, preset.excludes, preset.useRegex);
        });

        // Persist to storage (async, doesn't block UI)
        try {
          await persistPatch({
            viewFilterPresetId: preset.id,
            includeFilters: preset.includes,
            excludeFilters: preset.excludes,
            useRegex: preset.useRegex,
          });
        } catch (error) {
          if (isDevEnv()) {
            logger.warn('Failed to persist preset selection', { error });
          }
        }
      },
      [setViewFilterPresetId, setFilters, setUseRegex, onFilterChange, persistPatch]
    );

    return (
      <ViewFilterPresetDropdown
        className={className}
        loading={loading}
        onCreate={createPreset}
        onDelete={deletePreset}
        onSelect={handlePresetSelect}
        onUpdate={updatePreset}
        presets={presets}
        selectedPreset={displayedPreset}
      />
    );
  }
);

ToolbarPresetSelectorInner.displayName = 'ToolbarPresetSelectorInner';

/**
 * Toolbar Preset Selector
 *
 * Provides a compact dropdown for quick preset selection in the toolbar.
 * Connects to the file explorer store and persists changes automatically.
 */
const ToolbarPresetSelector: React.FC<ToolbarPresetSelectorProps> = React.memo(
  ({ onFilterChange, className }) => {
    const store = useFileExplorerStoreContext();

    // Subscribe to each store field independently so preset label updates
    // cannot be dropped by a composite selector equality mismatch.
    const includeFilters = useFileExplorerStoreSelector((s) => s.includeFilters);
    const excludeFilters = useFileExplorerStoreSelector((s) => s.excludeFilters);
    const useRegex = useFileExplorerStoreSelector((s) => s.useRegex);
    const viewFilterPresetId = useFileExplorerStoreSelector((s) => s.viewFilterPresetId);
    const setViewFilterPresetId = useFileExplorerStoreSelector((s) => s.setViewFilterPresetId);
    const setFilters = useFileExplorerStoreSelector((s) => s.setFilters);
    const setUseRegex = useFileExplorerStoreSelector((s) => s.setUseRegex);

    // Create persist helper - stable reference via useCallback
    const persistPatch = useCallback(
      async (patch: Record<string, unknown>) => {
        const resolved = resolveStorePersistApi(store);
        if (!resolved) {
          return;
        }
        await mergeAndWriteStoragePatch(
          resolved.storage,
          resolved.name,
          resolved.version,
          resolved.getState,
          resolved.partialize,
          patch
        );
      },
      [store]
    );

    return (
      <ToolbarPresetSelectorInner
        className={className}
        excludeFilters={excludeFilters}
        includeFilters={includeFilters}
        onFilterChange={onFilterChange}
        persistPatch={persistPatch}
        setFilters={setFilters}
        setUseRegex={setUseRegex}
        setViewFilterPresetId={setViewFilterPresetId}
        useRegex={useRegex}
        viewFilterPresetId={viewFilterPresetId}
      />
    );
  }
);

ToolbarPresetSelector.displayName = 'ToolbarPresetSelector';

export type { ToolbarPresetSelectorProps };
export { ToolbarPresetSelector };
