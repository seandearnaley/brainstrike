import type {
  ProviderAuthBridge,
  ProviderAuthStatus,
} from '@brainstrike/assistant-contract/provider-auth';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * States the main-process flow leaves on its OWN — the browser callback lands
 * out of band and `start()` resolves at the first transition, not at
 * completion (see the engine's `firstTransition`). The renderer therefore only
 * learns the flow finished by asking again.
 */
const TRANSIENT_STATES: ReadonlySet<ProviderAuthStatus['state']> = new Set([
  'awaiting_browser',
  'awaiting_device_code',
  'connecting',
]);

const POLL_INTERVAL_MS = 1500;

export interface ProviderAuthController {
  /** An action is in flight; every button disables while true. */
  readonly busy: boolean;
  readonly cancel: () => void;
  readonly connect: () => void;
  readonly connectWithDeviceCode: () => void;
  readonly disconnect: () => void;
  /** Bridge transport failure, rendered verbatim. Status FAILURES arrive as
   * `{state:'error'}` data; this is the never-supposed-to-happen throw. */
  readonly error: string | null;
  /** `undefined` until the first `status()` resolves. The row must not claim
   * "disconnected" before it has asked — that would be a fact it lacks. */
  readonly status: ProviderAuthStatus | undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Sign-in status could not be read.';
}

/**
 * Drives one provider's OAuth sign-in through the desktop bridge (BST-1356).
 * The bridge is passed in rather than read here, so this hook only ever mounts
 * behind the capability gate in `provider-auth-capability.ts`.
 */
export function useProviderAuthStatus(
  bridge: ProviderAuthBridge,
  provider: string
): ProviderAuthController {
  const [status, setStatus] = useState<ProviderAuthStatus | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const apply = useCallback((next: ProviderAuthStatus) => {
    if (mountedRef.current) {
      setError(null);
      setStatus(next);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await bridge.status(provider));
    } catch (caught) {
      if (mountedRef.current) {
        setError(toErrorMessage(caught));
      }
    }
  }, [apply, bridge, provider]);

  const run = useCallback(
    (action: () => Promise<ProviderAuthStatus>) => {
      setBusy(true);
      void (async () => {
        try {
          apply(await action());
          // The action's own result is only the FIRST transition; re-reading
          // picks up a flow that already finished (or a sticky error).
          await refresh();
        } catch (caught) {
          if (mountedRef.current) {
            setError(toErrorMessage(caught));
          }
        } finally {
          if (mountedRef.current) {
            setBusy(false);
          }
        }
      })();
    },
    [apply, refresh]
  );

  // The first status read must follow MOUNTING — there is no user event to
  // hang it on — so an effect is the correct tool here.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A transient flow completes in the main process with no renderer event to
  // subscribe to (the bridge exposes no listener), so re-asking on a timer is
  // the only way to observe the transition.
  useEffect(() => {
    if (!(status && TRANSIENT_STATES.has(status.state))) {
      return;
    }
    const timer = setTimeout(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [refresh, status]);

  const cancel = useCallback(() => run(() => bridge.cancel(provider)), [bridge, provider, run]);
  const connect = useCallback(() => run(() => bridge.start(provider)), [bridge, provider, run]);
  const connectWithDeviceCode = useCallback(
    () => run(() => bridge.start(provider, 'device')),
    [bridge, provider, run]
  );
  const disconnect = useCallback(
    () => run(() => bridge.disconnect(provider)),
    [bridge, provider, run]
  );

  return { busy, cancel, connect, connectWithDeviceCode, disconnect, error, status };
}
