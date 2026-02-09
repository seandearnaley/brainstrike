import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { IFileNode } from '@brainstrike/types';
import { AccessError, DialogError, PermissionError, UserCancelledError } from '../errors';
import {
  createMetadataCache,
  type MetadataCache,
  type MetadataCacheConfig,
  type MetadataCacheStats,
} from '../metadata-cache';
import { resolveValidatedPath } from '../path-validation';
import type {
  DirectoryHandle,
  DirectoryReadOptions,
  DirectoryStreamCallback,
  FileHandle,
  FileSystemAdapter,
  FileSystemChange,
  StreamingDirectoryReadOptions,
} from '../types';
import { normalizeDirectoryReadOptions, validateDirectoryPath } from '../utils';
import { handleWatcherSetupError, startChokidarWatch } from './electron-watchers';

/** Default batch size for streaming directory reads */
const DEFAULT_STREAMING_BATCH_SIZE = 50;
type FsDirent = import('fs').Dirent;

/**
 * File system adapter for Electron applications
 *
 * This adapter provides file system access using Node.js APIs within the Electron main process.
 * It handles directory selection via Electron's dialog API and file operations using Node.js fs module.
 *
 * Key features:
 * - Proper error handling with custom error types
 * - User cancellation detection
 * - Permission and access validation
 * - File watching capabilities
 * - Optional metadata caching (BST-146) to avoid redundant stat() calls
 * - Streaming directory enumeration (BST-147) for progressive loading
 */

/** Configuration options for ElectronFileSystemAdapter */
export interface ElectronAdapterOptions {
  /**
   * Enable metadata caching to reduce filesystem I/O.
   * When true, uses default cache settings.
   * Pass a MetadataCacheConfig object for custom settings.
   */
  cache?: boolean | MetadataCacheConfig;
}

// Helpers to build nodes
function toDirectoryNode(root: DirectoryHandle, entryName: string, fullPath: string): IFileNode {
  return {
    name: entryName,
    path: fullPath,
    type: 'directory',
    depth: 0,
    selectionState: 'unchecked',
    children: [],
    rootFolderId: root.name,
    isVisible: true,
    handle: {
      path: fullPath,
      name: entryName,
      kind: 'directory',
      platform: 'electron',
    } as unknown as FileSystemDirectoryHandle,
  };
}

function toBasicFileNode(root: DirectoryHandle, entryName: string, fullPath: string): IFileNode {
  return {
    name: entryName,
    path: fullPath,
    type: 'file',
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: root.name,
    isVisible: true,
    handle: {
      path: fullPath,
      name: entryName,
      kind: 'file',
      platform: 'electron',
    } as unknown as FileSystemFileHandle,
  };
}

function toFileNodeWithMetadata(
  root: DirectoryHandle,
  fullPath: string,
  entryName: string,
  size: number,
  mtimeMs: number
): IFileNode {
  return {
    name: entryName,
    path: fullPath,
    type: 'file',
    depth: 0,
    selectionState: 'unchecked',
    rootFolderId: root.name,
    isVisible: true,
    size,
    lastModified: mtimeMs,
    handle: {
      path: fullPath,
      name: entryName,
      kind: 'file',
      platform: 'electron',
    } as unknown as FileSystemFileHandle,
  };
}

/**
 * Emit the final batch when streaming is complete.
 * Helper to reduce complexity in readDirectoryStreaming.
 */
function emitFinalBatch(batch: IFileNode[], total: number, onBatch: DirectoryStreamCallback): void {
  if (batch.length > 0 || total === 0) {
    onBatch(batch, { done: true, total });
  } else {
    // Signal completion with empty batch if last batch was exactly full
    onBatch([], { done: true, total });
  }
}

function isStreamingAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

async function buildStreamingNodes(
  dirents: FsDirent[],
  shouldAbort: () => boolean,
  buildNode: (dirent: FsDirent) => Promise<IFileNode>
): Promise<IFileNode[]> {
  const work: Promise<IFileNode>[] = [];
  for (const dirent of dirents) {
    if (shouldAbort()) {
      break;
    }
    work.push(buildNode(dirent));
  }
  return Promise.all(work);
}

function emitIntermediateBatch(
  nodes: IFileNode[],
  total: number,
  onBatch: DirectoryStreamCallback
): number {
  if (nodes.length === 0) {
    return total;
  }
  const nextTotal = total + nodes.length;
  onBatch(nodes, { done: false, total: nextTotal });
  return nextTotal;
}

/**
 * Create a file node with optional metadata lookup.
 * Helper to reduce complexity in readDirectoryStreaming.
 */
