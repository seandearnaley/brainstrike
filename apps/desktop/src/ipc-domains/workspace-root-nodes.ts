import path from 'node:path';
import type { IFileNode } from '@brainstrike/file-system';
import type { RootDescriptor } from '@brainstrike/types';
import { fileNodeCollator } from '@brainstrike/utils';
import type {
  MountedWorkspaceRoot,
  SecureWorkspaceDirEntry,
  StoredWorkspaceRoot,
} from './workspace-root-types';

export const MAX_DIRECTORY_ENTRIES = 10_000;
const TRUNCATION_NODE_BASENAME = '…truncated…' as const;

export function descriptorFor(
  entry: StoredWorkspaceRoot,
  permissionState: 'granted' | 'unknown',
  persisted = true
): RootDescriptor {
  const displayName = path.basename(entry.path) || entry.path;
  return {
    displayName,
    handle: {
      kind: 'directory',
      name: displayName,
      path: entry.path,
      platform: 'electron',
      rootId: entry.rootId,
    },
    kind: 'path',
    permissionState,
    persisted,
    rootId: entry.rootId,
  };
}

function buildDirectoryNode(
  mounted: MountedWorkspaceRoot,
  parentPath: string,
  entry: SecureWorkspaceDirEntry
): IFileNode {
  const entryPath = path.join(parentPath, entry.name);
  const isDirectory = entry.isDirectory && !entry.isSymbolicLink;
  if (isDirectory) {
    return {
      children: [],
      depth: 0,
      handle: {
        kind: 'directory',
        name: entry.name,
        path: entryPath,
        platform: 'electron',
        rootId: mounted.rootId,
      } as unknown as FileSystemDirectoryHandle,
      ...(entry.isSymbolicLink ? { isSymbolicLink: true } : {}),
      isVisible: true,
      name: entry.name,
      path: entryPath,
      rootFolderId: mounted.rootId,
      selectionState: 'unchecked',
      type: 'directory',
    };
  }
  return {
    depth: 0,
    handle: {
      kind: 'file',
      name: entry.name,
      path: entryPath,
      platform: 'electron',
      rootId: mounted.rootId,
    } as unknown as FileSystemFileHandle,
    ...(entry.isSymbolicLink ? { isSymbolicLink: true } : {}),
    isVisible: true,
    ...(entry.lastModified === undefined ? {} : { lastModified: entry.lastModified }),
    name: entry.name,
    path: entryPath,
    rootFolderId: mounted.rootId,
    selectionState: 'unchecked',
    ...(entry.size === undefined ? {} : { size: entry.size }),
    type: 'file',
  };
}

function buildTruncationNode(
  mounted: MountedWorkspaceRoot,
  parentPath: string,
  inspected: number
): IFileNode {
  const entryPath = path.join(parentPath, TRUNCATION_NODE_BASENAME);
  return {
    depth: 0,
    handle: {
      kind: 'file',
      name: TRUNCATION_NODE_BASENAME,
      path: entryPath,
      platform: 'electron',
      rootId: mounted.rootId,
    } as unknown as FileSystemFileHandle,
    isVisible: true,
    name: `Showing first ${inspected.toLocaleString('en-US')} entries`,
    path: entryPath,
    rootFolderId: mounted.rootId,
    selectionState: 'unchecked',
    type: 'truncated',
  };
}

/**
 * Directories first, then collated by name. A truncated native listing keeps
 * its partial result and appends a visible marker node — never a silent trim.
 */
export function buildDirectoryListing(
  mounted: MountedWorkspaceRoot,
  parentPath: string,
  listing: {
    readonly entries: readonly SecureWorkspaceDirEntry[];
    readonly inspected: number;
    readonly truncated: boolean;
  }
): IFileNode[] {
  const nodes = listing.entries
    .map((entry) => buildDirectoryNode(mounted, parentPath, entry))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      return fileNodeCollator.compare(left.name, right.name);
    });
  if (listing.truncated) {
    // Partial result, surfaced: the native bound held, the caller sees it.
    nodes.push(buildTruncationNode(mounted, parentPath, listing.inspected));
  }
  return nodes;
}
