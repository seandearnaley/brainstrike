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
import { Download, FileText } from 'lucide-react';
import * as React from 'react';
import { useCallback } from 'react';

export interface ActionButtonsProps {
  displayedFiles: Set<string>;
  selectedFilePaths: Set<string>;
  maxSelectionCount: number;
  currentFolderId: string | null;
  setSelectedFiles: (files: Set<string>) => void;
  encodeFileSelection: (folderId: string, path: string) => string;
  onSelectionLimitExceeded?: () => void;
  onDownloadReport: () => void;
  onCopyReport: () => void;
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
    onDownloadReport,
    onCopyReport,
  }: ActionButtonsProps) => {
    // Handles selecting files up to the max limit
    const handleSelectAll = useCallback(() => {
      if (!currentFolderId) return;
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
      if (hasSelectedFiles) return 'Deselect All';
      if (!hasDisplayedFiles) return 'Select All';
      return canSelectAll ? 'Select All' : `Select ${maxSelectionCount}`;
    };

    return (
      <div className="@container/buttons flex gap-2">
        <Button
          variant="outline"
          onClick={hasSelectedFiles ? handleDeselectAll : handleSelectAll}
          disabled={!hasDisplayedFiles}
          className="flex items-center gap-1 h-8"
        >
          {getButtonText()}
        </Button>
        <Button
          variant="outline"
          onClick={onDownloadReport}
          disabled={!hasSelectedFiles}
          className="flex items-center gap-1 h-8"
          aria-label="Download Report"
        >
          <Download aria-hidden="true" className="size-3.5 hidden @md/buttons:block" />
          <span aria-hidden="true">Download Report</span>
        </Button>
        <Button
          variant="outline"
          onClick={onCopyReport}
          disabled={!hasSelectedFiles}
          className="flex items-center gap-1 h-8"
          aria-label="Copy Report"
        >
          <FileText aria-hidden="true" className="size-3.5 hidden @md/buttons:block" />
          <span aria-hidden="true" className="hidden @sm/buttons:inline">
            Copy Report
          </span>
          <span aria-hidden="true" className="@sm/buttons:hidden">
            Copy
          </span>
        </Button>
      </div>
    );
  }
);
