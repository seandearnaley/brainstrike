import {
  createViewFilterPresetRepository,
  getViewFilterPresetCapability,
} from './view-filter-preset-capability';
/**
 * View Filter Presets Hook
 *
 * Provides access to the view filter presets owned by the native preset capability.
 */

import { createLogger } from '@brainstrike/logging';
import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const logger = createLogger('useViewFilterPresets');

interface UseViewFilterPresetsResult {
  /** Create a new preset */
  createPreset: (input: CreateViewFilterPresetInput) => Promise<ViewFilterPreset>;
  /** Delete a preset (cannot delete default presets) */
  deletePreset: (id: string) => Promise<boolean>;
  /** Error if query failed */
  error: Error | null;
  /** Get a specific preset by ID */
  getPreset: (id: string) => ViewFilterPreset | undefined;
  /** Whether the query is loading */
  loading: boolean;
  /** All presets ordered by sort order */
  presets: ViewFilterPreset[];
  /** Refresh presets from the preset capability (useful after external changes) */
  refresh: () => Promise<void>;
  /** Update an existing preset */
  updatePreset: (
    id: string,
    input: UpdateViewFilterPresetInput
  ) => Promise<ViewFilterPreset | null>;
}

/**
 * Hook for managing view filter presets.
 *
 * Presets are read through the native preset capability's repository.
 *
 * @example
 * ```tsx
 * function PresetSelector() {
 *   const { presets, loading, createPreset, deletePreset } = useViewFilterPresets();
 *
 *   if (loading) return <Spinner />;
 *
 *   return (
 *     <select>
 *       {presets.map(p => <option key={p.id}>{p.name}</option>)}
 *     </select>
 *   );
 * }
 * ```
 */
export function useViewFilterPresets(): UseViewFilterPresetsResult {
  const capability = getViewFilterPresetCapability();
  const repository = useMemo(
    () => (capability ? createViewFilterPresetRepository(capability) : null),
    [capability]
  );

  const [repoPresets, setRepoPresets] = useState<ViewFilterPreset[]>([]);
  const [repoLoading, setRepoLoading] = useState(true);
  const [repoError, setRepoError] = useState<Error | null>(null);

  // Fetch presets using the repository
  // Returns a cleanup function for AbortController cancellation
  const fetchPresetsFromRepo = useCallback(
    async (signal?: AbortSignal) => {
      if (!repository) {
        return;
      }

      try {
        setRepoLoading(true);
        setRepoError(null);
        const fetchedPresets = await repository.findAll();
        // Check if request was aborted before updating state
        if (signal?.aborted) {
          return;
        }
        setRepoPresets(fetchedPresets);
        logger.debug('Fetched presets from repository', { count: fetchedPresets.length });
      } catch (err) {
        // Ignore abort errors
        if (signal?.aborted) {
          return;
        }
        const fetchError = err instanceof Error ? err : new Error(String(err));
        logger.error('Failed to fetch presets from repository', { error: fetchError.message });
        setRepoError(fetchError);
      } finally {
        if (!signal?.aborted) {
          setRepoLoading(false);
        }
      }
    },
    [repository]
  );

  // Use ref to avoid infinite loops when fetchPresetsFromRepo is in useEffect deps
  // This pattern ensures the effect only re-runs when repository actually changes
  const fetchPresetsRef = useRef(fetchPresetsFromRepo);
  fetchPresetsRef.current = fetchPresetsFromRepo;

  // Fetch repository data when repository changes.
  // This effect must re-run on React dev replay as well as true repository changes.
  // Suppressing the replay with a ref leaves the first aborted request as the only
  // one that ever ran, which traps the UI in "Loading presets..." forever.
  useEffect(() => {
    if (!repository) {
      // No repository, ensure loading is false
      setRepoLoading(false);
      return;
    }

    const controller = new AbortController();
    void fetchPresetsRef.current(controller.signal);

    return () => {
      controller.abort();
    };
  }, [repository]);

  const presets = repoPresets;
  const loading = repoLoading;
  const error = repoError;

  const createPreset = useCallback(
    async (input: CreateViewFilterPresetInput): Promise<ViewFilterPreset> => {
      if (!repository) {
        throw new Error('Database not available');
      }
      logger.info('Creating view filter preset', { name: input.name });
      const created = await repository.create(input);

      await fetchPresetsFromRepo();

      return created;
    },
    [repository, fetchPresetsFromRepo]
  );

  const updatePreset = useCallback(
    async (id: string, input: UpdateViewFilterPresetInput): Promise<ViewFilterPreset | null> => {
      if (!repository) {
        throw new Error('Database not available');
      }
      logger.info('Updating view filter preset', { id });
      const updated = await repository.update(id, input);

      await fetchPresetsFromRepo();

      return updated;
    },
    [repository, fetchPresetsFromRepo]
  );

  const deletePreset = useCallback(
    async (id: string): Promise<boolean> => {
      if (!repository) {
        throw new Error('Database not available');
      }
      logger.info('Deleting view filter preset', { id });
      const deleted = await repository.delete(id);

      await fetchPresetsFromRepo();

      return deleted;
    },
    [repository, fetchPresetsFromRepo]
  );

  const getPreset = useCallback(
    (id: string): ViewFilterPreset | undefined => presets.find((p) => p.id === id),
    [presets]
  );

  const refresh = useCallback(async () => {
    if (repository) {
      await fetchPresetsFromRepo();
    }
  }, [repository, fetchPresetsFromRepo]);

  return {
    createPreset,
    deletePreset,
    error,
    getPreset,
    loading,
    presets,
    refresh,
    updatePreset,
  };
}
