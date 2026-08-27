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
 *
 * `onRootConnected` is `use-workspace-bar.ts`'s `recordAddedAsSecondary` —
 * injected rather than imported, since this hook has no thread/database
 * context of its own. A drop is a third gesture on the SAME bar as the
 * Folder chip's Add folder… (`onAddFolder`) and Add recent… (`onAddRecent`),
 * both of which chain that same call after a successful mount so the folder
 * becomes a chip attached to THIS thread — a review finding: routing a drop
 * through `connectPath` alone mounts the folder globally but leaves the bar
 * showing no trace of it, silently on both outcomes.
 */
import type { DirectoryHandle } from '@brainstrike/file-system';
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
  unreadableCount: number,
  unresolvedCount: number
): { readonly description: string; readonly title: string } | null {
  if (skippedFileCount === 0 && unreadableCount === 0 && unresolvedCount === 0) {
    return null;
  }
  const lines = [
    skippedFileCount > 0
      ? `${skippedFileCount} dropped item${skippedFileCount === 1 ? ' is a file' : 's are files'}, not folders.`
      : null,
    unresolvedCount > 0
      ? `${unresolvedCount} dropped folder${unresolvedCount === 1 ? '' : 's'} could not be read from disk.`
      : null,
    // Kind-neutral copy on purpose (review finding, ruling D1's
    // misdescription class): these items' kind was never confirmed, so
    // calling them "folders" here would be the same wrong-noun mistake.
    unreadableCount > 0
      ? `${unreadableCount} dropped item${unreadableCount === 1 ? '' : 's'} could not be read.`
      : null,
  ].filter((line) => line !== null);
  return {
    description: lines.join(' '),
    title: mountedCount > 0 ? 'Some dropped items were skipped' : 'Nothing to connect',
  };
}

export interface UseFolderDropArgs {
  /**
   * `use-workspace-bar.ts`'s `recordAddedAsSecondary` — chained after each
   * successfully connected path so the drop becomes a chip on THIS thread,
   * the same way `onAddFolder`/`onAddRecent` already do. Awaited one path at
   * a time (not fired concurrently): `recordAddedAsSecondary` chains through
   * the shared thread-folders write tail regardless, but a multi-folder drop
   * connecting one path at a time also keeps `addRootDirectoryByPath`'s
   * shared loading flag and focused-root outcome deterministic in drop order
   * (review finding) rather than racing on whichever settles last.
   */
  readonly onRootConnected: (handle: {
    readonly name: string;
    readonly path: string;
  }) => Promise<void>;
}

export function useFolderDrop({ onRootConnected }: UseFolderDropArgs): {
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
      const { paths, skippedFileCount, unreadableCount, unresolvedCount } =
        extractDroppedFolderPaths(items, bridge.getDroppedPath);
      void connectAndRecordSequentially(paths, connectPath, onRootConnected);
      // Every non-outcome is stated. A drop that mounted nothing and said
      // nothing is the silent failure this whole feature must not have.
      const notice = skippedDropNotice(
        paths.length,
        skippedFileCount,
        unreadableCount,
        unresolvedCount
      );
      if (notice) {
        logger.info('Dropped items were not folders', {
          skippedFileCount,
          unreadableCount,
          unresolvedCount,
        });
        toast({ ...notice, variant: 'destructive' });
      }
    },
    [bridge, connectPath, onRootConnected]
  );
  return bridge && connectPath ? { onDropItems } : {};
}

/**
 * Connects each dropped path in drop order, one at a time, chaining
 * `onRootConnected` after every successful mount. Sequential on purpose (see
 * `UseFolderDropArgs.onRootConnected`): `connectPath` already reports each
 * outcome via its own toast, so a `null` result here needs no handling
 * beyond skipping the chained record — the failure path records nothing.
 *
 * The record step is wrapped IN the loop, not trailing it (review finding):
 * `recordAddedAsSecondary` throws on its first line when the workspace
 * database isn't ready yet, and the drop zone has no database dependency of
 * its own — it renders as soon as the bridge resolves. A boot-window drop
 * would otherwise mount the folder, throw on the chained record, and escape
 * as an unhandled rejection that ABORTS this loop, silently abandoning every
 * remaining path behind the one that threw. Catching per-path keeps the
 * loop going and tells the user with the SAME copy
 * `recordAddedAsSecondary`'s own `unresolved` branch already uses — from
 * the user's point of view a thrown record and a reconciliation timeout are
 * the same outcome: the folder mounted, but this thread was not updated.
 */
async function connectAndRecordSequentially(
  paths: readonly string[],
  connectPath: (request: {
    readonly origin: 'drop';
    readonly path: string;
  }) => Promise<DirectoryHandle | null>,
  onRootConnected: (handle: { readonly name: string; readonly path: string }) => Promise<void>
): Promise<void> {
  for (const droppedPath of paths) {
    // 'drop' is a first-class WorkspaceOpenOrigin (coordinator ruling,
    // via-vocabulary lesson): the refusal log's `origin` field is the
    // diagnostic someone reads when asking how a folder got here, and a
    // breadcrumb must name its real gesture even though a drop never
    // crosses IPC as an open-path push.
    const handle = await connectPath({ origin: 'drop', path: droppedPath });
    if (!handle) {
      continue;
    }
    try {
      await onRootConnected(handle);
    } catch (error: unknown) {
      logger.error('Dropped folder connected but could not be recorded on this thread', {
        error,
        path: handle.path,
      });
      toast({
        description: `"${handle.name}" is still available as a workspace folder, but this thread was not updated to include it.`,
        title: 'Folder added, but not attached to this thread',
        variant: 'destructive',
      });
    }
  }
}
