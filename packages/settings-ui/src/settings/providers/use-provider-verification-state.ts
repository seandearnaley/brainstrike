import type {
  ProviderVerificationLookup,
  ProviderVerificationSnapshot,
} from '@brainstrike/assistant-contract';
import {
  BoundaryFailureError,
  describeBoundaryFailure,
} from '@brainstrike/assistant-contract/boundary-failure';
import { useEffect, useRef, useState } from 'react';

const MAX_VISIBLE_ERROR_CHARS = 300;

/**
 * Stable identity for the not-yet-requested state: a per-render literal would
 * invalidate every memo downstream.
 */
const IDLE_LOOKUP: ProviderVerificationLookup = { state: 'idle' };

/**
 * Runs ONE probe. Injected as a plain function rather than a hook — a hook
 * passed as a value violates the rules of hooks at the wiring site and defeats
 * compiler memoisation, and this package cannot import the app-shell
 * implementation directly without closing a dependency cycle.
 */
export type VerifyProvider = (
  providerId: string,
  signal: AbortSignal
) => Promise<ProviderVerificationSnapshot>;

export interface UseProviderVerificationStateArgs {
  /**
   * Fired once per completed probe, with the result. This is how the
   * connect→models chaining reacts to a verdict: an EVENT at the moment the
   * answer arrives, rather than an effect watching state and calling back up
   * into the parent.
   */
  readonly onResolved?: ((snapshot: ProviderVerificationSnapshot) => void) | undefined;
  readonly providerId: string;
  readonly verifyProvider: VerifyProvider;
}

export interface ProviderVerificationState {
  readonly lookup: ProviderVerificationLookup;
  /** Imperative trigger for the "Test connection" affordance. */
  readonly verify: () => void;
}

/** A host refusal reads with its remedy, as the host sent it. */
function toVisibleError(error: unknown): string {
  if (error instanceof BoundaryFailureError) {
    return describeBoundaryFailure(error.failure).slice(0, MAX_VISIBLE_ERROR_CHARS);
  }
  const message = error instanceof Error ? error.message : 'Provider verification failed';
  return message.slice(0, MAX_VISIBLE_ERROR_CHARS);
}

/**
 * Renderer-side lifecycle for the BST-1357 credential probe, owned by the
 * surface that renders it (BST-1358).
 *
 * BUTTON-DRIVEN, never effect-driven: the probe is advisory and must not fire
 * on mere render. An in-flight request for a superseded provider is abandoned
 * client-side and its response ignored; unmount aborts.
 */
export function useProviderVerificationState({
  onResolved,
  providerId,
  verifyProvider,
}: UseProviderVerificationStateArgs): ProviderVerificationState {
  const [state, setState] = useState<{
    readonly lookup: ProviderVerificationLookup;
    readonly providerId: string;
  }>();
  const requestSequence = useRef(0);
  const activeController = useRef<AbortController>(undefined);

  useEffect(
    () => () => {
      requestSequence.current += 1;
      activeController.current?.abort();
    },
    []
  );

  // `verify` may change identity when a caller passes an inline closure; the
  // one effect that fires it is LATCHED, so a new identity cannot re-trigger
  // the probe.
  const verify = () => {
    requestSequence.current += 1;
    const sequence = requestSequence.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    setState({ lookup: { state: 'loading' }, providerId });
    void verifyProvider(providerId, controller.signal)
      .then((snapshot) => {
        if (requestSequence.current !== sequence) {
          return;
        }
        setState({ lookup: { snapshot, state: 'resolved' }, providerId });
        onResolved?.(snapshot);
      })
      .catch((error: unknown) => {
        if (requestSequence.current !== sequence) {
          return;
        }
        setState({ lookup: { message: toVisibleError(error), state: 'error' }, providerId });
      });
  };

  const lookup = state?.providerId === providerId ? state.lookup : IDLE_LOOKUP;
  return { lookup, verify };
}
