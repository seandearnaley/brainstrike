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

import type { ChunkedSelectionResult } from '@brainstrike/file-explorer';
import type { IFileNode } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import * as React from 'react';
import { useCallback, useEffect } from 'react';
import type { SelectAllResult } from './hooks/use-recursive-select-all';

// NOTE: `| undefined` on optional props is required due to exactOptionalPropertyTypes: true in tsconfig.
// This ensures type compatibility when passing potentially-undefined values from parent components.
export interface ActionButtonsProps {
  /** Add multiple selected files (used by recursive selection) */
  addMultipleSelectedFiles?: ((folderId: string, paths: string[]) => void) | undefined;
  /** Add multiple selected files using chunked scheduling */
  addMultipleSelectedFilesChunked?:
    | ((
        folderId: string,
        paths: string[],
        options?: { signal?: AbortSignal }
      ) => Promise<ChunkedSelectionResult>)
    | undefined;
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
  onSelectionLimitExceeded?: (() => void) | undefined;
  /**
   * Recursively select all files in the provided tree, loading if needed.
   * IMPORTANT: The first parameter is the filtered tree to operate on.
   */
  selectAllRecursively?:
    | ((
        filteredTree: IFileNode[],
        folderId: string,
        addMultipleSelectedFiles: (folderId: string, paths: string[]) => void,
        maxSelectionCount: number
      ) => Promise<SelectAllResult>)
    | undefined;
  selectedFilePaths: Set<string>;
  setSelectedFiles: (files: Set<string>) => void;
  /** Precomputed visible file paths for the current filtered tree */
  visibleFilePaths?: readonly string[] | undefined;
  workspaceExcludeFilters?: readonly string[] | undefined;
  workspaceIncludeFilters?: readonly string[] | undefined;
  workspaceUseRegex?: boolean | undefined;
}

export const ActionButtons = React.memo(
  ({
    displayedFiles,
    selectedFilePaths,
    maxSelectionCount,
    currentFolderId,
    setSelectedFiles,
    encodeFileSelection,
    onSelectionLimitExceeded,
    hasFilesInTree = false,
    filteredTree,
    hasActiveQuickFilter = false,
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll = false,
    addMultipleSelectedFiles,
    addMultipleSelectedFilesChunked: _addMultipleSelectedFilesChunked,
    visibleFilePaths,
    workspaceExcludeFilters: _workspaceExcludeFilters,
    workspaceIncludeFilters: _workspaceIncludeFilters,
    workspaceUseRegex: _workspaceUseRegex,
  }: ActionButtonsProps) => {
    useEffect(() => {
      return () => {};
    }, []);

    /**
     * Performs recursive selection using the tree worker API.
     * Loads all directories then selects files up to the limit.
     */
    const performRecursiveSelection = useCallback(
      async (folderId: string): Promise<void> => {
        if (!(selectAllRecursively && addMultipleSelectedFiles && filteredTree)) {
          return;
        }

        const result = await selectAllRecursively(
          filteredTree,
          folderId,
          addMultipleSelectedFiles,
          maxSelectionCount
        );

        if (result.limitReached && onSelectionLimitExceeded) {
          onSelectionLimitExceeded();
        }
      },
      [
        selectAllRecursively,
        addMultipleSelectedFiles,
        filteredTree,
        maxSelectionCount,
        onSelectionLimitExceeded,
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

        if (sourcePaths.length > maxSelectionCount && onSelectionLimitExceeded) {
          onSelectionLimitExceeded();
        }
        setSelectedFiles(new Set(filesToSelect));
      },
      [
        hasActiveQuickFilter,
        displayedFiles,
        visibleFilePaths,
        maxSelectionCount,
        encodeFileSelection,
        onSelectionLimitExceeded,
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
    const isSelecting = isLoadingForSelectAll;

    // Enable button if there are displayed files OR if tree has files (for recursive selection)
    const canSelectFiles = hasActiveQuickFilter
      ? (visibleFilePaths?.length ?? 0) > 0
      : hasDisplayedFiles || hasFilesInTree;

    const getButtonText = () => {
      if (isSelecting) {
        return 'Selecting...';
      }
      if (hasSelectedFiles) {
        return 'Deselect All';
      }
      return 'Select All';
    };

    const handleClick = () => {
      if (isSelecting) {
        handleCancel();
      } else if (hasSelectedFiles) {
        handleDeselectAll();
      } else {
        void handleSelectAll();
      }
    };

    return (
      <div className="@container/buttons flex flex-wrap items-center gap-2">
        <Button
          className="flex h-8 items-center gap-1"
          disabled={!(canSelectFiles || isSelecting)}
          onClick={handleClick}
          variant="outline"
        >
          {getButtonText()}
        </Button>
      </div>
    );
  }
);
