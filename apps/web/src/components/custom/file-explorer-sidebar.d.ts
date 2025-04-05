import type { IFileNode } from '@/lib/file/types';
import type React from 'react';
interface FileExplorerSidebarProps {
    rootDirectoryHandle: FileSystemDirectoryHandle | null;
    treeError: Error | null;
    filterError: Error | null;
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    quickFilter: string;
    quickFilteredTree: IFileNode[] | null;
    loadingFiles: Set<string>;
    isLoading: boolean;
    isInitialLoad: boolean;
    currentFolderId: string | null;
    onTreeRender?: () => void;
}
declare const FileExplorerSidebar: React.FC<FileExplorerSidebarProps>;
export default FileExplorerSidebar;
//# sourceMappingURL=file-explorer-sidebar.d.ts.map