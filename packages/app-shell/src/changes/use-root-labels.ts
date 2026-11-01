/**
 * Root group display labels for the Changes surface's trees (BST-1164
 * review): rootId → human-readable name, from the mounted workspace roots.
 * The label is the root handle's own display name, falling back to the last
 * segment of its absolute path — NEVER the bare rootId UUID (that is what
 * the tree used to render). A root with no mounted handle simply has no
 * entry; the tree renders its generic label instead of fabricating one.
 */
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { useMemo } from 'react';
import { lastPathSegment } from './ui/changed-files-tree-columns';

export function useRootLabelById(): ReadonlyMap<string, string> {
  const { mountedRootHandles, rootIdByPath } = useFileSystem();
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const handle of mountedRootHandles) {
      const rootId = handle.rootId ?? rootIdByPath?.get(handle.path) ?? null;
      if (rootId === null) {
        continue;
      }
      const label = handle.name.length > 0 ? handle.name : lastPathSegment(handle.path);
      if (label.length > 0) {
        map.set(rootId, label);
      }
    }
    return map;
  }, [mountedRootHandles, rootIdByPath]);
}