async function createStreamingFileNode(
  root: DirectoryHandle,
  fullPath: string,
  entryName: string,
  includeMetadata: boolean,
  getFileMetadata: (path: string) => Promise<{ size: number; mtimeMs: number } | null>
): Promise<IFileNode> {
  if (!includeMetadata) {
    return toBasicFileNode(root, entryName, fullPath);
  }

  const metadata = await getFileMetadata(fullPath);
  if (metadata) {
    return toFileNodeWithMetadata(root, fullPath, entryName, metadata.size, metadata.mtimeMs);
  }
  return toBasicFileNode(root, entryName, fullPath);
}

export class ElectronFileSystemAdapter implements FileSystemAdapter {
  public readonly platform = 'electron' as const;
  private readonly metadataCache: MetadataCache | null;

  /**
   * Creates a new ElectronFileSystemAdapter.
   *
   * @param options - Optional configuration for the adapter
   * @example
   * ```ts
   * // Without caching (default)
   * const adapter = new ElectronFileSystemAdapter();
   *
   * // With default caching
   * const cachedAdapter = new ElectronFileSystemAdapter({ cache: true });
   *
   * // With custom cache settings
   * const customAdapter = new ElectronFileSystemAdapter({
   *   cache: { maxEntries: 5000, ttlMs: 60000 }
   * });
   * ```
   */
  constructor(options?: ElectronAdapterOptions) {
    if (options?.cache) {
      const cacheConfig = typeof options.cache === 'object' ? options.cache : undefined;
      this.metadataCache = createMetadataCache(cacheConfig);
    } else {
      this.metadataCache = null;
    }
  }

  /**
   * Get cache statistics for monitoring.
   * Returns null if caching is disabled.
   */
  getCacheStats(): MetadataCacheStats | null {
    return this.metadataCache?.getStats() ?? null;
  }

  /**
   * Clear the metadata cache.
   * No-op if caching is disabled.
   */
  clearCache(): void {
    this.metadataCache?.clear();
  }

  /**
   * Invalidate cache entries for a specific path.
   * Use this when you know a file has changed.
   */
  invalidateCachePath(filePath: string): boolean {
    return this.metadataCache?.invalidatePath(filePath) ?? false;
  }

  /**
   * Invalidate cache entries under a directory.
   * Use this when directory contents have changed.
   */
  invalidateCacheDirectory(dirPath: string): number {
    return this.metadataCache?.invalidateDirectory(dirPath) ?? 0;
  }

