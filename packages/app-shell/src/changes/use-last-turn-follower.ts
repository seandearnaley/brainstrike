/**
 * The Changes surface's standing "Last Turn" for one thread view (BST-1115):
 * while this thread is the active one, its newest run is the identity "Last
 * Turn" follows, and a change mid-run asks a "Last Turn" view of the thread to
 * re-resolve. Legacy threads drive it from the renderer's run stream
 * (`use-wrapper-rewind-wiring.ts`) and desktop host threads from their
 * committed log, so both follow runs and throttle refreshes the same way.
 *
 * BST-1268 unification: every OPEN thread's view mounts simultaneously
 * (hidden, not unmounted), so publication is gated on being the ACTIVE thread.
 * Becoming active re-publishes `activationRunId`: a legacy thread knows only
 * runs it has itself observed (no run-history IPC exists, so it publishes
 * `null` — inventing one would violate NO SILENT FALLBACKS); a host thread
 * publishes its newest committed run. See `changes-navigation-store.ts` for
 * the store contract.
 *
 * The refresh is THROTTLED leading+trailing: a tool burst must not fire an IPC
 * round-trip per call, and the LAST completion in a burst must still be
 * reflected — dropping it would leave the list one file short until the run
 * ended.
 */
import { useActiveAssistantThreadId } from '@brainstrike/assistant-data';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useChangesNavigationStore } from './changes-navigation-store';

/**
 * Leading+trailing throttle window for the live "Last Turn" re-resolve
 * (BST-1115 smoke feedback). Long enough that a burst of tool completions
 * costs one round-trip, short enough to read as real time.
 */
const LIVE_CHANGES_REFRESH_THROTTLE_MS = 500;

export interface LastTurnFollower {
  /** Publish `runId` as this thread's newest run, while it is the active thread. */
  readonly publishRun: (runId: string) => void;
  /** Ask a "Last Turn" view of this thread to re-resolve (throttled leading and trailing). */
  readonly refresh: () => void;
}

export function useLastTurnFollower(
  threadId: string | undefined,
  activationRunId: string | null
): LastTurnFollower {
  const setActiveThreadIdentity = useChangesNavigationStore(
    (state) => state.setActiveThreadIdentity
  );
  const requestLiveLastTurnRefresh = useChangesNavigationStore(
    (state) => state.requestLiveLastTurnRefresh
  );
  const isActiveThread = useActiveAssistantThreadId() === threadId && threadId !== undefined;
  const isActiveThreadRef = useRef(isActiveThread);
  const activationRunIdRef = useRef(activationRunId);
  useEffect(() => {
    isActiveThreadRef.current = isActiveThread;
    activationRunIdRef.current = activationRunId;
  });
  useEffect(() => {
    if (!(isActiveThread && threadId)) {
      return;
    }
    setActiveThreadIdentity({ latestRunId: activationRunIdRef.current, threadId });
  }, [threadId, isActiveThread, setActiveThreadIdentity]);

  const publishRun = useCallback(
    (runId: string) => {
      if (threadId && isActiveThreadRef.current) {
        setActiveThreadIdentity({ latestRunId: runId, threadId });
      }
    },
    [threadId, setActiveThreadIdentity]
  );

  const throttleRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    lastFiredAt: number;
  }>({ lastFiredAt: 0, timer: null });
  useEffect(() => {
    const throttle = throttleRef.current;
    return () => {
      if (throttle.timer !== null) {
        clearTimeout(throttle.timer);
        throttle.timer = null;
      }
    };
  }, []);
  const refresh = useCallback(() => {
    if (!threadId) {
      return;
    }
    const throttle = throttleRef.current;
    const now = Date.now();
    const elapsed = now - throttle.lastFiredAt;
    if (elapsed >= LIVE_CHANGES_REFRESH_THROTTLE_MS) {
      throttle.lastFiredAt = now;
      requestLiveLastTurnRefresh(threadId);
      return;
    }
    if (throttle.timer !== null) {
      return;
    }
    throttle.timer = setTimeout(() => {
      throttle.timer = null;
      throttle.lastFiredAt = Date.now();
      requestLiveLastTurnRefresh(threadId);
    }, LIVE_CHANGES_REFRESH_THROTTLE_MS - elapsed);
  }, [requestLiveLastTurnRefresh, threadId]);

  return useMemo(() => ({ publishRun, refresh }), [publishRun, refresh]);
}
