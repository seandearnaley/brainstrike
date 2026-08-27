import type { WorkspaceBarCheckout } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo, useState } from 'react';
import {
  selectGitScopeRefreshNonce,
  useChangesLiveRefreshStore,
} from '../changes/changes-live-refresh-store';
import { useChangesLiveRefreshSubscription } from '../changes/use-changes-live-refresh';
import { resolveGitBridge } from '../git-panel/git-bridge';

const logger = createLogger('ThreadCheckoutStatus');

/**
 * The primary root the chip describes, in BOTH id spaces plus its path.
 *
 * They are not interchangeable. `window.git.status` is a DB-space consumer
 * (`roots.id`), while the FILE_EXPLORER_REFRESH_EVENT mapping in
 * `use-changes-live-refresh.ts` matches registrations against the file
 * explorer's ADAPTER rootId. The two coincide for reconciled-insert roots and
 * DIVERGE for legacy path-matched ones (see `roots/root-identity-context.tsx`),
 * so registering the DB id would silently strand the dirty dot for exactly
 * those roots — matching nothing while looking correct.
 */
export interface ThreadCheckoutRoot {
  /**
   * The file-explorer adapter rootId, or `null` when the root is not mounted in
   * this workspace (no descriptor supplies one). `null` registers NO git scope:
   * an id that maps to nothing is worse than no registration, because it reads
   * as coverage. Metadata pushes still refresh the chip.
   */
  readonly adapterRootId: string | null;
  /** The durable `roots.id` — the only id `window.git` understands. */
  readonly dbRootId: string;
  readonly path: string;
}

/**
 * Read-only git state for the workspace bar's Branch chip. Desktop only
 * (`window.git`); `undefined` = no chip (web, no root, not a repository, or a
 * failed status — a failure is logged and never rendered as "clean").
 *
 * The resolved value carries the root it was read for, so a checkout is never
 * displayed under a different root while that root's own status is in flight —
 * and that root tag is also why a root change needs no clearing effect: a
 * stale value simply stops matching.
 *
 * Refetches on BOTH live-refresh signals — no polling:
 *
 * - `anyInvalidationNonce`, every accepted `changes:invalidated` git-metadata
 *   push (the same nonce the git inventory uses);
 * - the root's own git-scope nonce, which is what carries WORKING-TREE edits.
 *   Metadata pushes report topology (branch/ahead/behind), so on the metadata
 *   nonce alone the `dirty` dot went stale the moment a file changed without a
 *   branch operation. Registering this root's scope UNDER ITS ADAPTER ID is
 *   what makes the canonical file-explorer refresh pipeline map those edits
 *   back here. The root IS its own worktree: the bar shows the thread's mounted
 *   folder, never a nested worktree of it.
 */
export function useThreadCheckoutStatus(
  root: ThreadCheckoutRoot | null
): WorkspaceBarCheckout | undefined {
  // Resolved ONCE per hook instance, not per render (same discipline as
  // useGitInventory): the bridge identity is an effect input.
  const bridge = useMemo(() => resolveGitBridge(), []);
  const adapterRootId = root?.adapterRootId ?? null;
  const dbRootId = root?.dbRootId ?? null;
  const rootPath = root?.path ?? null;
  // ALWAYS called, `null` registration included: the refcounted owner is what
  // feeds `anyInvalidationNonce`, so releasing it when there is no root (or no
  // adapter id) would also stop metadata pushes from reaching the chip.
  useChangesLiveRefreshSubscription(
    adapterRootId && rootPath
      ? { repositoryRoot: rootPath, rootId: adapterRootId, worktreePath: rootPath }
      : null
  );
  const anyInvalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  // Pinned to 0 with no root: there is nothing to refetch, and a moving nonce
  // would only churn the effect.
  const gitScopeNonce = useChangesLiveRefreshStore((state) =>
    rootPath ? selectGitScopeRefreshNonce(state, rootPath) : 0
  );
  const [checkout, setCheckout] = useState<{
    readonly dbRootId: string;
    readonly value: WorkspaceBarCheckout;
  } | null>(null);

  useEffect(() => {
    if (!(bridge && dbRootId)) {
      return;
    }
    let cancelled = false;
    bridge
      .status(dbRootId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          logger.warn('git status for the workspace bar failed', {
            dbRootId,
            error: result.error,
          });
          setCheckout(null);
          return;
        }
        if (!result.value.isRepository) {
          setCheckout(null);
          return;
        }
        setCheckout({
          dbRootId,
          value: {
            ahead: result.value.ahead,
            behind: result.value.behind,
            branch: result.value.branch,
            dirty: !result.value.clean,
          },
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.warn('git status for the workspace bar threw', { dbRootId, error });
          setCheckout(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [anyInvalidationNonce, bridge, dbRootId, gitScopeNonce]);

  return checkout?.dbRootId === dbRootId ? checkout.value : undefined;
}
