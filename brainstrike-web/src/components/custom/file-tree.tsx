import type { IFileNode } from "@/lib/file/types";
import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useFileExplorerStore } from "../../stores/use-file-explorer-store";
import { encodeFileSelection } from "../../utils/file-selection-utils";
import FileTreeNode from "./file-tree-node";

interface IFileTreeProps {
	fileTree: IFileNode[];
	loadingFiles: Set<string>;
	onRender?: () => void;
	folderId: string;
}

const FileTree = memo<IFileTreeProps>(
	({ fileTree, loadingFiles, onRender, folderId }) => {
		const {
			expandedDirectoryPaths,
			toggleDirectoryExpansion,
			addSelectedFile,
			removeSelectedFile,
		} = useFileExplorerStore();

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

		const handleToggleFileSelection = useCallback(
			(path: string) => {
				const encodedPath = encodeFileSelection(folderId, path);
				const isSelected = useFileExplorerStore
					.getState()
					.selectedFilePaths.has(encodedPath);
				if (isSelected) {
					removeSelectedFile(folderId, path);
				} else {
					addSelectedFile(folderId, path);
				}
			},
			[folderId, addSelectedFile, removeSelectedFile],
		);

		const renderFileTreeNode = useCallback(
			(node: IFileNode) => {
				return (
					<FileTreeNode
						key={node.path}
						node={node}
						isExpanded={expandedDirectoryPaths.has(node.path)}
						onToggleDirectoryExpansion={toggleDirectoryExpansion}
						onToggleFileSelection={handleToggleFileSelection}
						isLoading={loadingFiles.has(node.path)}
						folderId={folderId}
					/>
				);
			},
			[
				expandedDirectoryPaths,
				toggleDirectoryExpansion,
				handleToggleFileSelection,
				loadingFiles,
				folderId,
			],
		);

		const renderedTree = useMemo(
			() => fileTree.map(renderFileTreeNode),
			[fileTree, renderFileTreeNode],
		);

		return (
			<ul className="file-tree" role="tree" aria-label="File tree">
				{renderedTree}
			</ul>
		);
	},
);

FileTree.displayName = "FileTree";

export default FileTree;
