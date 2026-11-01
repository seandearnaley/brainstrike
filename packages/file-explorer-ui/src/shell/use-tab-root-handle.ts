import { decodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useMemo } from 'react';
import { useFileSystem } from './file-system-provider';

type RootDirectoryHandleEntry = ReturnType<typeof useFileSystem>['mountedRootHandles'][number];

/**
 * Resolve a file tab's workspace root (BST-1269/BST-1319): decode the tab's
 * compositeKey to its folderId and find the matching connected root handle.
 * A null handle means the tab's root is NOT connected (workspace changed,
 * root disconnected) — callers must render an explicit unavailable state,
 * never silently degrade.
 */
export function useTabRootHandle(compositeKey: string): {
  folderId: string | null;
  handle: RootDirectoryHandleEntry | null;
} {
  const { mountedRootHandles, rootIdByPath } = useFileSystem();
  const folderId = useMemo(() => {
    try {
      return decodeFileSelection(compositeKey).folderId;
    } catch {
      return null;
    }
  }, [compositeKey]);
  const handle =
    mountedRootHandles.find(
      (candidate) =>
        (candidate.rootId ?? rootIdByPath?.get(candidate.path) ?? candidate.path) === folderId
    ) ?? null;
  return { folderId, handle };
}
