import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, } from '../../components/ui/dialog';
import { fileExplorer } from '../../lib/file/explorer';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
export function FolderSelectionDialog({ open, onOpenChange, node, fileCount, onConfirm, onToggleFileSelection, }) {
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
        }
        else {
            // Otherwise, select only up to the available slots
            const pathsToSelect = allFilePaths.slice(0, availableSlots);
            for (const path of pathsToSelect) {
                onToggleFileSelection(path);
            }
        }
        onConfirm();
        onOpenChange(false);
    }, [node, willSelectAll, availableSlots, onToggleFileSelection, onOpenChange, onConfirm]);
    return (_jsx(Dialog, { open: open, onOpenChange: onOpenChange, children: _jsxs(DialogContent, { children: [_jsxs(DialogHeader, { children: [_jsx(DialogTitle, { children: "Select Folder Contents" }), _jsx(DialogDescription, { children: willSelectAll ? (_jsxs(_Fragment, { children: ["This will select all ", fileCount, " files in ", _jsx("code", { children: node.name }), ".", fileCount > 10 && ' This might take a moment.'] })) : (_jsxs(_Fragment, { children: ["Only ", availableSlots, " out of ", fileCount, " files in ", _jsx("code", { children: node.name }), " can be selected due to the maximum selection limit of ", maxSelectionCount, ". The first", ' ', availableSlots, " files will be selected."] })) })] }), _jsxs(DialogFooter, { children: [_jsx(Button, { variant: "outline", onClick: () => onOpenChange(false), children: "Cancel" }), _jsx(Button, { onClick: handleConfirm, children: willSelectAll ? 'Select All' : `Select ${availableSlots} Files` })] })] }) }));
}
