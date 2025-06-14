/**
 * Database-aware file system adapter that integrates with FolderService
 * for database-first file loading.
 */

import type { FolderService } from '@brainstrike/file-cache';
import type { IFileNode } from '@brainstrike/types';
import type { DirectoryHandle, FileHandle, FileSystemAdapter } from './types';

export interface DatabaseAwareFileSystemAdapter extends FileSystemAdapter {
  /**
   * Set the folder service for database operations
   */
  setFolderService(folderService: FolderService): void;

  /**
   * Get current folder service instance
   */
  getFolderService(): FolderService | null;

  /**
   * Request directory access and optionally populate database
   */
  requestDirectoryAccess(options?: {
    populateDatabase?: boolean;
    onProgress?: (loaded: number, total: number) => void;
  }): Promise<DirectoryHandle>;

  /**
   * Read directory from database if available, fallback to file system
   */
  readDirectoryFromDatabase(folderId: string): Promise<IFileNode[] | null>;

  /**
   * Read file from database if available, fallback to file system
   */
  readFileFromDatabase(folderId: string, filePath: string): Promise<string | null>;

  /**
   * Check if folder is populated in database
   */
  isFolderPopulated(folderId: string): Promise<boolean>;

  /**
   * Get current database mode setting
   */
  isDatabaseMode(): boolean;

  /**
   * Set database mode on/off
   */
  setDatabaseMode(enabled: boolean): void;
}

/**
 * Base implementation of database-aware adapter
 */
export abstract class BaseDatabaseAwareAdapter implements DatabaseAwareFileSystemAdapter {
  protected folderService: FolderService | null = null;
  protected databaseMode = true; // Default to database-first mode

  setFolderService(folderService: FolderService): void {
    this.folderService = folderService;
  }

  getFolderService(): FolderService | null {
    return this.folderService;
  }

  isDatabaseMode(): boolean {
    return this.databaseMode;
  }

  setDatabaseMode(enabled: boolean): void {
    this.databaseMode = enabled;
  }

  async readDirectoryFromDatabase(folderId: string): Promise<IFileNode[] | null> {
    if (!this.folderService || !this.databaseMode) {
      return null;
    }

    try {
      const fileTree = await this.folderService.getFileTree(folderId);
      if (fileTree.length === 0) {
        return null;
      }

      // Convert FileTreeNode to IFileNode
      type TreeNode = {
        name: string;
        path: string;
        type: 'file' | 'directory';
        children?: TreeNode[] | undefined;
        fileType?: string | undefined;
        fileSize?: number | undefined;
        lastModified?: Date | undefined;
      };

      const convertToIFileNode = (node: TreeNode, depth = 0): IFileNode => {
        const iFileNode: IFileNode = {
          name: node.name,
          path: node.path,
          type: node.type,
          depth,
          selectionState: 'unchecked',
          rootFolderId: folderId,
          isVisible: true,
          handle: null as unknown as FileSystemFileHandle | FileSystemDirectoryHandle, // Database entries don't have handles
        };

        if (node.type === 'directory') {
          iFileNode.children =
            node.children?.map((child) => convertToIFileNode(child, depth + 1)) || [];
        } else {
          if (node.fileSize !== undefined) iFileNode.size = node.fileSize;
          if (node.lastModified) iFileNode.lastModified = new Date(node.lastModified).getTime();
        }

        return iFileNode;
      };

      return fileTree.map((node) => convertToIFileNode(node as TreeNode));
    } catch (error) {
      console.error('Failed to read directory from database:', error);
      return null;
    }
  }

  async readFileFromDatabase(folderId: string, filePath: string): Promise<string | null> {
    if (!this.folderService || !this.databaseMode) {
      return null;
    }

    try {
      const content = await this.folderService.getFileContent(folderId, filePath);
      return content;
    } catch (error) {
      console.error('Failed to read file from database:', error);
      return null;
    }
  }

  async isFolderPopulated(folderId: string): Promise<boolean> {
    if (!this.folderService) {
      return false;
    }

    try {
      const folders = await this.folderService.getFolders();
      return folders.some((f) => f.folderId === folderId);
    } catch (error) {
      console.error('Failed to check folder population status:', error);
      return false;
    }
  }

  // Abstract methods to be implemented by platform-specific adapters
  abstract requestDirectoryAccess(options?: {
    populateDatabase?: boolean;
    onProgress?: (loaded: number, total: number) => void;
  }): Promise<DirectoryHandle>;

  abstract readDirectory(handle: DirectoryHandle): Promise<IFileNode[]>;
  abstract readFile(handle: FileHandle): Promise<string>;
  abstract exists(path: string): Promise<boolean>;
}
