import { useFileExplorerStore } from '@brainstrike/file-explorer';
import type { IFileNode } from '@brainstrike/types';
import { Button } from '@brainstrike/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import { useCallback } from 'react';
import { fileExplorer } from './lib/file/explorer';

interface FolderSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: IFileNode;
  fileCount: number;
  onConfirm: () => void;
  onToggleFileSelection: (path: string) => void;
}

export function FolderSelectionDialog({
  open,
  onOpenChange,
  node,
  fileCount,
  onConfirm,
  onToggleFileSelection,
}: FolderSelectionDialogProps) {
  const { selectedFilePaths, maxSelectionCount } = useFileExplorerStore();
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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
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
