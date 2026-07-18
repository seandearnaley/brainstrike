/**
 * ActionButtons Component
 *
 * Provides controls for bulk file selection operations in the file explorer.
 * The component implements a smart "Select All" functionality that respects
 * the maximum selection limit while maintaining a good user experience.
 *
 * Key behaviors:
 * 1. Recursive selection: Loads all directories in the tree before selecting
 * 2. When files are within max limit: Allows selecting all files at once
 * 3. When files exceed max limit: Allows selecting up to the max limit
 * 4. When files are selected: Provides option to deselect all files
 *
 * The button text dynamically updates to indicate:
 * - "Select All" when no files are selected
 * - "Selecting..." when loading tree for selection
 * - "Deselect All" when files are currently selected
 */

import type { IFileNode } from '@brainstrike/types';
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { CheckCheck, X } from 'lucide-react';
import * as React from 'react';
import { useCallback, useMemo } from 'react';
import type { AddMultipleSelectedFilesChunked } from './hooks/recursive-selection-utils';
import type { SelectAllResult } from './hooks/use-recursive-select-all';

// NOTE: `| undefined` on optional props is required due to exactOptionalPropertyTypes: true in tsconfig.
// This ensures type compatibility when passing potentially-undefined values from parent components.
export interface ActionButtonsProps {
  /** Add multiple selected files (used by recursive selection) */
  addMultipleSelectedFiles?: ((folderId: string, paths: string[]) => void) | undefined;
  /** Add multiple selected files with cooperative chunking for large recursive selections. */
  addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked | undefined;
  /** Cancel the current recursive selection operation */
  cancelSelectAll?: (() => void) | undefined;
  currentFolderId: string | null;
  displayedFiles: Set<string>;
  encodeFileSelection: (folderId: string, path: string) => string;
  /**
   * The FILTERED file tree to select from.
   * Pass quickFilteredTree to respect workspace include/exclude filters.
   */
  filteredTree?: IFileNode[] | undefined;
  hasActiveQuickFilter?: boolean | undefined;
  /** Whether the tree has any files (used to enable/disable Select All) */
  hasFilesInTree?: boolean | undefined;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll?: boolean | undefined;
  maxSelectionCount: number;
  /**
   * FOREST MODE override for quick-filter Select All: selects the visible
   * quick-filter matches across EVERY root (the local fallback only sees the
   * focused panel tree). When provided it owns the whole quick-filter path,
   * including zero-match feedback.
   */
  quickFilterSelectAllOverride?: (() => void) | undefined;
  /**
   * Recursively select all files in the provided tree, loading if needed.
   * IMPORTANT: The first parameter is the filtered tree to operate on.
   */
  selectAllRecursively?:
    | ((
        filteredTree: IFileNode[],
        folderId: string,
        addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
        maxSelectionCount: number,
        addMultipleSelectedFilesChunked?: AddMultipleSelectedFilesChunked
      ) => Promise<SelectAllResult>)
    | undefined;
  selectedFilePaths: Set<string>;
  setSelectedFiles: (files: Set<string>) => void;
  /** Precomputed visible file paths for the current filtered tree */
  visibleFilePaths?: readonly string[] | undefined;
}

