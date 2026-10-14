import {
  createViewFilterPresetRepository,
  getViewFilterPresetCapability,
} from './view-filter-preset-capability';
/**
 * View Filter Presets Hook
 *
 * Provides reactive access to view filter presets stored in the database.
 * Supports both web (Drizzle live queries) and Electron (repository polling).
 */

import { viewFilterPresets } from '@brainstrike/db';
import {
  useDbInitializing,
  useDbProviderError,
  useDrizzleDb,
  useDrizzleLiveQuery,
  useViewFilterPresetsRepository,
} from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import type {
  CreateViewFilterPresetInput,
  UpdateViewFilterPresetInput,
  ViewFilterPreset,
} from '@brainstrike/types';
import { asc } from 'drizzle-orm';
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
  /** Refresh presets from database (useful for Electron after external changes) */
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
  const capability = getViewFilterPresetCapability();
  const drizzleDb = useDrizzleDb({ enabled: !capability });
  const dbInitializing = useDbInitializing({ enabled: !capability });
  const dbProviderError = useDbProviderError({ enabled: !capability });
  const webRepository = useViewFilterPresetsRepository({ enabled: !capability });
  const nativeRepository = useMemo(
    () => (capability ? createViewFilterPresetRepository(capability) : null),
    [capability]
  );
  const repository = nativeRepository ?? webRepository;

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
      createdAt: row.createdAt,
      description: row.description,
      excludes: row.excludes ?? [],
      icon: row.icon as ViewFilterPreset['icon'],
      id: row.id,
      includes: row.includes ?? [],
      isDefault: row.isDefault,
      name: row.name,
      sortOrder: row.sortOrder,
      updatedAt: row.updatedAt,
      useRegex: row.useRegex,
    }));
  }, [rows]);

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

  // Fetch repository data when repository changes (Electron path).
  // This effect must re-run on React dev replay as well as true repository changes.
  // Suppressing the replay with a ref leaves the first aborted request as the only
  // one that ever ran, which traps the UI in "Loading presets..." forever.
  useEffect(() => {
    if (useDrizzlePath || !repository) {
      // Not using repository path, ensure loading is false
      setRepoLoading(false);
      return;
    }

    const controller = new AbortController();
    void fetchPresetsRef.current(controller.signal);

    return () => {
      controller.abort();
    };
  }, [useDrizzlePath, repository]);

  // Select the appropriate presets based on path
  const presets = useDrizzlePath ? drizzlePresets : repoPresets;
  // Only surface provider initialization as loading when the repository does not
  // yet exist. Once the repository is usable, callers should render its data
  // immediately instead of staying trapped behind a global DB spinner.
  const loading = useDrizzlePath ? drizzleLoading : repoLoading || (!repository && dbInitializing);
  const error = useDrizzlePath ? drizzleError : (repoError ?? dbProviderError);

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
