import type { WorkspaceBarCheckout } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo, useState } from 'react';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useChangesLiveRefreshSubscription } from '../changes/use-changes-live-refresh';
import { resolveGitBridge } from '../git-panel/git-bridge';

const logger = createLogger('ThreadCheckoutStatus');

/**
 * Read-only git state for the workspace bar's Branch chip. Desktop only
 * (`window.git`); `undefined` = no chip (web, no root, not a repository, or a
 * failed status — a failure is logged and never rendered as "clean").
 *
 * The resolved value carries the root it was read for, so a checkout is never
 * displayed under a different root while that root's own status is in flight.
 *
 * Refetches on every accepted `changes:invalidated` event (the same nonce the
 * git inventory uses) — no polling.
 */
export function useThreadCheckoutStatus(rootId: string | null): WorkspaceBarCheckout | undefined {
  // Resolved ONCE per hook instance, not per render (same discipline as
  // useGitInventory): the bridge identity is an effect input.
  const bridge = useMemo(() => resolveGitBridge(), []);
  useChangesLiveRefreshSubscription();
  const invalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  const [checkout, setCheckout] = useState<{
    readonly rootId: string;
    readonly value: WorkspaceBarCheckout;
  } | null>(null);

  useEffect(() => {
    if (!(bridge && rootId)) {
      setCheckout(null);
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
  }, [bridge, invalidationNonce, rootId]);

  return checkout?.rootId === rootId ? checkout.value : undefined;
}
