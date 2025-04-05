import type { IFileNode } from './types';
/**
 * Core file system operations and utilities
 */
export declare const fileSystem: {
    /**
     * Checks if two directory handles point to the same folder
     * Uses multiple strategies to handle various edge cases and API availability
     */
    isSameDirectory(handle1: FileSystemDirectoryHandle, handle2: FileSystemDirectoryHandle): Promise<boolean>;
    /**
     * Gets the full path of a directory handle by traversing parents
     */
    getFullPath(handle: FileSystemDirectoryHandle): Promise<string>;
    /**
     * Generates a unique folder ID that takes into account the full path
     * to avoid collisions between folders with the same name but different paths.
     * Falls back to simpler strategies if advanced features are not available.
     */
    generateUniqueFolderId(handle: FileSystemDirectoryHandle): Promise<string>;
    /**
     * Read the content of a file handle as text
     */
    readFileContent(fileHandle: FileSystemFileHandle): Promise<string>;
    /**
     * Creates a file node from a file system handle
     */
    createFileNode(handle: FileSystemHandle, parentPath?: string, rootHandle?: FileSystemDirectoryHandle): Promise<IFileNode>;
};
//# sourceMappingURL=system.d.ts.map