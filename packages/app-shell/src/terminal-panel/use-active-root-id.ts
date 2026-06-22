import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { useMemo } from 'react';

/**
 * Resolve the durable `rootId` of the focused workspace root, or `null` when no
 * root is open (or the focused root has no durable id — e.g. a web FSA root with
 * no absolute path, which the terminal backend cannot spawn a shell in).
 *
 * Derived purely during render from the file-system store — never mirrored into
 * state via an effect (react-doctor `no-adjust-state-on-prop-change`). Matches
 * the resolution used by every other workspace surface (see the Git panel and
 * FileTreeWrapper): prefer the self-identifying `handle.rootId`, fall back to the
 * path→id map for legacy single-root handles.
 */
export function useActiveRootId(): string | null {
  const { rootDirectoryHandle, rootIdByPath } = useFileSystem();
  return useMemo<string | null>(() => {
    if (!rootDirectoryHandle) {
      return null;
    }
    return rootDirectoryHandle.rootId ?? rootIdByPath?.get(rootDirectoryHandle.path) ?? null;
  }, [rootDirectoryHandle, rootIdByPath]);
}
