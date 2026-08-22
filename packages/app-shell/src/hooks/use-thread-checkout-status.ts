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

/** The primary root the chip describes: its durable id AND its path. */
export interface ThreadCheckoutRoot {
  readonly path: string;
  readonly rootId: string;
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
 *   branch operation. Registering this root's scope is what makes the canonical
 *   file-explorer refresh pipeline map those edits back here. The root IS its
 *   own worktree: the bar shows the thread's mounted folder, never a nested
 *   worktree of it.
 */
export function useThreadCheckoutStatus(
  root: ThreadCheckoutRoot | null
): WorkspaceBarCheckout | undefined {
  // Resolved ONCE per hook instance, not per render (same discipline as
  // useGitInventory): the bridge identity is an effect input.
  const bridge = useMemo(() => resolveGitBridge(), []);
  const rootId = root?.rootId ?? null;
  const rootPath = root?.path ?? null;
  useChangesLiveRefreshSubscription(
    rootId && rootPath ? { repositoryRoot: rootPath, rootId, worktreePath: rootPath } : null
  );
  const anyInvalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  // Pinned to 0 with no root: there is nothing to refetch, and a moving nonce
  // would only churn the effect.
  const gitScopeNonce = useChangesLiveRefreshStore((state) =>
    rootPath ? selectGitScopeRefreshNonce(state, rootPath) : 0
  );
  const [checkout, setCheckout] = useState<{
    readonly rootId: string;
    readonly value: WorkspaceBarCheckout;
  } | null>(null);

  useEffect(() => {
    if (!(bridge && rootId)) {
      return;
    }
    let cancelled = false;
    bridge
      .status(rootId)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          logger.warn('git status for the workspace bar failed', { error: result.error, rootId });
          setCheckout(null);
          return;
        }
        if (!result.value.isRepository) {
          setCheckout(null);
          return;
        }
        setCheckout({
          rootId,
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
          logger.warn('git status for the workspace bar threw', { error, rootId });
          setCheckout(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [anyInvalidationNonce, bridge, gitScopeNonce, rootId]);

  return checkout?.rootId === rootId ? checkout.value : undefined;
}