export const ActionButtons = React.memo(
  ({
    displayedFiles,
    selectedFilePaths,
    maxSelectionCount,
    currentFolderId,
    setSelectedFiles,
    encodeFileSelection,
    hasFilesInTree = false,
    filteredTree,
    hasActiveQuickFilter = false,
    quickFilterSelectAllOverride,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll = false,
    addMultipleSelectedFiles,
    addMultipleSelectedFilesChunked,
    visibleFilePaths,
  }: ActionButtonsProps) => {
    /**
     * Performs recursive selection using the tree worker API.
     * Loads all directories then selects files up to the limit.
     */
    const performRecursiveSelection = useCallback(
      async (folderId: string): Promise<SelectAllResult | undefined> => {
        if (!(selectAllRecursively && addMultipleSelectedFiles && filteredTree)) {
          return;
        }

        return selectAllRecursively(
          filteredTree,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount,
          addMultipleSelectedFilesChunked
        );
      },
      [
        selectAllRecursively,
        addMultipleSelectedFiles,
        filteredTree,
        maxSelectionCount,
        addMultipleSelectedFilesChunked,
      ]
    );

    /**
     * Fallback selection for when recursive API is not available.
     * Only selects from currently displayed files.
     */
    const performFallbackSelection = useCallback(
      (folderId: string): void => {
        const sourcePaths =
          hasActiveQuickFilter && visibleFilePaths && visibleFilePaths.length > 0
            ? visibleFilePaths
            : Array.from(displayedFiles);

        const filesToSelect = sourcePaths
          .slice(0, maxSelectionCount)
          .map((path) => encodeFileSelection(folderId, path));

        setSelectedFiles(new Set(filesToSelect));
      },
      [
        hasActiveQuickFilter,
        displayedFiles,
        visibleFilePaths,
        maxSelectionCount,
        encodeFileSelection,
        setSelectedFiles,
      ]
    );

    /**
     * Main selection handler - routes to recursive or fallback strategy.
     */
    const handleSelectAll = useCallback(async () => {
      if (!currentFolderId) {
        return;
      }

      if (hasActiveQuickFilter) {
        if (quickFilterSelectAllOverride) {
          quickFilterSelectAllOverride();
          return;
        }
        performFallbackSelection(currentFolderId);
        return;
      }

      const canUseRecursive = selectAllRecursively && addMultipleSelectedFiles && filteredTree;

      if (canUseRecursive) {
        await performRecursiveSelection(currentFolderId);
      } else {
        performFallbackSelection(currentFolderId);
      }
    }, [
      currentFolderId,
      selectAllRecursively,
      addMultipleSelectedFiles,
      filteredTree,
      performRecursiveSelection,
      performFallbackSelection,
      hasActiveQuickFilter,
      quickFilterSelectAllOverride,
    ]);

    // Clears all selected files
    const handleDeselectAll = useCallback(() => {
      setSelectedFiles(new Set());
    }, [setSelectedFiles]);

    // Handle cancel of recursive selection
    const handleCancel = useCallback(() => {
      if (cancelSelectAll) {
        cancelSelectAll();
      }
    }, [cancelSelectAll]);

    const hasDisplayedFiles = displayedFiles.size > 0;
    const hasSelectedFiles = selectedFilePaths.size > 0;

    // Enable button if there are displayed files OR if tree has files (for
    // recursive selection). The forest quick-filter override owns its own
    // zero-match feedback, so its presence keeps the button live.
    const canSelectFiles = hasActiveQuickFilter
      ? Boolean(quickFilterSelectAllOverride) || (visibleFilePaths?.length ?? 0) > 0
      : hasDisplayedFiles || hasFilesInTree;

    const getButtonText = () => {
      if (isLoadingForSelectAll) {
        return 'Selecting...';
      }
      if (hasSelectedFiles) {
        return 'Deselect All';
      }
      return 'Select All';
    };

    const getCompactButtonText = () => {
      if (isLoadingForSelectAll) {
        return 'Selecting';
      }
      if (hasSelectedFiles) {
        return 'Clear';
      }
      return 'Select';
    };

    const actionLabel = getButtonText();
    const compactActionLabel = getCompactButtonText();
    const ActionIcon = hasSelectedFiles ? X : CheckCheck;
    const tooltipLabel = useMemo(() => {
      if (isLoadingForSelectAll) {
        return 'Cancel recursive selection';
      }
      if (hasSelectedFiles) {
        return 'Clear the current file selection';
      }
      if (!canSelectFiles) {
        return 'No files are available to select';
      }
      if (hasActiveQuickFilter) {
        return 'Select all visible files in the current filtered view';
      }
      return 'Select all files in the current explorer view';
    }, [canSelectFiles, hasActiveQuickFilter, hasSelectedFiles, isLoadingForSelectAll]);

    const handleClick = () => {
      if (isLoadingForSelectAll) {
        handleCancel();
      } else if (hasSelectedFiles) {
        handleDeselectAll();
      } else {
        void handleSelectAll();
      }
    };

    return (
      <div className="flex min-w-0 items-center gap-2">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  aria-label={actionLabel}
                  className="flex @[96px]:size-7 size-6 @[180px]:w-auto min-w-0 items-center gap-1 p-0 @[180px]:px-2 @[260px]:px-3"
                  disabled={!(canSelectFiles || isLoadingForSelectAll)}
                  onClick={handleClick}
                  size="icon-xs"
                  variant="outline"
                >
                  <ActionIcon className="size-3.5" />
                  <span
                    aria-hidden="true"
                    className="@[180px]:inline @[280px]:hidden hidden"
                    data-testid="bulk-action-short-label"
                  >
                    {compactActionLabel}
                  </span>
                  <span
                    aria-hidden="true"
                    className="@[280px]:inline hidden"
                    data-testid="bulk-action-full-label"
                  >
                    {actionLabel}
                  </span>
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">{tooltipLabel}</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }
);
