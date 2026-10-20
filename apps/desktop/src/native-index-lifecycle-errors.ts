import { NativeIndexRefusalError } from '@brainstrike/assistant-service/node-native-text-services';
import { NativeAuthorityTransitionError as TransitionError } from './native-authority-transition';
import { type NativeIndexState, nativeIndexFailureRefusal } from './native-index-lifecycle';

/** The typed refusal of a native index closed for good: shutdown, reset, or profile retirement. */
export function nativeIndexClosedError(
  reason: Extract<NativeIndexState, { readonly kind: 'closed' }>['reason'],
  cause?: unknown
): NativeIndexRefusalError {
  return new NativeIndexRefusalError(
    { kind: 'closed', reason },
    'Native index activation is closed for terminal retirement.',
    { cause }
  );
}

/**
 * Quit's one terminal reason (ADR-0026): the typed refusal of a native index closed for
 * shutdown. Classified by its kind and reason, never by message text.
 */
export function isQuitTerminalRefusal(error: unknown): error is NativeIndexRefusalError {
  return (
    error instanceof NativeIndexRefusalError &&
    error.refusal.kind === 'closed' &&
    error.refusal.reason === 'shutdown'
  );
}

export function nativeIndexStateError(state: NativeIndexState): Error {
  if (state.kind === 'failed' || state.kind === 'unconfigured') {
    const refusal = nativeIndexFailureRefusal(state.cause);
    // A host that stopped responding stays that typed refusal even when its retirement also
    // failed: only Retry indexing recovers it, and the full failure rides as the cause (BST-2104).
    if (refusal.kind === 'embedding-host-unresponsive') {
      return new NativeIndexRefusalError(refusal, refusal.message, { cause: state.cause.error });
    }
    // An independent cleanup failure remains a failure of that exact operation.
    if (
      state.cause.error instanceof AggregateError ||
      state.cause.error instanceof NativeIndexRefusalError
    ) {
      return state.cause.error;
    }
    // A store that refused its file says so in words a person can act on (BST-1878).
    if (refusal.kind === 'rebuild-required') {
      return new NativeIndexRefusalError(refusal, refusal.message, { cause: state.cause.error });
    }
    return new NativeIndexRefusalError(
      { kind: state.cause.kind, message: state.cause.message },
      state.cause.message,
      { cause: state.cause.error }
    );
  }
  if (state.kind === 'closed') {
    return nativeIndexClosedError(state.reason, state.cause);
  }
  return new TransitionError(
    state.kind === 'validating'
      ? 'Native saved configuration is being revalidated.'
      : 'Native index is transitioning.'
  );
}
