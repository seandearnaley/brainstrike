import type { SecureFileReadCapability } from '@brainstrike/file-system/secure-file-read';
import type { SecureWorkspaceDirEntry } from '@brainstrike/file-system/workspace-root-nodes';

/** A directory listing, as desktop's secure root returns one. */
export interface WorkspaceListing {
  readonly entries: readonly SecureWorkspaceDirEntry[];
  readonly inspected: number;
  readonly truncated: boolean;
}

/** A File System Access directory read as desktop's `SecureWorkspaceRoot` is: root-relative, bounded. */
export interface FsaWorkspaceRoot extends SecureFileReadCapability {
  /** null when the directory no longer exists. */
  listDir(relativePath: string, maxEntries: number): Promise<WorkspaceListing | null>;
}

type DirectoryEntries = AsyncIterable<[string, FileSystemHandle]>;

/**
 * A root-relative path's segments. A handle has no parent to escape to, but a
 * path that tries to is refused rather than resolved, as desktop's secure
 * root refuses it.
 */
function segments(relativePath: string): readonly string[] {
  if (relativePath === '.') {
    return [];
  }
  const parts = relativePath.split('/');
  if (
    relativePath.startsWith('/') ||
    relativePath.includes('\\') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('A workspace path must be root-relative and must not traverse.');
  }
  return parts;
}

/** A handle that is absent, or not of the kind the path asked for. */
function isMissing(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')
  );
}

async function directoryAt(
  root: FileSystemDirectoryHandle,
  parts: readonly string[]
): Promise<FileSystemDirectoryHandle | null> {
  let directory = root;
  for (const part of parts) {
    try {
      directory = await directory.getDirectoryHandle(part);
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw error;
    }
  }
  return directory;
}

/**
 * The browser's workspace root: a directory the user granted through File
 * System Access. A handle never follows a link, so no entry is one.
 */
export function fsaWorkspaceRoot(root: FileSystemDirectoryHandle): FsaWorkspaceRoot {
  return {
    async listDir(relativePath, maxEntries) {
      const directory = await directoryAt(root, segments(relativePath));
      if (!directory) {
        return null;
      }
      const entries: SecureWorkspaceDirEntry[] = [];
      let truncated = false;
      for await (const [name, handle] of (
        directory as unknown as { entries(): DirectoryEntries }
      ).entries()) {
        if (entries.length === maxEntries) {
          truncated = true;
          break;
        }
        if (handle.kind === 'file') {
          const file = await (handle as FileSystemFileHandle).getFile();
          entries.push({
            isDirectory: false,
            isFile: true,
            isSymbolicLink: false,
            lastModified: file.lastModified,
            name,
            size: file.size,
          });
        } else {
          entries.push({ isDirectory: true, isFile: false, isSymbolicLink: false, name });
        }
      }
      return { entries, inspected: entries.length, truncated };
    },
    async readFile(relativePath, maxBytes) {
      const parts = segments(relativePath);
      const name = parts.at(-1);
      const directory = await directoryAt(root, parts.slice(0, -1));
      if (!(name && directory)) {
        return { status: 'not-found' };
      }
      let file: File;
      try {
        file = await (await directory.getFileHandle(name)).getFile();
      } catch (error) {
        if (isMissing(error)) {
          return { status: 'not-found' };
        }
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          return { status: 'unreadable' };
        }
        throw error;
      }
      if (file.size > maxBytes) {
        return { status: 'oversized' };
      }
      return { content: new Uint8Array(await file.arrayBuffer()), status: 'ok' };
    },
  };
}
