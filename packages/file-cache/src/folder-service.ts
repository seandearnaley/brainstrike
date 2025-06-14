import type { FileCacheService } from './cache-service';
import type { BulkFileEntry, FolderInfo } from './types';

// Type declarations for File System Access API
declare global {
  interface FileSystemDirectoryHandle extends FileSystemHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    readonly kind: 'directory';
    readonly name: string;
  }

  interface FileSystemFileHandle extends FileSystemHandle {
    getFile(): Promise<File>;
    readonly kind: 'file';
    readonly name: string;
  }

  interface FileSystemHandle {
    readonly kind: 'file' | 'directory';
    readonly name: string;
  }
}

/**
 * High-level folder management service
 *
 * Provides workspace-oriented operations for managing folders and their files
 * using the underlying FileCacheService database. This service handles:
 * - Folder registration and lifecycle
 * - Bulk file population from directory handles
 * - Workspace switching and management
 * - File discovery and filtering
 */
export class FolderService {
  private cache: FileCacheService;

  constructor(cache: FileCacheService) {
    this.cache = cache;
  }

  /**
   * Open a folder and populate the database with its contents
   * Returns the folder ID for this workspace
   */
  async openFolder(
    directoryHandle: FileSystemDirectoryHandle,
    options?: {
      maxDepth?: number;
      maxFileSize?: number;
      includeHidden?: boolean;
      fileFilter?: (fileName: string) => boolean;
      onProgress?: (loaded: number, total: number) => void;
    }
  ): Promise<string> {
    const folderId = this.generateFolderId(directoryHandle.name);
    const folderName = directoryHandle.name;

    // Register the folder
    await this.cache.registerFolder(folderId, folderName);

    // Clear any existing content for this folder
    await this.cache.clearFolder(folderId);

    // Discover all files in the directory
    const fileEntries = await this.discoverFiles(directoryHandle, folderId, options);

    if (fileEntries.length === 0) {
      console.warn('No files found in folder:', folderName);
      return folderId;
    }

    // Populate database with all discovered files
    await this.cache.saveBulkFileContents(fileEntries, options?.onProgress);

    // Update folder access time
    await this.cache.updateFolderAccess(folderId);

    return folderId;
  }

  /**
   * Get information about the currently available folders/workspaces
   */
  async getFolders(): Promise<FolderInfo[]> {
    return this.cache.getFolderInfo();
  }

  /**
   * Switch to a different folder/workspace
   */
  async switchToFolder(folderId: string): Promise<boolean> {
    const folders = await this.getFolders();
    const folder = folders.find((f) => f.folderId === folderId);

    if (!folder) {
      return false;
    }

    // Update access time
    await this.cache.updateFolderAccess(folderId);
    return true;
  }

  /**
   * Get the most recently accessed folder
   */
  async getCurrentFolder(): Promise<FolderInfo | null> {
    const folders = await this.getFolders();
    return folders.length > 0 ? (folders[0] ?? null) : null; // Already sorted by last_accessed DESC
  }

  /**
   * Delete a folder and all its cached files
   */
  async deleteFolder(folderId: string): Promise<void> {
    await this.cache.deleteFolder(folderId);
  }

  /**
   * Get file tree structure from database for a folder
   */
  async getFileTree(folderId: string): Promise<FileTreeNode[]> {
    const files = await this.cache.getFolderContents(folderId);

    // Convert flat file list to tree structure
    return this.buildFileTree(files);
  }

  /**
   * Get file content from the database
   */
  async getFileContent(filePath: string, folderId?: string): Promise<string | null> {
    return this.cache.getFileContent(filePath, folderId);
  }

  /**
   * Check if a folder has any files cached
   */
  async isFolderPopulated(folderId: string): Promise<boolean> {
    const contents = await this.cache.getFolderContents(folderId);
    return contents.length > 0;
  }

  /**
   * Refresh folder contents by re-reading from file system
   * Note: Requires the original directory handle to be available
   */
  async refreshFolder(
    folderId: string,
    directoryHandle: FileSystemDirectoryHandle,
    options?: {
      maxDepth?: number;
      maxFileSize?: number;
      includeHidden?: boolean;
      fileFilter?: (fileName: string) => boolean;
      onProgress?: (loaded: number, total: number) => void;
    }
  ): Promise<void> {
    // Clear existing content
    await this.cache.clearFolder(folderId);

    // Re-discover and populate
    const fileEntries = await this.discoverFiles(directoryHandle, folderId, options);
    await this.cache.saveBulkFileContents(fileEntries, options?.onProgress);

    // Update access time
    await this.cache.updateFolderAccess(folderId);
  }

  /**
   * Generate a consistent folder ID from folder name
   */
  private generateFolderId(folderName: string): string {
    // Use folder name with timestamp for uniqueness
    // In production, you might want to use a more sophisticated approach
    const timestamp = Date.now();
    const sanitized = folderName.replace(/[^a-zA-Z0-9-_]/g, '_');
    return `${sanitized}_${timestamp}`;
  }

