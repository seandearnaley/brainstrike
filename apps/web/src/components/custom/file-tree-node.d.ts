import type React from 'react';
import { type IFileNode } from '../../lib/file/types';
interface IFileTreeNodeProps {
    node: IFileNode;
    isExpanded: boolean;
    onToggleDirectoryExpansion: (path: string) => void;
    onToggleFileSelection: (path: string) => void;
    isLoading: boolean;
    folderId: string;
}
/**
 * FileTreeNode is a recursive component that renders a single node in the file explorer tree.
 * It handles both files and directories, with special behavior for directory selection.
 *
 * Key behaviors:
 * 1. Files can be individually selected/deselected
 * 2. Directories have a tri-state checkbox (selected/unselected/indeterminate)
 * 3. Directory selection cascades to all child files
 */
declare const FileTreeNode: React.NamedExoticComponent<IFileTreeNodeProps>;
export default FileTreeNode;
//# sourceMappingURL=file-tree-node.d.ts.map