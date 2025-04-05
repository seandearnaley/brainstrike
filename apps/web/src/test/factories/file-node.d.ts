import type { IFileNode, SelectionState } from '@/lib/file/types';
interface BaseNodeOptions {
    name: string;
    path: string;
    depth?: number;
    selectionState?: SelectionState;
    rootFolderId?: string;
    isVisible?: boolean;
    children?: IFileNode[];
    handle?: FileSystemFileHandle | FileSystemDirectoryHandle;
}
export declare function createFileNode({ name, path, depth, selectionState, rootFolderId, isVisible, handle, }?: Partial<BaseNodeOptions>): IFileNode;
export declare function createDirectoryNode({ name, path, depth, selectionState, rootFolderId, isVisible, children, }?: Partial<BaseNodeOptions>): IFileNode;
/**
 * Creates a nested directory structure for testing
 */
export declare function createNestedDirectoryStructure(basePath?: string, depth?: number, filesPerLevel?: number): IFileNode;
/**
 * Creates a file tree structure from a simple object representation
 */
export declare function createFileTreeFromStructure(structure: Record<string, unknown>, parentPath?: string, depth?: number): IFileNode[];
export {};
//# sourceMappingURL=file-node.d.ts.map