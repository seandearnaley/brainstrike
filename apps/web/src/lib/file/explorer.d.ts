import type { IFileNode } from './types';
/**
 * Utilities for exploring and manipulating file trees
 */
export declare const fileExplorer: {
    /**
     * Checks if a path should be ignored based on predefined patterns
     */
    shouldIgnorePath(path: string): boolean;
    /**
     * Gets all file paths in a directory recursively
     */
    getAllFilePathsInDirectory(node: IFileNode): string[];
    /**
     * Finds a node in the file tree by its path and optionally root folder ID
     */
    findNodeByPath(roots: IFileNode[], path: string, rootFolderId?: string): IFileNode | null;
    /**
     * Gets the extension of a file
     */
    getFileExtension(filePath: string): string;
    /**
     * Counts files in a directory node
     */
    getFolderFileCount(node: IFileNode): {
        count: number;
        isComplete: boolean;
    };
    /**
     * Generates a text representation of the folder tree
     */
    generateFullFolderTreeText(fileTree: IFileNode[], includeFilters: string[], excludeFilters: string[], useRegex: boolean): string;
    /**
     * Reads the full file tree recursively from a directory handle
     */
    readFullFileTree(directoryHandle: FileSystemDirectoryHandle, parentPath?: string, depth?: number, rootFolderId?: string): Promise<IFileNode[]>;
};
//# sourceMappingURL=explorer.d.ts.map