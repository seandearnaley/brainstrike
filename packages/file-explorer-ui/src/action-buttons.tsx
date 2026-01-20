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
import { Button } from '@brainstrike/ui';
import * as React from 'react';
import { useCallback } from 'react';
import type { SelectAllResult } from './hooks/use-recursive-select-all';

export interface ActionButtonsProps {
  displayedFiles: Set<string>;
  selectedFilePaths: Set<string>;
  maxSelectionCount: number;
  currentFolderId: string | null;
  setSelectedFiles: (files: Set<string>) => void;
  encodeFileSelection: (folderId: string, path: string) => string;
  onSelectionLimitExceeded?: (() => void) | undefined;
  /** Whether the tree has any files (used to enable/disable Select All) */
  hasFilesInTree?: boolean | undefined;
  /**
   * The FILTERED file tree to select from.
   * Pass quickFilteredTree to respect workspace include/exclude filters.
   */
  filteredTree?: IFileNode[] | undefined;
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
  /** Cancel the current recursive selection operation */
  cancelSelectAll?: (() => void) | undefined;
  /** Whether the tree is being loaded for select all */
  isLoadingForSelectAll?: boolean | undefined;
  /** Add multiple selected files (used by recursive selection) */
  addMultipleSelectedFiles?: ((folderId: string, paths: string[]) => void) | undefined;
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
    selectAllRecursively,
    cancelSelectAll,
    isLoadingForSelectAll = false,
    addMultipleSelectedFiles,
  }: ActionButtonsProps) => {
    /**
     * Handles recursive selection of all files in the tree.
     * Uses the new recursive selection API when available, falling back
     * to selecting only displayed files when not.
     */
    const handleSelectAll = useCallback(async () => {
      if (!currentFolderId) {
        return;
      }

      // Use recursive selection if available and we have a filtered tree
      // The filtered tree ensures workspace include/exclude filters are respected
      if (selectAllRecursively && addMultipleSelectedFiles && filteredTree) {
        const result = await selectAllRecursively(
          filteredTree,
          currentFolderId,
          addMultipleSelectedFiles,
          maxSelectionCount
        );

        // Notify if limit was reached
        if (result.limitReached && onSelectionLimitExceeded) {
          onSelectionLimitExceeded();
        }
        return;
      }

      // Fallback to old behavior: select only displayed files
      const filesToSelect = Array.from(displayedFiles)
        .slice(0, maxSelectionCount)
        .map((path) => encodeFileSelection(currentFolderId, path))
        .filter((v): v is string => typeof v === 'string');

      if (displayedFiles.size > maxSelectionCount && onSelectionLimitExceeded) {
        onSelectionLimitExceeded();
      }
      setSelectedFiles(new Set(filesToSelect));
    }, [
      currentFolderId,
      selectAllRecursively,
      addMultipleSelectedFiles,
      filteredTree,
      maxSelectionCount,
      onSelectionLimitExceeded,
      displayedFiles,
      encodeFileSelection,
      setSelectedFiles,
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

    // Enable button if there are displayed files OR if tree has files (for recursive selection)
    const canSelectFiles = hasDisplayedFiles || hasFilesInTree;

    const getButtonText = () => {
      if (isLoadingForSelectAll) {
        return 'Selecting...';
      }
      if (hasSelectedFiles) {
        return 'Deselect All';
      }
      return 'Select All';
    };

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
      <div className="@container/buttons flex flex-wrap items-center gap-2">
        <Button
          className="flex h-8 items-center gap-1"
          disabled={!(canSelectFiles || isLoadingForSelectAll)}
          onClick={handleClick}
          variant="outline"
        >
          {getButtonText()}
        </Button>
      </div>
    );
  }
);
