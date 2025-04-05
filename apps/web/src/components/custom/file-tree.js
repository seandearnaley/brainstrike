import { jsx as _jsx } from "react/jsx-runtime";
import { memo, useCallback, useEffect, useMemo } from 'react';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import { encodeFileSelection } from '../../utils/file-selection-utils';
import FileTreeNode from './file-tree-node';
const FileTree = memo(({ fileTree, loadingFiles, onRender, folderId }) => {
    const { expandedDirectoryPaths, toggleDirectoryExpansion, addSelectedFile, removeSelectedFile } = useFileExplorerStore();
    // Use separate useEffect for onRender to avoid lint warnings
    useEffect(() => {
        onRender?.();
    }, [onRender]);
    // Trigger onRender when fileTree changes (for test purposes)
    // We intentionally include fileTree as a dependency for testing purposes
    // biome-ignore lint/correctness/useExhaustiveDependencies: fileTree is needed for test re-renders
    useEffect(() => {
        onRender?.();
    }, [fileTree, onRender]);
    const handleToggleFileSelection = useCallback((path) => {
        const encodedPath = encodeFileSelection(folderId, path);
        const isSelected = useFileExplorerStore.getState().selectedFilePaths.has(encodedPath);
        if (isSelected) {
            removeSelectedFile(folderId, path);
        }
        else {
            addSelectedFile(folderId, path);
        }
    }, [folderId, addSelectedFile, removeSelectedFile]);
    const renderFileTreeNode = useCallback((node) => {
        return (_jsx(FileTreeNode, { node: node, isExpanded: expandedDirectoryPaths.has(node.path), onToggleDirectoryExpansion: toggleDirectoryExpansion, onToggleFileSelection: handleToggleFileSelection, isLoading: loadingFiles.has(node.path), folderId: folderId }, node.path));
    }, [
        expandedDirectoryPaths,
        toggleDirectoryExpansion,
        handleToggleFileSelection,
        loadingFiles,
        folderId,
    ]);
    const renderedTree = useMemo(() => fileTree.map(renderFileTreeNode), [fileTree, renderFileTreeNode]);
    return (_jsx("ul", { className: "file-tree", role: "tree", "aria-label": "File tree", children: renderedTree }));
});
FileTree.displayName = 'FileTree';
export default FileTree;
