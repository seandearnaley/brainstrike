/**
 * Renderer subscription to the `changes:invalidated` push channel (BST-1161,
 * spec §6): one bridge subscription feeds `useChangesLiveRefreshStore`, no
 * matter how many data hooks are mounted.
 *
 * REFCOUNTED on purpose: `useChangeset` and `useGitInventory` each call
 * {@link useChangesLiveRefreshSubscription}, and several instances of both can
 * be mounted at once (Changes surface + git panel). The first acquirer
 * subscribes `bridge.onInvalidated`; the last release unsubscribes. State is
 * module-scoped but mutated only from effects — never at import time (the
 * chunk-init hazard class).
 *
 * Bridge-gated like everything else on this domain: no bridge (web, or a
 * malformed preload) means no subscription, and the store simply never ticks.
 */
import { useEffect } from 'react';
import { resolveChangesBridge } from './changes-bridge';
import { useChangesLiveRefreshStore } from './changes-live-refresh-store';

let subscriberCount = 0;
let unsubscribeFromBridge: (() => void) | null = null;

/**
 * Acquire one reference on the shared bridge subscription. Returns the
 * release function (idempotent per acquisition). Exported for tests; hooks
 * use {@link useChangesLiveRefreshSubscription}.
 */
export function acquireChangesLiveRefreshSubscription(): () => void {
  subscriberCount += 1;
  if (subscriberCount === 1) {
    const bridge = resolveChangesBridge();
    if (bridge) {
      unsubscribeFromBridge = bridge.onInvalidated((event) => {
        useChangesLiveRefreshStore.getState().ingestInvalidation(event);
      });
    }
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    subscriberCount -= 1;
    if (subscriberCount === 0 && unsubscribeFromBridge) {
      unsubscribeFromBridge();
      unsubscribeFromBridge = null;
    }
  };
}

/** Hold the shared `changes:invalidated` subscription while mounted. */
export function useChangesLiveRefreshSubscription(): void {
  useEffect(() => acquireChangesLiveRefreshSubscription(), []);
}
