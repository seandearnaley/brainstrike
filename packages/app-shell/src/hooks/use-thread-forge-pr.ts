/**
 * Live forge PR status for the workspace bar's primary root.
 *
 * NO POLLING. Four triggers, matching the main-side floors:
 * - mount / root change → `refresh(rootId, { reason: 'window' })` (60 s floor
 *   in main — a rapid remount cannot storm gh);
 * - window focus → `refresh(rootId, { reason: 'window' })` (same floor);
 * - the popover's Refresh → `refresh(rootId, { reason: 'user' })` (no floor);
 * - `forge:prUpdated` push → a plain `prStatus` READ (main already refreshed,
 *   so asking it to fetch again would double every observation).
 *
 * BST-1391 fix round (F1): which trigger fires is decided by comparing each
 * nonce/root against the value it had the last time THIS effect actually ran
 * — never by the cumulative "has this ever fired" test the first cut used
 * (`pushNonce > 0 && userNonce === 0 && focusNonce === 0`). That cumulative
 * test breaks the instant the user clicks Refresh once: `userNonce` never
 * returns to 0, so every later run — a push, a focus, doesn't matter — takes
 * the `else` branch and reads `userNonce > 0` as true, calling
 * `refresh(reason:'user')` (a refresh with NO floor) on every subsequent
 * push. In production a refresh's own PR-updated push feeds right back into
 * `onPrUpdated`, so that is an unbounded gh-fetch loop, not just a wasted
 * call. Comparing against the PREVIOUS value fixes this because only the one
 * nonce that changed on THIS render can read as "changed" — every other
 * trigger stays inert simply because it repeats. Root change is checked
 * first and wins outright: it is a carry-in (same as mount), never a
 * continuation of the PRIOR root's user/push trigger.
 *
 * Nothing fires while the document is hidden: the focus listener is the only
 * repeat trigger and a hidden window never focuses.
 *
 * The resolved value carries the root it was read for, so a status is never
 * displayed under a different root while that root's own read is in flight —
 * the same discipline as `useThreadCheckoutStatus`.
 */
import { createLogger } from '@brainstrike/logging';
import type { ForgePrStatus } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveForgeBridge } from '../forge/forge-bridge';

const logger = createLogger('ThreadForgePr');

export interface ThreadForgePrState {
  /**
   * The reason there is no PR chip, or `null` when there is nothing to
   * explain. Rendered by the BranchChip — never swallowed, never a tooltip
   * only.
   */
  readonly diagnostic: string | null;
  readonly refresh: () => void;
  readonly status: ForgePrStatus | null;
}

interface RootScopedStatus {
  readonly dbRootId: string;
  readonly diagnostic: string | null;
  readonly status: ForgePrStatus | null;
}

/**
 * BST-1391 fix round (F2): a `stale` observation whose last-known
 * `pullRequest` is `null` has nothing for the PR chip to render (see
 * `PrChip`'s own guard), so the failure that produced it is the ONLY thing
 * left to explain — same as `unavailable`. Without this, that failure was
 * computed nowhere and the BranchChip had no diagnostic to show for a
 * perfectly good gh-auth/network error.
 */
function forgePrDiagnosticOf(value: ForgePrStatus): string | null {
  if (value.kind === 'unavailable') {
    return value.failure.detail;
  }
  if (value.kind === 'stale' && value.pullRequest === null) {
    return value.failure.detail;
  }
  return null;
}

export function useThreadForgePr(dbRootId: string | null): ThreadForgePrState {
  // Resolved ONCE per hook instance: the bridge identity is an effect input.
  const bridge = useMemo(() => resolveForgeBridge(), []);
  const [resolved, setResolved] = useState<RootScopedStatus | null>(null);
  const [pushNonce, setPushNonce] = useState(0);
  const [userNonce, setUserNonce] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);

  const refresh = useCallback(() => {
    setUserNonce((nonce) => nonce + 1);
  }, []);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    return bridge.onPrUpdated(() => {
      setPushNonce((nonce) => nonce + 1);
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    const onFocus = (): void => {
      setFocusNonce((nonce) => nonce + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [bridge]);

  // The sentinel `undefined` never equals a real `dbRootId`, so the very
  // first run (mount) reads as a root change — the carry-in case the module
  // doc describes.
  const prevDbRootIdRef = useRef<string | undefined>(undefined);
  const prevPushNonceRef = useRef(pushNonce);
  const prevUserNonceRef = useRef(userNonce);
  const prevFocusNonceRef = useRef(focusNonce);

  useEffect(() => {
    if (!(bridge && dbRootId)) {
      return;
    }
    const rootChanged = prevDbRootIdRef.current !== dbRootId;
    const userChanged = !rootChanged && userNonce !== prevUserNonceRef.current;
    const focusChanged = !(rootChanged || userChanged) && focusNonce !== prevFocusNonceRef.current;
    const pushChanged =
      !(rootChanged || userChanged || focusChanged) && pushNonce !== prevPushNonceRef.current;

    prevDbRootIdRef.current = dbRootId;
    prevPushNonceRef.current = pushNonce;
    prevUserNonceRef.current = userNonce;
    prevFocusNonceRef.current = focusNonce;

    let cancelled = false;
    // A push means main ALREADY fetched: read, do not fetch again. Every
    // other trigger (root change, focus, user) asks main for a fresh read at
    // its own floor — 'user' only for the trigger that is actually a user
    // click, 'window' for the carry-in/focus cases.
    const call = pushChanged
      ? bridge.prStatus(dbRootId)
      : bridge.refresh(dbRootId, { reason: userChanged ? 'user' : 'window' });
    call
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          logger.warn('Forge PR status failed', { dbRootId, error: result.error });
          setResolved({ dbRootId, diagnostic: result.error, status: null });
          return;
        }
        const value = result.value;
        setResolved({ dbRootId, diagnostic: forgePrDiagnosticOf(value), status: value });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.warn('Forge PR status threw', { dbRootId, error: message });
        setResolved({ dbRootId, diagnostic: message, status: null });
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, dbRootId, focusNonce, pushNonce, userNonce]);

  const matches = resolved?.dbRootId === dbRootId;
  return {
    diagnostic: matches ? resolved.diagnostic : null,
    refresh,
    status: matches ? resolved.status : null,
  };
}
