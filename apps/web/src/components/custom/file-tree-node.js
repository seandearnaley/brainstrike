import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen, Loader2, } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { Checkbox } from '../../components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from '../../components/ui/tooltip';
import { fileExplorer } from '../../lib/file/explorer';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import { isPathSelectedInFolder } from '../../utils/file-selection-utils';
import { FolderSelectionDialog } from './folder-selection-dialog';
/**
 * FileTreeNode is a recursive component that renders a single node in the file explorer tree.
 * It handles both files and directories, with special behavior for directory selection.
 *
 * Key behaviors:
 * 1. Files can be individually selected/deselected
 * 2. Directories have a tri-state checkbox (selected/unselected/indeterminate)
 * 3. Directory selection cascades to all child files
 */
const FileTreeNode = memo(({ node, isExpanded, onToggleDirectoryExpansion, onToggleFileSelection, isLoading, folderId, }) => {
    const { selectedFilePaths, expandedDirectoryPaths, maxSelectionCount } = useFileExplorerStore();
    const [showSelectionDialog, setShowSelectionDialog] = useState(false);
    /**
     * Gets all file paths in a directory node, including nested directories
     */
    const getAllFilePaths = useCallback((dirNode) => {
        if (dirNode.type !== 'directory')
            return [];
        return (dirNode.children?.reduce((paths, child) => {
            if (child.type === 'file') {
                paths.push(child.path);
            }
            else if (child.type === 'directory') {
                paths.push(...getAllFilePaths(child));
            }
            return paths;
        }, []) ?? []);
    }, []);
    /**
     * Handles checkbox selection for both files and directories.
     * For directories, shows a confirmation dialog if the folder contains many files.
     */
    const handleNodeSelection = useCallback(() => {
        if (node.type !== 'directory') {
            onToggleFileSelection(node.path);
            return;
        }
        // Get all file paths in the directory
        const allFilePaths = getAllFilePaths(node);
        if (allFilePaths.length === 0)
            return; // Don't process empty directories
        // For directories, check if we need to show the dialog
        const { count } = fileExplorer.getFolderFileCount(node);
        const selectedCount = allFilePaths.filter((path) => isPathSelectedInFolder(selectedFilePaths, folderId, path)).length;
        const isFullySelected = selectedCount === allFilePaths.length;
        // Only show the confirmation modal for large folders when no files are selected (i.e. on a select-all action)
        if (count > 10 && selectedCount === 0) {
            setShowSelectionDialog(true);
            return;
        }
        if (!isFullySelected) {
            // For folders that are not fully selected (including intermediate state), complete the selection by selecting all unselected files
            const unselectedPaths = allFilePaths.filter((path) => !isPathSelectedInFolder(selectedFilePaths, folderId, path));
            const availableSlots = maxSelectionCount - selectedFilePaths.size;
            const pathsToSelect = unselectedPaths.slice(0, availableSlots);
            for (const path of pathsToSelect) {
                onToggleFileSelection(path);
            }
        }
        else {
            // If fully selected, toggle to deselect all files
            for (const path of allFilePaths) {
                onToggleFileSelection(path);
            }
        }
    }, [
        node,
        selectedFilePaths,
        onToggleFileSelection,
        maxSelectionCount,
        getAllFilePaths,
        folderId,
    ]);
    /**
     * Handles directory expansion/collapse when clicking the chevron icon.
     * Prevents event propagation to avoid triggering selection.
     */
    const handleExpansionClick = useCallback((e) => {
        e.stopPropagation();
        onToggleDirectoryExpansion(node.path);
    }, [node.path, onToggleDirectoryExpansion]);
    /**
     * Determines the appropriate icon to display based on node type and state.
     * - Files: Show file icon
     * - Directories: Show folder/folder-open based on expansion state
     * - Loading state: Show spinner
     */
    const renderIcon = useCallback(() => {
        if (isLoading) {
            return (_jsx(Loader2, { size: 16, className: "text-blue-500 dark:text-blue-400 animate-spin", "aria-label": `Loading ${node.name}` }));
        }
        if (node.type === 'file') {
            return _jsx(FileIcon, { size: 16, className: "text-gray-500 dark:text-gray-400" });
        }
        if (node.type === 'directory') {
            return isExpanded ? (_jsx(FolderOpen, { size: 16, className: "text-blue-500 dark:text-blue-400" })) : (_jsx(Folder, { size: 16, className: "text-blue-500 dark:text-blue-400" }));
        }
        return null;
    }, [node.type, node.name, isExpanded, isLoading]);
    /**
     * Computes the checkbox state for the node.
     *
     * For files:
     * - Returns true if file is selected, false otherwise
     *
     * For directories:
     * - Returns true if all child files are selected
     * - Returns false if no child files are selected
     * - Returns 'indeterminate' if some (but not all) child files are selected
     */
    const checkboxState = useMemo(() => {
        if (node.type === 'file') {
            return isPathSelectedInFolder(selectedFilePaths, folderId, node.path);
        }
        const allFilePaths = getAllFilePaths(node);
        if (allFilePaths.length === 0) {
            return false;
        }
        const selectedCount = allFilePaths.filter((path) => isPathSelectedInFolder(selectedFilePaths, folderId, path)).length;
        if (selectedCount === 0) {
            return false;
        }
        return selectedCount === allFilePaths.length ? true : 'indeterminate';
    }, [node, selectedFilePaths, getAllFilePaths, folderId]);
    /**
     * Calculate folder file count and selection status for tooltips
     */
    const folderInfo = useMemo(() => {
        if (node.type !== 'directory')
            return null;
        const { count, isComplete } = fileExplorer.getFolderFileCount(node);
        const selectedCount = getAllFilePaths(node).filter((path) => isPathSelectedInFolder(selectedFilePaths, folderId, path)).length;
        return { count, isComplete, selectedCount };
    }, [node, selectedFilePaths, getAllFilePaths, folderId]);
    /**
     * Check if selecting this node would exceed the max selection limit
     */
    const wouldExceedLimit = useMemo(() => {
        if (node.type === 'file') {
            return (!isPathSelectedInFolder(selectedFilePaths, folderId, node.path) &&
                selectedFilePaths.size >= maxSelectionCount);
        }
        if (!folderInfo)
            return false;
        const unselectedCount = folderInfo.count - folderInfo.selectedCount;
        return selectedFilePaths.size + unselectedCount > maxSelectionCount;
    }, [node, selectedFilePaths, maxSelectionCount, folderInfo, folderId]);
    return (_jsxs("li", { className: "list-none", children: [_jsxs("div", { className: "flex items-center p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors", children: [_jsx(TooltipProvider, { children: _jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { asChild: true, children: _jsx("div", { className: "flex items-center", children: _jsx(Checkbox, { id: node.path, checked: checkboxState, disabled: wouldExceedLimit, className: "mr-2", onClick: (e) => {
                                                e.stopPropagation();
                                                if (!wouldExceedLimit) {
                                                    handleNodeSelection();
                                                }
                                            }, "aria-label": `Select ${node.name}` }) }) }), wouldExceedLimit && (_jsx(TooltipContent, { children: _jsxs("p", { children: ["Cannot select more than ", maxSelectionCount, " files"] }) }))] }) }), node.type === 'directory' && (_jsx("button", { type: "button", onClick: handleExpansionClick, className: "p-1 mr-1", "aria-label": `${isExpanded ? 'Collapse' : 'Expand'} ${node.name} directory`, children: isExpanded ? (_jsx(ChevronDown, { className: "h-3 w-3" })) : (_jsx(ChevronRight, { className: "h-3 w-3" })) })), renderIcon(), _jsx("span", { className: "ml-1", children: node.name })] }), node.type === 'directory' && isExpanded && node.children && (_jsx("fieldset", { className: "ml-6", "aria-label": `Contents of ${node.name}`, children: node.children
                    .filter((childNode) => childNode.isVisible !== false)
                    .map((childNode) => (_jsx(FileTreeNode, { node: childNode, isExpanded: expandedDirectoryPaths.has(childNode.path), onToggleDirectoryExpansion: onToggleDirectoryExpansion, onToggleFileSelection: onToggleFileSelection, isLoading: isLoading, folderId: folderId }, childNode.path))) })), _jsx(FolderSelectionDialog, { open: showSelectionDialog, onOpenChange: setShowSelectionDialog, node: node, fileCount: folderInfo?.count ?? 0, onConfirm: handleNodeSelection, onToggleFileSelection: onToggleFileSelection })] }));
});
FileTreeNode.displayName = 'FileTreeNode';
export default FileTreeNode;
