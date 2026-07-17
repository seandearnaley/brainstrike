import type { IFileNode } from '@brainstrike/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import { fileExplorer } from '@brainstrike/utils/file-explorer-utils';
import { useCallback } from 'react';
import { shallow } from 'zustand/shallow';
import { useFileExplorerStoreSelector } from './shell/file-explorer-provider';

interface FolderSelectionDialogProps {
  fileCount: number;
  node: IFileNode;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onToggleFileSelection: (path: string) => void;
  open: boolean;
}

export function FolderSelectionDialog({
  open,
  onOpenChange,
  node,
  fileCount,
  onConfirm,
  onToggleFileSelection,
}: FolderSelectionDialogProps) {
  const { selectedFilePaths, maxSelectionCount } = useFileExplorerStoreSelector(
    (s) => ({
      maxSelectionCount: s.maxSelectionCount,
      selectedFilePaths: s.selectedFilePaths,
    }),
    shallow
  );
  const availableSlots = maxSelectionCount - selectedFilePaths.size;
  const willSelectAll = fileCount <= availableSlots;

  const handleConfirm = useCallback(() => {
    const allFilePaths = fileExplorer.getAllFilePathsInDirectory(node);
    if (allFilePaths.length === 0) {
      onOpenChange(false);
      return;
    }

    // If we have enough slots, select all files
    if (willSelectAll) {
      for (const path of allFilePaths) {
        onToggleFileSelection(path);
      }
    } else {
      // Otherwise, select only up to the available slots
      const pathsToSelect = allFilePaths.slice(0, availableSlots);
      for (const path of pathsToSelect) {
        onToggleFileSelection(path);
      }
    }
    onConfirm();
    onOpenChange(false);
  }, [node, willSelectAll, availableSlots, onToggleFileSelection, onOpenChange, onConfirm]);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Select Folder Contents</DialogTitle>
          <DialogDescription>
            {willSelectAll ? (
              <>
                This will select all {fileCount} files in <code>{node.name}</code>.
                {fileCount > 10 && ' This might take a moment.'}
              </>
            ) : (
              <>
                Only {availableSlots} out of {fileCount} files in <code>{node.name}</code> can be
                selected due to the maximum selection limit of {maxSelectionCount}. The first{' '}
                {availableSlots} files will be selected.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button onClick={handleConfirm}>
            {willSelectAll ? 'Select All' : `Select ${availableSlots} Files`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
