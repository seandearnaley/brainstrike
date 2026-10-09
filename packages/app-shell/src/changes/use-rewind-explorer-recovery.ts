/**
 * EXPLORER RECOVERY AFTER A FILES-MODE REWIND (BST-1115, smoke round 2 defect 2).
 *
 * THE DEFECT. A rewind that un-creates a scaffolded project unlinks dozens of
 * files in one burst, straight from the main process. That burst is exactly the
 * shape the OS watch backends handle worst: on a coalescing/dropping backend
 * `parcel-watchers.ts` reports a backend error, which the electron renderer
 * adapter translates into the shared `FileSystemWatchSignal` channel as
 * `overflow` (health `degraded`) or, when the subscription itself dies, as
 * `errored` (health `failed`). The live smoke produced the second one: the
 * watcher chip went red, the tree kept rendering nodes for files that no longer
 * existed, and selection state read as stuck because the checkboxes belonged to
 * ghost nodes.
 *
 * THE DOCUMENTED CONTRACT WE COMPOSE WITH, NOT AGAINST. `errored` means the
 * adapter has ALREADY torn the watch down: the root stays connected but
 * UNWATCHED, and nothing restarts it automatically
 * (`packages/types/src/file-system.ts`, `use-file-system-context.ts`'s
 * `handleWatcherSignal` — it logs and toasts, deliberately, and dispatches no
 * refresh). So a rewind cannot rely on the watcher to report its own writes: on
 * the errored path there is no watcher left to report them. Two things are
 * needed and this hook does exactly those two, through seams that already
 * exist:
 *
 * 1. RE-ENUMERATE. Dispatch the SAME `scope: 'full'` / `source: 'watcher'`
 *    refresh event the overflow path dispatches (`use-file-system-context.ts`),
 *    once per affected root. Every FileTreeProvider — including the outer
 *    refresh-authority one, which the `manual` variant deliberately skips —
 *    reacts by fully reloading that root
 *    (`use-file-tree-refresh-events.ts`), and the background indexer consumes
 *    the same event. This is the existing pipeline; a second channel would be
 *    a second thing to keep correct.
 * 2. RE-WATCH. For a root whose health is `failed`, call the existing
 *    `retryWatcher` seam (`fs:watch-retry`, main-process throttled and
 *    single-flight). Without it the root stays unwatched until the user finds
 *    the chip's retry button.
 *
 * ORDER: refresh first, retry second. The rewind's own writes are already
 * complete on disk before this runs, so the enumeration cannot miss them and
 * there is no lost-change window to close by re-watching first — while a
 * `subscribe` that hangs to its timeout would hold the visible fix hostage.
 *
 * SCOPE: driven off the apply/redo result's `rootOutcomes`, which covers EVERY
 * root the revert plan touched (the MULTI-ROOT BAR). A root reported with
 * `rootPath: null` is disconnected — nothing was written there and there is no
 * tree to refresh or watch to retry, so it is skipped by identity, not
 * silently.
 */
import { useWatcherHealth } from '@brainstrike/file-explorer-hooks';
import { createFileExplorerRefreshEvent } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import { useCallback } from 'react';
import type { RewindRootRef } from './rewind-port';

const logger = createLogger('RewindExplorerRecovery');

export type RewindExplorerRecovery = (roots: readonly RewindRootRef[]) => Promise<void>;

interface ConnectedRoot {
  readonly rootId: string;
  readonly rootPath: string;
}

function connectedRoots(rootOutcomes: readonly RewindRootRef[]): readonly ConnectedRoot[] {
  const seen = new Set<string>();
  const roots: ConnectedRoot[] = [];
  for (const outcome of rootOutcomes) {
    if (outcome.rootPath === null || seen.has(outcome.rootId)) {
      continue;
    }
    seen.add(outcome.rootId);
    roots.push({ rootId: outcome.rootId, rootPath: outcome.rootPath });
  }
  return roots;
}

export function useRewindExplorerRecovery(): RewindExplorerRecovery {
  const { healthByRoot, retry } = useWatcherHealth();

  return useCallback(
    async (rootOutcomes: readonly RewindRootRef[]): Promise<void> => {
      const roots = connectedRoots(rootOutcomes);
      if (roots.length === 0) {
        return;
      }

      window.dispatchEvent(
        createFileExplorerRefreshEvent({
          roots: roots.map((root) => ({
            changes: [],
            rootId: root.rootId,
            rootPath: root.rootPath,
          })),
          scope: 'full',
          source: 'watcher',
        })
      );

      for (const root of roots) {
        // ONLY `failed`. `degraded` keeps a live subscription (the backend
        // recovers itself on the next clean batch) and retrying it would tear
        // down a working watch.
        if (healthByRoot.get(root.rootPath)?.state !== 'failed') {
          continue;
        }
        try {
          const outcome = await retry(root.rootPath);
          if (!outcome.retried) {
            // Never silently absorbed: a root left unwatched after a rewind is
            // a real, user-visible degradation and the chip's manual retry is
            // the fallback the log points at.
            logger.warn('Watcher retry after rewind did not restart the watch', {
              reason: outcome.reason,
              rootId: root.rootId,
            });
          }
        } catch (error) {
          logger.error('Watcher retry after rewind failed', {
            error: error instanceof Error ? error.message : String(error),
            rootId: root.rootId,
          });
        }
      }
    },
    [healthByRoot, retry]
  );
}
