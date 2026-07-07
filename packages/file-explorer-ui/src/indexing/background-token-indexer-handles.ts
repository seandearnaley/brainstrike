import type { IFileNode } from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils/logger';
import { WINDOWS_ABSOLUTE_PATH_REGEX } from '@brainstrike/utils/relative-file-path';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';

const logger = createLogger('BackgroundTokenIndexerIntegration');
const SLASH_CODE = '/'.charCodeAt(0);
const BACKSLASH_CODE = '\\'.charCodeAt(0);

export interface ElectronFileHandle {
  kind: 'file';
  name: string;
  path: string;
  platform: 'electron';
}

/**
 * Type guard to check if handle is an Electron handle with path
 */
/**
 * Detect "file no longer exists" errors arriving from the file-system
 * adapter. Files vanish between when we cache a handle and when we read
 * (delete, rename, git checkout, watch event reordering) — that's normal
 * and the indexer correctly evicts them from its in-flight set, so the
 * absence shouldn't surface as an error log to the operator.
 *
 * Recognizes both Node-style `ENOENT` error codes and the
 * `AccessError`-wrapped messages we get back through the Electron preload
 * bridge. Other IO errors (permission, disk full, etc.) are NOT swallowed.
 */
export function isMissingFileError(
  error: string | Error | { code?: unknown; message?: unknown }
): boolean {
  if (typeof error === 'string') {
    return error.includes('ENOENT') || error.includes('NOT_FOUND');
  }
  const code = (error as { code?: unknown }).code;
  if (code === 'ENOENT' || code === 'NOT_FOUND') {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' && (message.includes('ENOENT') || message.includes('NOT_FOUND'))
  );
}

function isElectronHandle(handle: unknown): handle is ElectronFileHandle {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    'platform' in handle &&
    (handle as ElectronFileHandle).platform === 'electron' &&
    'path' in handle &&
    typeof (handle as ElectronFileHandle).path === 'string'
  );
}

/**
 * Type guard to check if handle is a Web FileSystemFileHandle
 */
function isWebFileHandle(handle: unknown): handle is FileSystemFileHandle {
  return (
    handle !== null &&
    typeof handle === 'object' &&
    'getFile' in handle &&
    typeof (handle as FileSystemFileHandle).getFile === 'function'
  );
}

/**
 * Combined handle info for indexing.
 * Includes file metadata for upfront filtering before queuing.
 */
export interface HandleInfo {
  electronHandle?: ElectronFileHandle;
  /** File name for binary detection */
  fileName: string;
  /** File size in bytes (if known) for large file filtering */
  fileSize: number | undefined;
  /** Synthetic handles rely on cached metadata and should stay retryable. */
  isSynthetic?: boolean;
  webHandle?: FileSystemFileHandle;
}

function isAbsoluteFolderPath(folderId: string): boolean {
  return (
    folderId.startsWith('/') ||
    folderId.startsWith('\\\\') ||
    folderId.startsWith('//') ||
    WINDOWS_ABSOLUTE_PATH_REGEX.test(folderId)
  );
}

function joinElectronAbsolutePath(rootPath: string, relativePath: string): string {
  const prefersBackslashes =
    WINDOWS_ABSOLUTE_PATH_REGEX.test(rootPath) ||
    rootPath.startsWith('\\\\') ||
    rootPath.includes('\\');
  const separator = prefersBackslashes ? '\\' : '/';
  const trimmedRootPath = trimTrailingPathSeparators(rootPath);
  const normalizedRelativePath = normalizeSlashRelativePath(relativePath, separator);
  if (normalizedRelativePath.length === 0) {
    return trimmedRootPath;
  }
  return `${trimmedRootPath}${separator}${normalizedRelativePath}`;
}

function trimTrailingPathSeparators(path: string): string {
  let end = path.length;
  while (end > 0) {
    const code = path.charCodeAt(end - 1);
    if (code !== SLASH_CODE && code !== BACKSLASH_CODE) {
      break;
    }
    end--;
  }
  return end === path.length ? path : path.slice(0, end);
}

function normalizeSlashRelativePath(relativePath: string, separator: string): string {
  // Avoid split/filter/join here: synthetic handles are created for bulk
  // selected files, so scanning skips per-file segment arrays.
  let normalized = '';
  let segmentStart = -1;

  for (let index = 0; index < relativePath.length; index++) {
    if (relativePath.charCodeAt(index) === SLASH_CODE) {
      if (segmentStart !== -1) {
        const segment = relativePath.slice(segmentStart, index);
        normalized = normalized.length === 0 ? segment : `${normalized}${separator}${segment}`;
        segmentStart = -1;
      }
      continue;
    }

    if (segmentStart === -1) {
      segmentStart = index;
    }
  }

  if (segmentStart !== -1) {
    const segment = relativePath.slice(segmentStart);
    normalized = normalized.length === 0 ? segment : `${normalized}${separator}${segment}`;
  }

  return normalized;
}

export function getSlashPathFileName(filePath: string): string {
  const lastSlashIdx = filePath.lastIndexOf('/');
  return lastSlashIdx === -1 ? filePath : filePath.slice(lastSlashIdx + 1);
}

export function buildSyntheticElectronHandle(args: {
  filePath: string;
  fileSize: number | undefined;
  folderId: string;
}): HandleInfo | null {
  if (!isAbsoluteFolderPath(args.folderId)) {
    return null;
  }

  const fileName = getSlashPathFileName(args.filePath);
  if (!fileName) {
    return null;
  }

  return {
    electronHandle: {
      kind: 'file',
      name: fileName,
      path: joinElectronAbsolutePath(args.folderId, args.filePath),
      platform: 'electron',
    },
    fileName,
    fileSize: args.fileSize,
    isSynthetic: true,
  };
}

/**
 * Log debug info for first file node encountered
 */
function logFirstFileNode(node: IFileNode): void {
  const handle = node.handle as unknown as Record<string, unknown> | undefined;
  logger.debug('buildFileHandleMap first file node', {
    handleKeys: handle ? Object.keys(handle) : [],
    handleKind: handle?.['kind'],
    handlePath: handle?.['path'],
    handlePlatform: handle?.['platform'],
    hasGetFile: handle && typeof handle['getFile'] === 'function',
    hasHandle: !!node.handle,
    hasRootFolderId: !!node.rootFolderId,
    nodeName: node.name,
    nodePath: node.path,
    nodeType: node.type,
    rootFolderId: node.rootFolderId,
  });
}

/**
 * Build a lookup map from composite key to file handle info
 * Supports both Web FileSystemFileHandle and Electron path-based handles
 */
export function buildFileHandleMap(
  nodes: IFileNode[],
  map: Map<string, HandleInfo>,
  loggedFirstRef: { logged: boolean } = { logged: false }
): void {
  for (const node of nodes) {
    // Debug: log first file node to understand handle structure
    if (!loggedFirstRef.logged && node.type === 'file') {
      logFirstFileNode(node);
      loggedFirstRef.logged = true;
    }

    if (node.type === 'file' && node.handle && node.rootFolderId) {
      const handle = node.handle;
      const compositeKey = encodeFileSelection(node.rootFolderId, node.path);

      if (isWebFileHandle(handle)) {
        map.set(compositeKey, {
          fileName: node.name,
          fileSize: node.size,
          webHandle: handle,
        });
      } else if (isElectronHandle(handle)) {
        map.set(compositeKey, {
          electronHandle: handle,
          fileName: node.name,
          fileSize: node.size,
        });
      }
    }
    if (node.children) {
      buildFileHandleMap(node.children, map, loggedFirstRef);
    }
  }
}
