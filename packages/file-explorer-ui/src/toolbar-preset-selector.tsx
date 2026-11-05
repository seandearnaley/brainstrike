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
import * as React from 'react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useViewFilterPresets } from './hooks/use-view-filter-presets';
import { useOptionalExplorerThreadStatus } from './shell/explorer-thread-status';
import {
  useFileExplorerStoreContext,
  useFileExplorerStoreSelector,
} from './shell/file-explorer-provider';
import { threadTouchedPreset } from './thread-touched-preset';
import { ViewFilterPresetDropdown } from './view-filter-preset-dropdown';

interface HydratablePersistApi {
  hasHydrated?: () => boolean;
  onFinishHydration?: (callback: () => void) => () => void;
}

/**
 * Tracks Zustand persist rehydration. Persisting (or syncing the preset id)
 * BEFORE rehydration serializes DEFAULT state over the user's stored settings
 * — the historical "my filters reverted on reload" clobber. Stores without a
 * persist API (tests) count as hydrated.
 */
function useStoreHydrated(store: unknown): boolean {
  const persist = (store as { persist?: HydratablePersistApi } | null)?.persist;
  const [hydrated, setHydrated] = useState(() => persist?.hasHydrated?.() ?? true);
  useEffect(() => {
    if (hydrated || !persist?.onFinishHydration) {
      return;
    }
    if (persist.hasHydrated?.()) {
      setHydrated(true);
      return;
    }
    return persist.onFinishHydration(() => setHydrated(true));
  }, [hydrated, persist]);
  return hydrated;
}

const subscribeNothing = (): (() => void) => () => undefined;
const NO_TOUCHED_PATHS: readonly string[] = [];
const noTouchedPaths = (): readonly string[] => NO_TOUCHED_PATHS;

