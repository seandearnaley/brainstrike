/**
 * Workspace Filter Selectors
 *
 * Zustand selector functions for accessing workspace filter settings from the store.
 * These are hoisted to module level to avoid recreation on each render, ensuring
 * stable references for Zustand subscriptions.
 *
 * @module workspace-filter-selectors
 */

import type { FileExplorerState } from '@brainstrike/types';
import { useMemo } from 'react';
import { useOptionalFileExplorerStoreSelector } from '../shell/file-explorer-provider';

/** Selector for include filters (glob patterns like *.ts, *.tsx) */
export const selectIncludeFilters = (s: FileExplorerState): string[] => s.includeFilters;

/** Selector for exclude filters (patterns like node_modules, .turbo) */
export const selectExcludeFilters = (s: FileExplorerState): string[] => s.excludeFilters;

/** Selector for regex mode flag */
export const selectUseRegex = (s: FileExplorerState): boolean => s.useRegex;

/** Selector for the include filters the user has toggled OFF. */
export const selectDisabledIncludeFilters = (s: FileExplorerState): ReadonlySet<string> =>
  s.disabledIncludeFilters;

/** Selector for the exclude filters the user has toggled OFF. */
export const selectDisabledExcludeFilters = (s: FileExplorerState): ReadonlySet<string> =>
  s.disabledExcludeFilters;

const EMPTY_FILTERS: string[] = [];
const EMPTY_DISABLED: ReadonlySet<string> = new Set<string>();

export interface ActiveWorkspaceFilters {
  excludeFilters: string[];
  includeFilters: string[];
  useRegex: boolean;
}

/**
 * The ONE derivation of the workspace's EFFECTIVE view filters: the global
 * filter lists minus the entries the user has toggled off. Every consumer —
 * tree display, recursive folder select, select-all — must read filters
 * through this hook so what the trees show is exactly what scans can select.
 * (Scans previously read the RAW lists and ignored disabled toggles, so
 * "switch to all files" via toggles never reached them.)
 */
export function useActiveWorkspaceFilters(): ActiveWorkspaceFilters {
  const includeFiltersRaw = useOptionalFileExplorerStoreSelector(
    selectIncludeFilters,
    EMPTY_FILTERS
  );
  const excludeFiltersRaw = useOptionalFileExplorerStoreSelector(
    selectExcludeFilters,
    EMPTY_FILTERS
  );
  const useRegex = useOptionalFileExplorerStoreSelector(selectUseRegex, false);
  const disabledIncludeFilters = useOptionalFileExplorerStoreSelector(
    selectDisabledIncludeFilters,
    EMPTY_DISABLED
  );
  const disabledExcludeFilters = useOptionalFileExplorerStoreSelector(
    selectDisabledExcludeFilters,
    EMPTY_DISABLED
  );

  const includeFilters = useMemo(
    () => includeFiltersRaw.filter((f) => !disabledIncludeFilters.has(f)),
    [includeFiltersRaw, disabledIncludeFilters]
  );
  const excludeFilters = useMemo(
    () => excludeFiltersRaw.filter((f) => !disabledExcludeFilters.has(f)),
    [excludeFiltersRaw, disabledExcludeFilters]
  );

  return useMemo(
    () => ({ includeFilters, excludeFilters, useRegex }),
    [includeFilters, excludeFilters, useRegex]
  );
}
