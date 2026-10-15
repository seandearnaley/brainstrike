/**
 * The plan behind the Files app's "Attach to thread" (ADR-0021, BST-2018): the
 * selected files as `@file` mentions by the host's identity, and the folders
 * outside the thread they come from.
 */
import { encodeFileMentionId, type FileMentionDirective } from '@brainstrike/assistant-contract';
import { decodeFileSelection } from '@brainstrike/file-explorer/selection';

/**
 * Mentioned files are read in full when the message is sent, within the
 * host's referenced-files budget; a larger attach would mostly be cut there.
 */
export const MAX_ATTACHED_FILES = 20;

export interface AttachFolder {
  readonly displayName: string;
  readonly files: number;
  /** The folder's path, as the workspace bar adds it to a thread. */
  readonly path: string;
  readonly rootId: string;
}

export interface AttachPlan {
  readonly mentions: readonly FileMentionDirective[];
  /** Live workspace folders outside the thread that the mentions come from. */
  readonly outsideFolders: readonly AttachFolder[];
  /** Selected files that could not be addressed: an unreconciled root, or a path outside it. */
  readonly unaddressable: number;
}

export interface PlanRoot {
  readonly displayName: string;
  readonly path: string;
}

/** A selection path relative to its folder, or null when it lies outside it. */
export function folderRelativePath(selectionPath: string, rootPath: string): string | null {
  const path = selectionPath.replace(/\\/gu, '/');
  const root = rootPath.replace(/\\/gu, '/').replace(/\/+$/u, '');
  const isAbsolute = path.startsWith('/') || /^[A-Za-z]:\//u.test(path);
  if (!isAbsolute) {
    return path.replace(/^\.?\/+/u, '') || null;
  }
  if (root !== '' && path.startsWith(`${root}/`)) {
    return path.slice(root.length + 1) || null;
  }
  return null;
}

/**
 * Mentions for the selected files, by the host's identity (DB `roots.id` and a
 * folder-relative path), and the folders outside the thread they come from.
 * `threadRootIds` is null while the thread has no binding: every workspace
 * folder is then in its scope.
 */
export function planAttachment(
  selectedKeys: Iterable<string>,
  args: {
    readonly resolveDbRootId: (adapterRootId: string) => string | null;
    readonly roots: Readonly<Record<string, PlanRoot | undefined>>;
    readonly threadRootIds: readonly string[] | null;
  }
): AttachPlan {
  const mentions = new Map<string, FileMentionDirective>();
  const outside = new Map<string, AttachFolder>();
  let unaddressable = 0;
  for (const key of selectedKeys) {
    const { folderId, path } = decodeFileSelection(key);
    const root = args.roots[folderId];
    const dbRootId = args.resolveDbRootId(folderId);
    const relative = root ? folderRelativePath(path, root.path) : null;
    if (!(root && dbRootId && relative)) {
      unaddressable += 1;
      continue;
    }
    const id = encodeFileMentionId(dbRootId, relative);
    mentions.set(id, { id, label: relative.split('/').at(-1) ?? relative });
    if (args.threadRootIds && !args.threadRootIds.includes(dbRootId)) {
      const folder = outside.get(dbRootId);
      outside.set(dbRootId, {
        displayName: root.displayName,
        files: (folder?.files ?? 0) + 1,
        path: root.path,
        rootId: dbRootId,
      });
    }
  }
  return { mentions: [...mentions.values()], outsideFolders: [...outside.values()], unaddressable };
}