  /**
   * Fetch file metadata, using cache if available.
   * Falls back to stat() on cache miss.
   */
  private async getFileMetadata(
    fullPath: string
  ): Promise<{ size: number; mtimeMs: number } | null> {
    // Try cache first
    if (this.metadataCache) {
      const cached = this.metadataCache.get(fullPath);
      if (cached && !cached.isDirectory) {
        return { size: cached.size, mtimeMs: cached.mtimeMs };
      }
    }

    // Cache miss - fetch from filesystem
    try {
      const stat = await fsPromises.stat(fullPath);

      // Store in cache
      if (this.metadataCache) {
        this.metadataCache.set(fullPath, {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          isDirectory: stat.isDirectory(),
        });
      }

      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * Requests directory access from the user via Electron's dialog
   *
   * @returns Promise<DirectoryHandle> The selected directory handle
   * @throws {UserCancelledError} When user cancels the dialog
   * @throws {PermissionError} When access is denied due to permissions
   * @throws {AccessError} When the selected path is invalid or inaccessible
   * @throws {DialogError} When the dialog fails to open
   */
  async requestDirectoryAccess(): Promise<DirectoryHandle> {
    // Dynamically import electron to avoid issues in browser/test environments
    let dialog: Electron.Dialog;
    try {
      // Stryker disable next-line StringLiteral
      const electron = await import('electron');
      dialog = electron.dialog;
    } catch {
      throw new Error(
        'Electron is not available - this adapter should only be used in the main process'
      );
    }

    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Select a folder to explore',
        // Add these properties to improve dialog behavior
        buttonLabel: 'Select Folder',
        message: 'Choose a directory to explore with BrainStrike',
      });

      if (result.canceled || result.filePaths.length === 0) {
        throw new UserCancelledError(
          'User cancelled directory selection',
          this.requestDirectoryAccess
        );
      }

      const selectedPath = result.filePaths[0];
      if (!selectedPath) {
        throw new Error('No directory path selected');
      }

      await validateDirectoryPath(selectedPath, this.requestDirectoryAccess);

      return {
        path: selectedPath,
        name: path.basename(selectedPath),
        kind: 'directory',
        platform: 'electron',
      };
    } catch (error) {
      // Re-throw with better error handling
      if (
        error instanceof UserCancelledError ||
        error instanceof PermissionError ||
        error instanceof AccessError
      ) {
        throw error; // Preserve our custom errors
      }
      if (error instanceof Error) {
        throw new DialogError(
          `Failed to open directory dialog: ${error.message}`,
          this.requestDirectoryAccess
        );
      }
      throw new DialogError(
        'Unknown error occurred while opening directory dialog',
        this.requestDirectoryAccess
      );
    }
  }

  async readDirectory(
    _handle: DirectoryHandle,
    options?: DirectoryReadOptions
  ): Promise<IFileNode[]> {
    try {
      const dirents = await fsPromises.readdir(_handle.path, { withFileTypes: true });
      const { includeMetadata, limiter } = normalizeDirectoryReadOptions(options);

      const directories = dirents.filter((d) => d.isDirectory());
      const files = dirents.filter((d) => !d.isDirectory());

      const nodes: IFileNode[] = directories.map((entry) =>
        toDirectoryNode(_handle, entry.name, path.join(_handle.path, entry.name))
      );

      if (includeMetadata) {
        const works = files.map((entry) =>
          limiter(async () => {
            const fullPath = path.join(_handle.path, entry.name);
            const metadata = await this.getFileMetadata(fullPath);
            if (metadata) {
              return toFileNodeWithMetadata(
                _handle,
                fullPath,
                entry.name,
                metadata.size,
                metadata.mtimeMs
              );
            }
            // Fallback to basic node if stat fails
            return toBasicFileNode(_handle, entry.name, fullPath);
          })
        );
        const settled = await Promise.allSettled(works);
        for (const r of settled) {
          if (r.status === 'fulfilled' && r.value) {
            nodes.push(r.value);
          }
        }
      } else {
        nodes.push(
          ...files.map((entry) =>
            toBasicFileNode(_handle, entry.name, path.join(_handle.path, entry.name))
          )
        );
      }

      return nodes.sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === 'directory' ? -1 : 1;
        }
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
    } catch (error) {
      throw new AccessError(
        `Failed to read directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        _handle.path,
        'read'
      );
    }
  }

  async readFile(_handle: FileHandle): Promise<string> {
    // Import config dynamically to avoid circular dependencies
    const { formatFileSize, getFileSizeConfig } = await import('../config.js');
    const { maxFileSize } = getFileSizeConfig();

    try {
      // Check file size before reading
      const stats = await fsPromises.stat(_handle.path);

      if (stats.size > maxFileSize) {
        throw new AccessError(
          `File too large: ${formatFileSize(stats.size)} (max: ${formatFileSize(maxFileSize)})`,
          _handle.path,
          'read'
        );
      }

      return await fsPromises.readFile(_handle.path, 'utf-8');
    } catch (error) {
      if (error instanceof AccessError) {
        throw error;
      }
      throw new AccessError(
        `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        _handle.path,
        'read'
      );
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file directly by its absolute path.
   *
   * This method allows reading files without needing a handle from the file tree,
   * which is useful for restoring persisted file tabs before the tree is loaded.
   *
   * Security: When rootPath is provided, the absolutePath is validated to ensure
   * it doesn't escape the root directory via path traversal attacks.
   *
   * @param absolutePath - The absolute path to the file
   * @param rootPath - Optional root directory to validate against (for security)
   * @returns The file contents as a string
   */
  async readFileByPath(absolutePath: string, rootPath?: string): Promise<string> {
    // Import config dynamically to avoid circular dependencies
    const { formatFileSize, getFileSizeConfig } = await import('../config.js');
    const { maxFileSize } = getFileSizeConfig();

    // Validate path against root if provided (security check)
    if (rootPath) {
      const validated = await resolveValidatedPath({
        rootDir: rootPath,
        requestedPath: absolutePath,
        allowMissing: false,
        maxTraversal: 0, // Don't allow any .. segments
        blockSensitiveDirectories: true,
      });

      if (!validated.ok) {
        throw new AccessError(
          `Path validation failed: ${validated.error.message}`,
          absolutePath,
          'read'
        );
      }
    }

    try {
      // Check file size before reading
      const stats = await fsPromises.stat(absolutePath);

      if (stats.size > maxFileSize) {
        throw new AccessError(
          `File too large: ${formatFileSize(stats.size)} (max: ${formatFileSize(maxFileSize)})`,
          absolutePath,
          'read'
        );
      }

      return await fsPromises.readFile(absolutePath, 'utf-8');
    } catch (error) {
      if (error instanceof AccessError) {
        throw error;
      }
      throw new AccessError(
        `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        absolutePath,
        'read'
      );
    }
  }

  /**
   * Watch a directory and emit high-level change events.
   *
   * 1. Try to use **chokidar** (preferred - cross-platform, debounced).
   * 2. Gracefully fall back to **fs.watch** when chokidar is not present or fails.
   *
   * Always returns a valid disposer that can be called safely at any time.
   */
  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[]) => void
  ): () => void {
    let closed = false;
    let dispose: () => void = () => {};

    // Wrap callback to invalidate cache on changes
    const callbackWithCacheInvalidation = (changes: FileSystemChange[]) => {
      // Invalidate cache for changed paths
      if (this.metadataCache) {
        for (const change of changes) {
          if (change.kind === 'directory') {
            this.metadataCache.invalidateDirectory(change.path);
          } else {
            this.metadataCache.invalidatePath(change.path);
          }
        }
      }
      // Call original callback
      callback(changes);
    };

    startChokidarWatch(handle, callbackWithCacheInvalidation)
      .then((stop) => {
        if (closed) {
          stop();
          return;
        }
        dispose = stop;
      })
      .catch((err) => {
        if (!closed) {
          dispose = handleWatcherSetupError(err, handle, callbackWithCacheInvalidation);
        }
      });

    return () => {
      closed = true;
      dispose();
    };
  }

  /**
   * Stream directory contents with batched callbacks (BST-147).
   *
   * Uses fs.opendir() for true streaming enumeration, calling onBatch
   * with groups of entries as they're discovered. This keeps the UI
   * responsive for large directories instead of blocking until all
   * entries are read.
   *
   * @param handle - Directory to enumerate
   * @param onBatch - Called with each batch of entries; meta.done indicates final batch
   * @param options - Streaming options including batchSize and AbortSignal
   */
  async readDirectoryStreaming(
    handle: DirectoryHandle,
    onBatch: DirectoryStreamCallback,
    options?: StreamingDirectoryReadOptions
  ): Promise<void> {
    const batchSize = options?.batchSize ?? DEFAULT_STREAMING_BATCH_SIZE;
    const signal = options?.signal;
    const { includeMetadata } = normalizeDirectoryReadOptions(options);
    const shouldAbort = (): boolean => isStreamingAborted(signal);

    let dir: Awaited<ReturnType<typeof fsPromises.opendir>> | null = null;

    try {
      dir = await fsPromises.opendir(handle.path);

      let total = 0;
      let pendingDirents: FsDirent[] = [];
      let aborted = false;

      // Bind getFileMetadata for the helper function
      const getMetadata = this.getFileMetadata.bind(this);
      const buildNode = async (dirent: FsDirent): Promise<IFileNode> => {
        const fullPath = path.join(handle.path, dirent.name);
        return dirent.isDirectory()
          ? toDirectoryNode(handle, dirent.name, fullPath)
          : createStreamingFileNode(handle, fullPath, dirent.name, includeMetadata, getMetadata);
      };

      for await (const dirent of dir) {
        // Check for cancellation
        if (shouldAbort()) {
          aborted = true;
          break;
        }

        pendingDirents.push(dirent);
        if (pendingDirents.length < batchSize) {
          continue;
        }

        const batchDirents = pendingDirents;
        pendingDirents = [];
        const nodes = await buildStreamingNodes(batchDirents, shouldAbort, buildNode);
        if (shouldAbort()) {
          aborted = true;
          break;
        }
        total = emitIntermediateBatch(nodes, total, onBatch);
      }

      // Process any remaining entries
      let finalNodes: IFileNode[] = [];
      if (!aborted && pendingDirents.length > 0 && !shouldAbort()) {
        finalNodes = await buildStreamingNodes(pendingDirents, shouldAbort, buildNode);
        if (shouldAbort()) {
          aborted = true;
        }
      }
      if (!aborted) {
        total += finalNodes.length;
      }

      // Emit any remaining entries and signal completion
      emitFinalBatch(aborted ? [] : finalNodes, total, onBatch);
    } catch (error) {
      throw new AccessError(
        `Failed to stream directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        handle.path,
        'read'
      );
    } finally {
      // Dir is auto-closed by for-await-of, but close explicitly on error/abort
      // Ignore "already closed" errors since that's the expected case
      try {
        await dir?.close();
      } catch {
        // Directory was already closed by the async iterator - that's fine
      }
    }
  }
}