  /**
   * Recursively discover all files in a directory
   */
  private async discoverFiles(
    directoryHandle: FileSystemDirectoryHandle,
    folderId: string,
    options?: {
      maxDepth?: number;
      maxFileSize?: number;
      includeHidden?: boolean;
      fileFilter?: (fileName: string) => boolean;
    },
    currentPath = '',
    currentDepth = 0
  ): Promise<BulkFileEntry[]> {
    const entries: BulkFileEntry[] = [];
    const maxDepth = options?.maxDepth ?? 10;
    const maxFileSize = options?.maxFileSize ?? 5 * 1024 * 1024; // 5MB default
    const includeHidden = options?.includeHidden ?? false;
    const fileFilter = options?.fileFilter ?? (() => true);

    if (currentDepth > maxDepth) {
      return entries;
    }

    try {
      for await (const [name, handle] of (directoryHandle as FileSystemDirectoryHandle).entries()) {
        // Skip hidden files unless explicitly included
        if (!includeHidden && name.startsWith('.')) {
          continue;
        }

        const fullPath = currentPath ? `${currentPath}/${name}` : name;

        if (handle.kind === 'file') {
          // Apply file filter
          if (!fileFilter(name)) {
            continue;
          }

          try {
            const file = await (handle as FileSystemFileHandle).getFile();

            // Skip files that are too large
            if (file.size > maxFileSize) {
              console.warn(`Skipping large file: ${fullPath} (${file.size} bytes)`);
              continue;
            }

            // Only process text files
            if (this.isTextFile(name, file.type)) {
              const content = await file.text();

              entries.push({
                path: fullPath,
                content,
                folderId,
                fileType: this.getFileType(name),
                fileSize: file.size,
              });
            }
          } catch (error) {
            console.warn(`Error reading file ${fullPath}:`, error);
          }
        } else if (handle.kind === 'directory') {
          // Recursively process subdirectories
          const subEntries = await this.discoverFiles(
            handle as FileSystemDirectoryHandle,
            folderId,
            options,
            fullPath,
            currentDepth + 1
          );
          entries.push(...subEntries);
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${currentPath}:`, error);
    }

    return entries;
  }

  /**
   * Check if a file should be treated as text
   */
  private isTextFile(fileName: string, mimeType?: string): boolean {
    // Check by extension
    const textExtensions = [
      '.txt',
      '.md',
      '.json',
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.css',
      '.scss',
      '.html',
      '.htm',
      '.xml',
      '.yaml',
      '.yml',
      '.toml',
      '.ini',
      '.conf',
      '.py',
      '.java',
      '.c',
      '.cpp',
      '.h',
      '.hpp',
      '.cs',
      '.php',
      '.rb',
      '.go',
      '.rs',
      '.swift',
      '.kt',
      '.scala',
      '.clj',
      '.sh',
      '.bash',
      '.sql',
      '.graphql',
      '.vue',
      '.svelte',
      '.astro',
      '.mjs',
      '.cjs',
    ];

    const extension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    if (textExtensions.includes(extension)) {
      return true;
    }

    // Check by MIME type
    if (mimeType) {
      return (
        mimeType.startsWith('text/') ||
        mimeType === 'application/json' ||
        mimeType === 'application/javascript' ||
        mimeType === 'application/typescript'
      );
    }

    return false;
  }

  /**
   * Determine file type category from filename
   */
  private getFileType(fileName: string): string {
    const extension = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));

    const typeMap: Record<string, string> = {
      '.js': 'javascript',
      '.ts': 'typescript',
      '.jsx': 'javascript',
      '.tsx': 'typescript',
      '.json': 'json',
      '.md': 'markdown',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'css',
      '.py': 'python',
      '.java': 'java',
      '.c': 'c',
      '.cpp': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.php': 'php',
      '.rb': 'ruby',
      '.go': 'go',
      '.rs': 'rust',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.sql': 'sql',
      '.xml': 'xml',
      '.yaml': 'yaml',
      '.yml': 'yaml',
      '.toml': 'toml',
      '.sh': 'shell',
      '.bash': 'shell',
    };

    return typeMap[extension] || 'text';
  }

  /**
   * Build a tree structure from flat file list
   */
  private buildFileTree(
    files: Array<{
      path: string;
      fileType: string;
      fileSize: number;
      lastModified: Date;
    }>
  ): FileTreeNode[] {
    const root: Map<string, FileTreeNodeInternal> = new Map();

    for (const file of files) {
      const parts = file.path.split('/');
      let currentLevel = root;
      let currentPath = '';

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue; // Skip empty parts from leading/trailing slashes

        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const isFile = i === parts.length - 1;

        if (!currentLevel.has(part)) {
          const node: FileTreeNodeInternal = {
            name: part,
            path: currentPath,
            type: isFile ? 'file' : 'directory',
          };

          if (isFile) {
            node.fileType = file.fileType;
            node.fileSize = file.fileSize;
            node.lastModified = file.lastModified;
          } else {
            node.children = new Map();
          }

          currentLevel.set(part, node);
        }

        if (!isFile) {
          const node = currentLevel.get(part);
          if (node?.children) {
            currentLevel = node.children;
          }
        }
      }
    }

    // Convert Map to array and sort
    return this.mapToSortedArray(root);
  }

  /**
   * Helper to convert Map to sorted array recursively
   */
  private mapToSortedArray(map: Map<string, FileTreeNodeInternal>): FileTreeNode[] {
    return Array.from(map.values())
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .map((node) => ({
        name: node.name,
        path: node.path,
        type: node.type,
        children: node.children ? this.mapToSortedArray(node.children) : undefined,
        fileType: node.fileType,
        fileSize: node.fileSize,
        lastModified: node.lastModified,
      }));
  }
}

/**
 * Internal file tree node structure for building
 */
interface FileTreeNodeInternal {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: Map<string, FileTreeNodeInternal>;
  fileType?: string;
  fileSize?: number;
  lastModified?: Date;
}

/**
 * File tree node structure
 */
export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[] | undefined;
  fileType?: string | undefined;
  fileSize?: number | undefined;
  lastModified?: Date | undefined;
}
