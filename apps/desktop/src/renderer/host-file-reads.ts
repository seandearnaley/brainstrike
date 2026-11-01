import type { DirectoryHandle, FileHandle } from '@brainstrike/file-system';
import { buildDirectoryListing } from '@brainstrike/file-system/workspace-root-nodes';
import type { IFileNode } from '@brainstrike/types';
import { type DesktopHostConnection, windowHostConnection } from './desktop-host-connection';

/** The Explorer's reads, as the desktop file-system adapter exposes them. */
export interface DesktopFileReads {
  exists(path: string): Promise<boolean>;
  readDirectory(handle: DirectoryHandle): Promise<IFileNode[]>;
  /** `root` binds the read to exactly that live root. */
  readFile(
    request: Pick<FileHandle, 'path' | 'rootId'>,
    root?: { readonly path: string; readonly rootId: string }
  ): Promise<string>;
}

/**
 * ADR-0029 stage 4: the Explorer reads live roots through the agent host, which
 * confines every read to a root its catalog records as live. A missing or
 * oversized file keeps the code the Explorer shows (`NOT_FOUND`, `TOO_LARGE`).
 */
export function createDesktopFileReads(connection: DesktopHostConnection): DesktopFileReads {
  return {
    exists: async (path) =>
      (await (await connection.current()).request('workspace/files/exists', { path })).exists,
    readDirectory: async (handle) => {
      const listing = await (await connection.current()).request('workspace/files/list', {
        path: handle.path,
        ...(handle.rootId === undefined ? {} : { rootId: handle.rootId }),
      });
      return buildDirectoryListing({ rootId: listing.rootId }, handle.path, listing);
    },
    readFile: async ({ path, rootId }, root) => {
      const result = await (await connection.current()).request('workspace/files/read', {
        path,
        ...(root ? { rootId: root.rootId, rootPath: root.path } : {}),
        ...(!root && rootId !== undefined ? { rootId } : {}),
      });
      if ('content' in result) {
        return result.content;
      }
      throw Object.assign(new Error(result.message), { code: result.code });
    },
  };
}

let windowReads: DesktopFileReads | undefined;

/** `null` where this window has no agent-host capability. */
export function resolveDesktopFileReads(): DesktopFileReads | null {
  if (!window.agentHost) {
    return null;
  }
  windowReads ??= createDesktopFileReads(windowHostConnection());
  return windowReads;
}
