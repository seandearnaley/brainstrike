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

/** Selector for include filters (glob patterns like *.ts, *.tsx) */
export const selectIncludeFilters = (s: FileExplorerState): string[] => s.includeFilters;

/** Selector for exclude filters (patterns like node_modules, .turbo) */
export const selectExcludeFilters = (s: FileExplorerState): string[] => s.excludeFilters;

/** Selector for regex mode flag */
export const selectUseRegex = (s: FileExplorerState): boolean => s.useRegex;
