/**
 * Toolbar Preset Selector
 *
 * A compact view filter preset selector for the file explorer toolbar.
 * Provides quick access to preset selection without opening settings dialog.
 *
 * This component is React Compiler safe - all hooks are called unconditionally
 * at the top level with stable dependencies.
 */

import type { ViewFilterPreset } from '@brainstrike/types';
import { createLogger, isDevEnv } from '@brainstrike/utils';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useViewFilterPresets } from './hooks/use-view-filter-presets';
import { ViewFilterPresetDropdown } from './view-filter-preset-dropdown';

const logger = createLogger('ToolbarPresetSelector');

interface ZustandPersistStorage {
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
}

interface ZustandPersistOptions {
  name?: string;
  storage?: ZustandPersistStorage;
}

interface ZustandPersistApi {
  getOptions?: () => ZustandPersistOptions;
}

/** Resolve the Zustand persist API from a store reference, or null if unavailable. */
function resolveStorePersistApi(
  store: unknown
): { storage: ZustandPersistStorage; name: string } | null {
  const persistApi = (store as { persist?: ZustandPersistApi }).persist;
  if (!persistApi || typeof persistApi.getOptions !== 'function') {
    return null;
  }
  const opts = persistApi.getOptions();
  const storage = opts?.storage;
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
    return null;
  }
  return { storage, name: opts?.name ?? 'file-explorer-storage-v4' };
}

/** Merge patch into the Zustand persisted state JSON and write it back. */
async function mergeAndWriteStoragePatch(
  storage: ZustandPersistStorage,
  name: string,
  patch: Record<string, unknown>
): Promise<void> {
  let currentJson: string | null = null;
  try {
    currentJson = await storage.getItem(name);
  } catch (error) {
    if (isDevEnv()) {
      logger.warn('Failed to read preset storage', { error });
    }
    return;
  }

  let current: unknown = {};
  if (currentJson) {
    try {
      current = JSON.parse(currentJson);
    } catch {
      current = {};
    }
  }

  const currentIsObject = current !== null && typeof current === 'object';
  const currentObj = current as Record<string, unknown>;
  const hasWrapper = currentIsObject && 'state' in currentObj;
  const base = hasWrapper ? ((currentObj['state'] as Record<string, unknown>) ?? {}) : currentObj;
  const merged = { ...base, ...patch };
  const wrapper = hasWrapper ? { ...currentObj, state: merged } : { version: 1, state: merged };

  try {
    await storage.setItem(name, JSON.stringify(wrapper));
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
    const selectedPreset = useMemo(() => {
      return resolveSelectedPreset(presets, viewFilterPresetId, activeFilters);
    }, [presets, viewFilterPresetId, activeFilters]);

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

      if (selectedPreset && selectedPreset.id !== optimisticPresetId) {
        setOptimisticPresetId(null);
        return;
      }

      const optimisticPreset = presets.find((preset) => preset.id === optimisticPresetId) ?? null;
      if (!optimisticPreset) {
        setOptimisticPresetId(null);
      }
    }, [optimisticPresetId, presets, selectedPreset]);

    useEffect(() => {
      if (loading || error) {
        return;
      }

      const selectedPresetId = selectedPreset?.id ?? null;
      if (viewFilterPresetId === selectedPresetId) {
        return;
      }

      setViewFilterPresetId(selectedPresetId);
      void persistPatch({ viewFilterPresetId: selectedPresetId });
    }, [error, loading, persistPatch, selectedPreset, setViewFilterPresetId, viewFilterPresetId]);

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
    const includeFilters = store((s) => s.includeFilters);
    const excludeFilters = store((s) => s.excludeFilters);
    const useRegex = store((s) => s.useRegex);
    const viewFilterPresetId = store((s) => s.viewFilterPresetId);
    const setViewFilterPresetId = store((s) => s.setViewFilterPresetId);
    const setFilters = store((s) => s.setFilters);
    const setUseRegex = store((s) => s.setUseRegex);

    // Create persist helper - stable reference via useCallback
    const persistPatch = useCallback(
      async (patch: Record<string, unknown>) => {
        const resolved = resolveStorePersistApi(store);
        if (!resolved) {
          return;
        }
        await mergeAndWriteStoragePatch(resolved.storage, resolved.name, patch);
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

export { ToolbarPresetSelector };
export type { ToolbarPresetSelectorProps };
