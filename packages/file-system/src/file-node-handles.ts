import type { DirectoryHandle, FileHandle, IFileNode } from '@brainstrike/types';
import { getKnownFileSize } from '@brainstrike/utils/file-content';

function getStampedRootId(handle: IFileNode['handle']): string | undefined {
  if (!('rootId' in handle) || handle.rootId === undefined) {
    return undefined;
  }
  if (typeof handle.rootId !== 'string') {
    throw new Error('File-system handle has an invalid root identity');
  }
  return handle.rootId;
}

/** Preserve adapter descriptors; wrap only raw browser capabilities. */
export function fileNodeToFileHandle(node: IFileNode): FileHandle {
  const handle = node.handle;
  if (handle?.kind !== 'file') {
    throw new Error(`File node is missing its file handle: ${node.path}`);
  }
  const rootId = getStampedRootId(handle);
  const descriptor: FileHandle =
    'platform' in handle
      ? handle
      : {
          _internal: handle,
          kind: 'file',
          name: node.name,
          path: node.path,
          platform: 'web',
          ...(rootId === undefined ? {} : { rootId }),
        };
  const size = descriptor.size ?? getKnownFileSize(node.size);
  return {
    ...descriptor,
    rootFolderId: descriptor.rootFolderId ?? node.rootFolderId,
    ...(size === null ? {} : { size }),
  };
}

/** Inherit durable identity only when the child descriptor has none. */
export function fileNodeToDirectoryHandle(
  node: IFileNode,
  parentRootId?: DirectoryHandle['rootId']
): DirectoryHandle {
  const handle = node.handle;
  if (handle === undefined) {
    throw new Error(`Directory node is missing its native handle: ${node.path}`);
  }
  if (handle.kind !== 'directory') {
    throw new Error(`Directory node does not have a directory handle: ${node.path}`);
  }
  const rootId = getStampedRootId(handle) ?? parentRootId;
  const descriptor: DirectoryHandle =
    'platform' in handle
      ? handle
      : {
          _internal: handle,
          kind: 'directory',
          name: node.name,
          path: node.path,
          platform: 'web',
        };
  return { ...descriptor, ...(rootId === undefined ? {} : { rootId }) };
}
