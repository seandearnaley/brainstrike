/**
 * The workspace bar's folder-drop wiring (BST-1393, spec §4.1 [D7]), pulled
 * out of `use-workspace-bar.ts` for the same reason
 * `use-workspace-bar-terminal.ts` was: it owns a capability memo plus a stable
 * callback, and folding it into that hook would push its cognitive complexity
 * against Biome's ceiling.
 *
 * Returns a ready-to-spread partial, so the call site carries no conditional
 * of its own — the capability gate is pulled out entirely rather than merely
 * relocated.
 */
import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import { useCallback, useMemo } from 'react';
import { extractDroppedFolderPaths } from './extract-dropped-folder-paths';
import { useConnectFolder } from './use-connect-folder';
import { resolveWorkspaceConnectBridge } from './workspace-connect-bridge';

const logger = createLogger('FolderDrop');

/**
 * The toast copy for a drop that skipped at least one item, or `null` when
 * every dropped item mounted cleanly. Pulled out of the callback below purely
 * to stay under Biome's cognitive-complexity ceiling — the nested ternaries
 * read fine on their own but push the callback that also owns the mount loop
 * over the limit.
 */
function skippedDropNotice(
  mountedCount: number,
  skippedFileCount: number,
  unresolvedCount: number
): { readonly description: string; readonly title: string } | null {
  if (skippedFileCount === 0 && unresolvedCount === 0) {
    return null;
  }
  const lines = [
    skippedFileCount > 0
      ? `${skippedFileCount} dropped item${skippedFileCount === 1 ? ' is a file' : 's are files'}, not folders.`
      : null,
    unresolvedCount > 0
      ? `${unresolvedCount} dropped folder${unresolvedCount === 1 ? '' : 's'} could not be read from disk.`
      : null,
  ].filter((line) => line !== null);
  return {
    description: lines.join(' '),
    title: mountedCount > 0 ? 'Some dropped items were skipped' : 'Nothing to connect',
  };
}

export function useFolderDrop(): {
  readonly onDropItems?: ((items: readonly DataTransferItem[]) => void) | undefined;
} {
  // Resolved ONCE per hook instance, not per render: the capability IS the
  // gate, so web renders no drop zone rather than a zone that refuses.
  const bridge = useMemo(() => resolveWorkspaceConnectBridge(), []);
  const { connectPath } = useConnectFolder();
  const onDropItems = useCallback(
    (items: readonly DataTransferItem[]) => {
      if (!(bridge && connectPath)) {
        return;
      }
      const { paths, skippedFileCount, unresolvedCount } = extractDroppedFolderPaths(
        items,
        bridge.getDroppedPath
      );
      for (const droppedPath of paths) {
        // 'drop' is a first-class WorkspaceOpenOrigin (coordinator ruling,
        // via-vocabulary lesson): the refusal log's `origin` field is the
        // diagnostic someone reads when asking how a folder got here, and a
        // breadcrumb must name its real gesture even though a drop never
        // crosses IPC as an open-path push.
        void connectPath({ origin: 'drop', path: droppedPath });
      }
      // Both non-outcomes are stated. A drop that mounted nothing and said
      // nothing is the silent failure this whole feature must not have.
      const notice = skippedDropNotice(paths.length, skippedFileCount, unresolvedCount);
      if (notice) {
        logger.info('Dropped items were not folders', { skippedFileCount, unresolvedCount });
        toast({ ...notice, variant: 'destructive' });
      }
    },
    [bridge, connectPath]
  );
  return bridge && connectPath ? { onDropItems } : {};
}
