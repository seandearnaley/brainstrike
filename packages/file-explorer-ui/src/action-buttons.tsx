/**
 * ActionButtons Component
 *
 * Provides controls for bulk file selection operations in the file explorer.
 * The component implements a smart "Select All" functionality that respects
 * the maximum selection limit while maintaining a good user experience.
 *
 * Key behaviors:
 * 1. When files are within max limit: Allows selecting all files at once
 * 2. When files exceed max limit: Allows selecting up to the max limit
 * 3. When files are selected: Provides option to deselect all files
 *
 * The button text dynamically updates to indicate:
 * - "Select All" when no files are selected and all can be selected
 * - "Select N" when files exceed the max limit (N = max limit)
 * - "Deselect All" when files are currently selected
 */

import { Button } from '@brainstrike/ui';
import * as React from 'react';
import { useCallback } from 'react';

export type ActionButtonsProps = {
  displayedFiles: Set<string>;
  selectedFilePaths: Set<string>;
  maxSelectionCount: number;
  currentFolderId: string | null;
  setSelectedFiles: (files: Set<string>) => void;
  encodeFileSelection: (folderId: string, path: string) => string;
  onSelectionLimitExceeded?: () => void;
};

export const ActionButtons = React.memo(
  ({
    displayedFiles,
    selectedFilePaths,
    maxSelectionCount,
    currentFolderId,
    setSelectedFiles,
    encodeFileSelection,
    onSelectionLimitExceeded,
  }: ActionButtonsProps) => {
    // Handles selecting files up to the max limit
    const handleSelectAll = useCallback(() => {
      if (!currentFolderId) {
        return;
      }
      const filesToSelect = Array.from(displayedFiles)
        .slice(0, maxSelectionCount)
        .map((path) => encodeFileSelection(currentFolderId, path))
        .filter((v): v is string => typeof v === 'string'); // Guard: only strings
      if (displayedFiles.size > maxSelectionCount && onSelectionLimitExceeded) {
        onSelectionLimitExceeded();
      }
      setSelectedFiles(new Set(filesToSelect));
    }, [
      displayedFiles,
      setSelectedFiles,
      maxSelectionCount,
      currentFolderId,
      encodeFileSelection,
      onSelectionLimitExceeded,
    ]);

    // Clears all selected files
    const handleDeselectAll = useCallback(() => {
      setSelectedFiles(new Set());
    }, [setSelectedFiles]);

    const hasDisplayedFiles = displayedFiles.size > 0;
    const hasSelectedFiles = selectedFilePaths.size > 0;
    const canSelectAll = displayedFiles.size <= maxSelectionCount;

    const getButtonText = () => {
      if (hasSelectedFiles) {
        return 'Deselect All';
      }
      if (!hasDisplayedFiles) {
        return 'Select All';
      }
      return canSelectAll ? 'Select All' : `Select ${maxSelectionCount}`;
    };

    return (
      <div className="@container/buttons flex flex-wrap items-center gap-2">
        <Button
          className="flex h-8 items-center gap-1"
          disabled={!hasDisplayedFiles}
          onClick={hasSelectedFiles ? handleDeselectAll : handleSelectAll}
          variant="outline"
        >
          {getButtonText()}
        </Button>
      </div>
    );
  }
);
