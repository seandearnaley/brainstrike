import {
  type FileContextIdentity,
  isAbsolutePath,
  toRelativePath,
} from '@brainstrike/context-actions';

export interface FileTargetIdentityInput {
  readonly name: string;
  readonly path: string;
  /** Durable RootId, which may be a UUID rather than a filesystem path. */
  readonly rootFolderId: string;
  /** Explicit root filesystem path resolved from the RootId when available. */
  readonly rootPath?: string | null;
}

/**
 * Builds the shared file identity without guessing that a durable RootId is a
 * path. An unresolved absolute path keeps its absolute identity but exposes no
 * relative path, so the registry hides only the action it cannot honor.
 */
export function resolveFileTargetIdentity({
  name,
  path,
  rootFolderId,
  rootPath,
}: FileTargetIdentityInput): FileContextIdentity {
  if (!isAbsolutePath(path)) {
    return { absolutePath: null, name, relativePath: path, rootFolderId };
  }

  const resolvedRootPath =
    rootPath && isAbsolutePath(rootPath)
      ? rootPath
      : isAbsolutePath(rootFolderId)
        ? rootFolderId
        : null;
  if (!resolvedRootPath) {
    return { absolutePath: path, name, relativePath: null, rootFolderId };
  }
  if (path === resolvedRootPath) {
    return { absolutePath: path, name, relativePath: '', rootFolderId };
  }
  const relativePath = toRelativePath(path, resolvedRootPath);
  return {
    absolutePath: path,
    name,
    relativePath: isAbsolutePath(relativePath) ? null : relativePath,
    rootFolderId,
  };
}