/** "Touched in this thread", where the active thread's context is published. */
function useThreadTouchedPreset(): ViewFilterPreset | null {
  const threadStatus = useOptionalExplorerThreadStatus();
  const subscribe = threadStatus?.subscribe ?? subscribeNothing;
  const touchedPaths = useSyncExternalStore(
    subscribe,
    threadStatus?.getTouchedPaths ?? noTouchedPaths
  );
  return threadTouchedPreset(touchedPaths);
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
const ToolbarPresetSelectorInner = React.memo(
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
    clearDisabledFilters,
    isHydrated,
  }: ToolbarPresetSelectorProps & {
    excludeFilters: readonly string[];
    includeFilters: readonly string[];
    viewFilterPresetId: string | null;
    useRegex: boolean;
    setViewFilterPresetId: (id: string | null) => void;
    setFilters: (includes: string[], excludes: string[]) => void;
    setUseRegex: (useRegex: boolean) => void;
    clearDisabledFilters: () => void;
    isHydrated: boolean;
  }) => {
    // Load presets from database
    const { presets, loading, error, createPreset, updatePreset, deletePreset } =
      useViewFilterPresets();
    const threadPreset = useThreadTouchedPreset();
    // Stored presets first: the thread's never shadows a stored preset with the same filters.
    const selectablePresets = threadPreset ? [...presets, threadPreset] : presets;

    const activeFilters: ActiveFilterState = {
      excludeFilters,
      includeFilters,
      useRegex,
    };
    const [optimisticPresetId, setOptimisticPresetId] = useState<string | null>(null);

    // The active preset is the exact preset whose filter triplet matches the live filter state.
    // viewFilterPresetId is synchronized to that canonical match and must not drift independently.
    const selectedPreset = useMemo(
      () => resolveSelectedPreset(selectablePresets, viewFilterPresetId, activeFilters),
      [selectablePresets, viewFilterPresetId, activeFilters]
    );

    const displayedPreset = useMemo(() => {
      if (!optimisticPresetId) {
        return selectedPreset;
      }

      return selectablePresets.find((preset) => preset.id === optimisticPresetId) ?? selectedPreset;
    }, [optimisticPresetId, selectablePresets, selectedPreset]);

    useEffect(() => {
      if (!optimisticPresetId) {
        return;
      }

      if (selectedPreset?.id === optimisticPresetId) {
        setOptimisticPresetId(null);
        return;
      }

      const optimisticPreset =
        selectablePresets.find((preset) => preset.id === optimisticPresetId) ?? null;
      if (!optimisticPreset) {
        setOptimisticPresetId(null);
      }
    }, [optimisticPresetId, selectablePresets, selectedPreset]);

    useEffect(() => {
      // Pre-rehydration the store holds DEFAULT filters — syncing (and
      // persisting) the preset id against them clobbers the user's stored
      // settings. Wait for hydration.
      if (!isHydrated || loading || error || optimisticPresetId) {
        return;
      }

      const selectedPresetId = selectedPreset?.id ?? null;
      if (viewFilterPresetId === selectedPresetId) {
        return;
      }

      setViewFilterPresetId(selectedPresetId);
    }, [
      error,
      isHydrated,
      loading,
      optimisticPresetId,
      selectedPreset,
      setViewFilterPresetId,
      viewFilterPresetId,
    ]);

    // The store's persist middleware saves each change as it is set.
    const handlePresetSelect = (preset: ViewFilterPreset) => {
      setOptimisticPresetId(preset.id);
      // Apply the filter payload before setting the preset id so the synchronization
      // effect never observes a new preset id against stale filter state.
      setFilters(preset.includes, preset.excludes);
      // Stale per-entry disable toggles reference the OUTGOING lists; a
      // preset that reintroduces a toggled-off string must not arrive
      // silently disabled (spike B9) — the effective filters ARE the preset.
      clearDisabledFilters();
      setUseRegex(preset.useRegex);
      setViewFilterPresetId(preset.id);

      // Defer expensive tree filtering to prevent UI blocking on large trees.
      // startTransition allows React to interrupt this work if the user
      // interacts with the UI, keeping the app responsive.
      React.startTransition(() => {
        onFilterChange(preset.includes, preset.excludes, preset.useRegex);
      });
    };

    // Filters are active but match no preset — the trigger must say so
    // rather than implying nothing is filtered.
    const hasCustomFilters =
      !displayedPreset && (includeFilters.length > 0 || excludeFilters.length > 0);

    return (
      <ViewFilterPresetDropdown
        className={className}
        hasCustomFilters={hasCustomFilters}
        loading={loading}
        onCreate={createPreset}
        onDelete={deletePreset}
        onSelect={handlePresetSelect}
        onUpdate={updatePreset}
        presets={presets}
        selectedPreset={displayedPreset}
        threadPreset={threadPreset}
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
const ToolbarPresetSelector = React.memo(
  ({ onFilterChange, className }: ToolbarPresetSelectorProps) => {
    const store = useFileExplorerStoreContext();
    const isHydrated = useStoreHydrated(store);

    // Subscribe to each store field independently so preset label updates
    // cannot be dropped by a composite selector equality mismatch.
    const includeFilters = useFileExplorerStoreSelector((s) => s.includeFilters);
    const excludeFilters = useFileExplorerStoreSelector((s) => s.excludeFilters);
    const useRegex = useFileExplorerStoreSelector((s) => s.useRegex);
    const viewFilterPresetId = useFileExplorerStoreSelector((s) => s.viewFilterPresetId);
    const setViewFilterPresetId = useFileExplorerStoreSelector((s) => s.setViewFilterPresetId);
    const setFilters = useFileExplorerStoreSelector((s) => s.setFilters);
    const setUseRegex = useFileExplorerStoreSelector((s) => s.setUseRegex);
    const clearDisabledFilters = useFileExplorerStoreSelector((s) => s.clearDisabledFilters);

    return (
      <ToolbarPresetSelectorInner
        className={className}
        clearDisabledFilters={clearDisabledFilters}
        excludeFilters={excludeFilters}
        includeFilters={includeFilters}
        isHydrated={isHydrated}
        onFilterChange={onFilterChange}
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
