/**
 * Live forge PR status for the workspace bar's primary root.
 *
 * NO POLLING. Three triggers, matching the main-side floors:
 * - mount / root change / window focus → `refresh(rootId, { reason: 'window' })`
 *   (60 s floor in main — a rapid remount cannot storm gh);
 * - `forge:prUpdated` push → a plain `prStatus` READ (main already refreshed,
 *   so asking it to fetch again would double every observation);
 * - the popover's Refresh → `refresh(rootId, { reason: 'user' })` (no floor).
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
import { useCallback, useEffect, useMemo, useState } from 'react';
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

  useEffect(() => {
    if (!(bridge && dbRootId)) {
      return;
    }
    let cancelled = false;
    // A push means main ALREADY fetched: read, do not fetch again.
    const call =
      pushNonce > 0 && userNonce === 0 && focusNonce === 0
        ? bridge.prStatus(dbRootId)
        : bridge.refresh(dbRootId, { reason: userNonce > 0 ? 'user' : 'window' });
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
        setResolved({
          dbRootId,
          diagnostic: result.value.kind === 'unavailable' ? result.value.failure.detail : null,
          status: result.value,
        });
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
