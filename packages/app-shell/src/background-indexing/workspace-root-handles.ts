import type { DirectoryHandle } from '@brainstrike/file-system';

/**
 * The mounted root set, normalized. Multi-root callers read
 * `rootDirectoryHandles`; the legacy single-handle shape is the fallback so
 * both paths agree on "what is mounted right now".
 */
export function getActiveRootHandles(args: {
  rootDirectoryHandle: DirectoryHandle | null;
  rootDirectoryHandles: readonly DirectoryHandle[];
}): readonly DirectoryHandle[] {
  if (args.rootDirectoryHandles.length > 0) {
    return args.rootDirectoryHandles;
  }
  return args.rootDirectoryHandle ? [args.rootDirectoryHandle] : [];
}

/**
 * Stable identity for a mounted root: the adapter root id when one is known,
 * otherwise the path. Two handles for the same root compare equal across
 * re-renders even when the object identity changes.
 */
export function createMountedRootIdentityKey(
  handle: DirectoryHandle,
  rootIdByPath: ReadonlyMap<string, string>
): string {
  const adapterRootId = handle.rootId ?? rootIdByPath.get(handle.path) ?? null;
  return JSON.stringify([adapterRootId, handle.path]);
}
