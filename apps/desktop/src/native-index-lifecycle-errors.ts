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

export function nativeIndexStateError(state: NativeIndexState): Error {
  if (state.kind === 'failed' || state.kind === 'unconfigured') {
    const refusal = nativeIndexFailureRefusal(state.cause);
    if (state.cause.error instanceof NativeIndexRefusalError) {
      return state.cause.error;
    }
    // A store that refused its file says so in words a person can act on (BST-1878).
    if (refusal.kind === 'rebuild-required') {
      return new NativeIndexRefusalError(refusal, refusal.message, { cause: state.cause.error });
    }
    // Any other failure, a retirement that left sources owned included, is refused by its kind;
    // the failure itself rides as the cause, logged where the refusal crosses to the renderer.
    return new NativeIndexRefusalError(
      { kind: state.cause.kind, message: state.cause.message },
      state.cause.message,
      { cause: state.cause.error }
    );
  }
  if (state.kind === 'closed') {
    return nativeIndexClosedError(state.reason, state.cause);
  }
  if (state.kind === 'transitioning' && state.retrying) {
    // The status reason keeps the failure this re-open retries until the open settles.
    return new TransitionError(
      `Native index is re-opening after a failure: ${nativeIndexFailureRefusal(state.retrying).message}`
    );
  }
  return new TransitionError(
    state.kind === 'validating'
      ? 'Native saved configuration is being revalidated.'
      : 'Native index is transitioning.'
  );
}
