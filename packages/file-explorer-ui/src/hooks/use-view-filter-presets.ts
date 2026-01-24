/**
 * View Filter Presets Hook
 *
 * Provides reactive access to view filter presets stored in the database.
 * Supports both web (Drizzle live queries) and Electron (repository polling).
 */

import {
  useDrizzleDb,
  useDrizzleLiveQuery,
  useViewFilterPresetsRepository,
  viewFilterPresets,
} from '@brainstrike/db';
import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import { asc } from 'drizzle-orm';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const logger = createLogger('useViewFilterPresets');

interface UseViewFilterPresetsResult {
  /** All presets ordered by sort order */
  presets: ViewFilterPreset[];
  /** Whether the query is loading */
  loading: boolean;
  /** Error if query failed */
  error: Error | null;
  /** Create a new preset */
  createPreset: (input: CreateViewFilterPresetInput) => Promise<ViewFilterPreset>;
  /** Update an existing preset */
  updatePreset: (
    id: string,
    input: UpdateViewFilterPresetInput
  ) => Promise<ViewFilterPreset | null>;
  /** Delete a preset (cannot delete default presets) */
  deletePreset: (id: string) => Promise<boolean>;
  /** Get a specific preset by ID */
  getPreset: (id: string) => ViewFilterPreset | undefined;
  /** Refresh presets from database (useful for Electron after external changes) */
  refresh: () => Promise<void>;
}

/**
 * Hook for managing view filter presets.
 *
 * This hook automatically detects whether to use Drizzle live queries (web)
 * or the repository pattern (Electron) based on what's available.
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
  const drizzleDb = useDrizzleDb();
  const repository = useViewFilterPresetsRepository();

  // State for Electron/repository-based presets
  const [repoPresets, setRepoPresets] = useState<ViewFilterPreset[]>([]);
  const [repoLoading, setRepoLoading] = useState(true);
  const [repoError, setRepoError] = useState<Error | null>(null);

  // Track if we're using Drizzle (web) or repository (Electron) path
  const useDrizzlePath = Boolean(drizzleDb);

  // Build the live query for Drizzle path
  const query = useMemo(() => {
    if (!drizzleDb) {
      return null;
    }
    return drizzleDb.select().from(viewFilterPresets).orderBy(asc(viewFilterPresets.sortOrder));
  }, [drizzleDb]);

  // Use live query for reactive updates (web path only)
  const {
    rows,
    loading: drizzleLoading,
    error: drizzleError,
  } = useDrizzleLiveQuery<typeof viewFilterPresets.$inferSelect>(query, {
    enabled: useDrizzlePath,
  });

  // Transform Drizzle rows to ViewFilterPreset type
  const drizzlePresets: ViewFilterPreset[] = useMemo(() => {
    if (!rows) {
      return [];
    }
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      icon: row.icon as ViewFilterPreset['icon'],
      includes: row.includes ?? [],
      excludes: row.excludes ?? [],
      useRegex: row.useRegex,
      isDefault: row.isDefault,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }, [rows]);

  // Track the repository we've fetched for (to detect changes and trigger re-fetch)
  const lastFetchedRepoRef = useRef<typeof repository>(undefined);

  // Fetch presets using repository (Electron path)
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
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error('Failed to fetch presets from repository', { error: error.message });
        setRepoError(error);
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

  // Fetch repository data when repository changes (Electron path)
  // Using useEffect with cleanup for proper cancellation
  useEffect(() => {
    if (useDrizzlePath || !repository) {
      // Not using repository path, ensure loading is false
      setRepoLoading(false);
      return;
    }

    // Only fetch if repository has changed
    if (lastFetchedRepoRef.current === repository) {
      return;
    }
    lastFetchedRepoRef.current = repository;

    const controller = new AbortController();
    void fetchPresetsRef.current(controller.signal);

    return () => {
      controller.abort();
    };
  }, [useDrizzlePath, repository]);

  // Select the appropriate presets based on path
  const presets = useDrizzlePath ? drizzlePresets : repoPresets;
  const loading = useDrizzlePath ? drizzleLoading : repoLoading;
  const error = useDrizzlePath ? drizzleError : repoError;

  const createPreset = useCallback(
    async (input: CreateViewFilterPresetInput): Promise<ViewFilterPreset> => {
      if (!repository) {
        throw new Error('Database not available');
      }
      logger.info('Creating view filter preset', { name: input.name });
      const created = await repository.create(input);

      // For Electron path, refresh the presets list
      if (!useDrizzlePath) {
        await fetchPresetsFromRepo();
      }

      return created;
    },
    [repository, useDrizzlePath, fetchPresetsFromRepo]
  );

  const updatePreset = useCallback(
    async (id: string, input: UpdateViewFilterPresetInput): Promise<ViewFilterPreset | null> => {
      if (!repository) {
        throw new Error('Database not available');
      }
      logger.info('Updating view filter preset', { id });
      const updated = await repository.update(id, input);

      // For Electron path, refresh the presets list
      if (!useDrizzlePath) {
        await fetchPresetsFromRepo();
      }

      return updated;
    },
    [repository, useDrizzlePath, fetchPresetsFromRepo]
  );

  const deletePreset = useCallback(
    async (id: string): Promise<boolean> => {
      if (!repository) {
        throw new Error('Database not available');
      }
      logger.info('Deleting view filter preset', { id });
      const deleted = await repository.delete(id);

      // For Electron path, refresh the presets list
      if (!useDrizzlePath) {
        await fetchPresetsFromRepo();
      }

      return deleted;
    },
    [repository, useDrizzlePath, fetchPresetsFromRepo]
  );

  const getPreset = useCallback(
    (id: string): ViewFilterPreset | undefined => presets.find((p) => p.id === id),
    [presets]
  );

  const refresh = useCallback(async () => {
    if (!useDrizzlePath && repository) {
      await fetchPresetsFromRepo();
    }
    // For Drizzle path, the live query handles refreshes automatically
  }, [useDrizzlePath, repository, fetchPresetsFromRepo]);

  return {
    presets,
    loading,
    error,
    createPreset,
    updatePreset,
    deletePreset,
    getPreset,
    refresh,
  };
}
