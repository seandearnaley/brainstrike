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
import { useCallback, useMemo } from 'react';
import { useFileExplorerStoreContext } from './file-explorer-provider';
import { useViewFilterPresets } from './hooks/use-view-filter-presets';
import { ViewFilterPresetDropdown } from './view-filter-preset-dropdown';

const logger = createLogger('ToolbarPresetSelector');

interface ToolbarPresetSelectorProps {
  /** Called when filter patterns change (to update file tree) */
  onFilterChange: (includeFilters: string[], excludeFilters: string[], useRegex: boolean) => void;
  /** Optional class name for the dropdown */
  className?: string | undefined;
}

/**
 * Internal component that handles store connection and persistence.
 * Separated to ensure stable hook order for React Compiler.
 */
const ToolbarPresetSelectorInner: React.FC<
  ToolbarPresetSelectorProps & {
    viewFilterPresetId: string | null;
    setViewFilterPresetId: (id: string | null) => void;
    setFilters: (includes: string[], excludes: string[]) => void;
    setUseRegex: (useRegex: boolean) => void;
    persistPatch: (patch: Record<string, unknown>) => Promise<void>;
  }
> = React.memo(
  ({
    onFilterChange,
    className,
    viewFilterPresetId,
    setViewFilterPresetId,
    setFilters,
    setUseRegex,
    persistPatch,
  }) => {
    // Load presets from database
    const { presets, loading, createPreset, updatePreset, deletePreset } = useViewFilterPresets();

    // Find the currently selected preset
    const selectedPreset = useMemo(() => {
      if (!viewFilterPresetId) {
        return null;
      }
      return presets.find((p) => p.id === viewFilterPresetId) ?? null;
    }, [presets, viewFilterPresetId]);

    // Handle preset selection with persistence
    const handlePresetSelect = useCallback(
      async (preset: ViewFilterPreset) => {
        // Update store state (batched by React 18)
        setViewFilterPresetId(preset.id);
        setFilters(preset.includes, preset.excludes);
        setUseRegex(preset.useRegex);

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
        selectedPreset={selectedPreset}
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

    // Extract store values and actions - must be unconditional for React Compiler
    const [viewFilterPresetId, setViewFilterPresetId, setFilters, setUseRegex] = store((s) => [
      s.viewFilterPresetId,
      s.setViewFilterPresetId,
      s.setFilters,
      s.setUseRegex,
    ]);

    // Create persist helper - stable reference via useCallback
    const persistPatch = useCallback(
      async (patch: Record<string, unknown>) => {
        try {
          const persistApi = (
            store as unknown as {
              persist?: {
                getOptions?: () => {
                  name?: string;
                  storage?: {
                    getItem: (key: string) => Promise<string | null> | string | null;
                    setItem: (key: string, value: string) => Promise<void> | void;
                  };
                };
              };
            }
          ).persist;

          if (!persistApi || typeof persistApi.getOptions !== 'function') {
            return;
          }

          const opts = persistApi.getOptions();
          const storage = opts?.storage;
          if (
            !storage ||
            typeof storage.getItem !== 'function' ||
            typeof storage.setItem !== 'function'
          ) {
            return;
          }

          const name = opts?.name ?? 'file-explorer-storage-v4';
          const currentJson = await storage.getItem(name);
          const current = currentJson ? JSON.parse(currentJson) : {};

          // Merge patch with existing state
          const hasWrapper = current && typeof current === 'object' && 'state' in current;
          const base = (hasWrapper ? (current as { state: unknown }).state : current) || {};
          const merged = { ...base, ...patch };
          const wrapper = hasWrapper
            ? { ...current, state: merged }
            : { version: 1, state: merged };

          await storage.setItem(name, JSON.stringify(wrapper));
        } catch (error) {
          if (isDevEnv()) {
            logger.warn('Failed to persist preset patch', { error });
          }
        }
      },
      [store]
    );

    return (
      <ToolbarPresetSelectorInner
        className={className}
        onFilterChange={onFilterChange}
        persistPatch={persistPatch}
        setFilters={setFilters}
        setUseRegex={setUseRegex}
        setViewFilterPresetId={setViewFilterPresetId}
        viewFilterPresetId={viewFilterPresetId}
      />
    );
  }
);

ToolbarPresetSelector.displayName = 'ToolbarPresetSelector';

export { ToolbarPresetSelector };
export type { ToolbarPresetSelectorProps };
